import type {
  BatchInstallBase,
  BatchRateSnapshot,
  FieldReport,
  RecalcConflict,
  RecalcJob,
  RecalcStage,
  SignalCase
} from '../models/signal';
import { round2 } from './recalc-math';
import { batchView as selectBatchView, signalView as selectSignalView } from './recalc-views';

export type { RecalcStage } from '../models/signal';

/**
 * 可恢复重算引擎。
 *
 * 事实层（报告、装机量）与物化层（批号发生率快照、信号聚合数字）分离：
 * - 事实层写入立即生效并持久化；
 * - 物化层只能通过重算任务的 finalize 阶段整体提交，提交前各页面看到的
 *   始终是上一个 effectiveVersion 的完整结果 + 待更新标记；
 * - 每个阶段完成即 checkpoint 持久化，写入失败后从断点阶段重跑，计算是
 *   纯函数，重跑幂等；
 * - 跨存储（信号表）的应用通过 appliedAt 对账，未确认完成的提交会补应用。
 */

export interface RecalcEvent {
  id: string;
  at: string;
  actor: string;
  kind:
    | 'report_accepted'
    | 'report_duplicate'
    | 'report_withdrawn'
    | 'report_missing'
    | 'report_already_withdrawn'
    | 'install_base_corrected'
    | 'conflict_detected'
    | 'conflict_resolved'
    | 'fault_configured'
    | 'job_failed'
    | 'job_resumed'
    | 'job_committed';
  detail: string;
  jobId?: string;
}

export interface RecalcState {
  schemaVersion: 1;
  /** 全局唯一有效重算版本，所有页面只认同版本的快照。 */
  effectiveVersion: number;
  /** 批号 -> 既有台账（种子/登记信号）的报告数基线，补录报告在此之上累加。 */
  baselineReportCount: Record<string, number>;
  installBases: BatchInstallBase[];
  reports: FieldReport[];
  snapshots: BatchRateSnapshot[];
  jobs: RecalcJob[];
  conflicts: RecalcConflict[];
  events: RecalcEvent[];
}

/** 单个批号待提交的重算结果，存放在任务上作为 checkpoint。 */
export interface PendingBatchRate {
  batch: string;
  reportCount: number;
  installedUnits: number;
  rate: number | null;
}

export interface PendingTaskReschedule {
  signalId: string;
  taskId: string;
  title: string;
  from: string;
  to: string;
  reason: string;
}

export interface PendingSignalUpdate {
  signalId: string;
  reportCount: number;
  exposedUnits: number;
  rate: number | null;
  batchRates: Array<{ batch: string; reportCount: number; installedUnits: number; rate: number | null }>;
  changed: boolean;
  previousRate: number | null;
  reschedules: PendingTaskReschedule[];
}

export interface EngineJob extends RecalcJob {
  pendingRates: PendingBatchRate[];
  pendingSignals: PendingSignalUpdate[];
  /** finalize 已持久化提交、但信号表应用尚未确认的对账标记。 */
  appliedAt: string | null;
}

export interface SignalRecalcPlan {
  version: number;
  jobId: string;
  signals: PendingSignalUpdate[];
}

export interface EngineGateway {
  /** 读取当前信号表，供重算判断变化与任务排期。 */
  getSignals(): SignalCase[];
  /** 把一次已提交版本的信号聚合数字与任务期限原子写入信号表。 */
  applyRecalc(plan: SignalRecalcPlan): void;
}

export interface EnginePersistence {
  load(): RecalcState | null;
  save(state: RecalcState): void;
}

export interface EngineClock {
  now(): string;
  today(): string;
  delay(ms: number): Promise<void>;
}

export const RECALC_STAGES: RecalcStage[] = ['mark_stale', 'batch_rates', 'signal_refresh', 'finalize'];
export const RATE_THRESHOLD = 0.75;
export const RATE_CRITICAL = 2;

let idCounter = 0;
function makeId(prefix: string, nowIso: string) {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}${nowIso.slice(17, 23)}`;
}

export class RecalcError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

/** 一条报告在各批号上的拆账：多批号报告按批号等分。 */
function allocations(report: FieldReport): Array<{ batch: string; weight: number }> {
  const n = report.batches.length || 1;
  return report.batches.map((batch) => ({ batch, weight: 1 / n }));
}

export class RecalcEngine {
  private state: RecalcState;
  private running: Promise<void> = Promise.resolve();
  private queuedJobIds: string[] = [];
  private wakeQueue: (() => void) | null = null;

  constructor(
    private persistence: EnginePersistence,
    private gateway: EngineGateway,
    private clock: EngineClock,
    /** 返回 true 时在指定阶段制造一次写入失败（故障注入，用于演练断点续算）。 */
    private shouldFault: (stage: RecalcStage, job: EngineJob) => boolean = () => false
  ) {
    const restored = persistence.load();
    this.state = restored ?? this.emptyState();
  }

  private emptyState(): RecalcState {
    return {
      schemaVersion: 1,
      effectiveVersion: 0,
      baselineReportCount: {},
      installBases: [],
      reports: [],
      snapshots: [],
      jobs: [],
      conflicts: [],
      events: []
    };
  }

  getState(): RecalcState {
    return this.state;
  }

  private now() {
    return this.clock.now();
  }

  private jobs(): EngineJob[] {
    return this.state.jobs as EngineJob[];
  }

  private snapshotOf(batch: string): BatchRateSnapshot | undefined {
    return this.state.snapshots.find((item) => item.batch === batch);
  }

  private installBaseOf(batch: string): BatchInstallBase | undefined {
    return this.state.installBases.find((item) => item.batch === batch);
  }

  private appendEvent(event: Omit<RecalcEvent, 'id' | 'at'> & { at?: string }) {
    this.state.events.unshift({
      id: makeId('EVT', event.at ?? this.now()),
      at: event.at ?? this.now(),
      actor: event.actor,
      kind: event.kind,
      detail: event.detail,
      jobId: event.jobId
    });
  }

  /**
   * 从种子信号建立事实层：种子的报告数与装机量按 affectedBatches 等分，
   * 物化出 version 0 的完整快照（发生率与种子页面数字一致）。
   */
  seed(signals: SignalCase[]): RecalcState {
    if (this.persistence.load()) return this.state;
    const state = this.emptyState();
    for (const signal of signals) {
      const batches = signal.affectedBatches.length ? signal.affectedBatches : [signal.batch];
      for (const batch of batches) {
        state.baselineReportCount[batch] =
          (state.baselineReportCount[batch] ?? 0) + signal.reportCount / batches.length;
        const baseUnits = Math.round(signal.exposedUnits / batches.length);
        const existing = state.installBases.find((item) => item.batch === batch);
        if (existing) {
          existing.installedUnits += baseUnits;
        } else {
          state.installBases.push({
            batch,
            installedUnits: baseUnits,
            revision: 0,
            updatedAt: signal.openedAt,
            updatedBy: '台账基线'
          });
        }
      }
    }
    state.snapshots = state.installBases.map((base) => {
      const reportCount = state.baselineReportCount[base.batch] ?? 0;
      return {
        batch: base.batch,
        reportCount,
        installedUnits: base.installedUnits,
        rate: base.installedUnits > 0 ? round2((reportCount / base.installedUnits) * 100) : null,
        version: 0,
        computedAt: this.now(),
        staleSince: null,
        staleJobId: null
      };
    });
    this.state = state;
    this.persistence.save(state);
    return state;
  }

  /** 新登记的信号：其初始报告数进入基线，并触发受影响批号重算。 */
  registerSignal(signal: SignalCase): string {
    const batches = signal.affectedBatches.length ? signal.affectedBatches : [signal.batch];
    for (const batch of batches) {
      this.state.baselineReportCount[batch] =
        (this.state.baselineReportCount[batch] ?? 0) + signal.reportCount / batches.length;
      if (!this.installBaseOf(batch)) {
        this.state.installBases.push({
          batch,
          installedUnits: 0,
          revision: 0,
          updatedAt: signal.openedAt,
          updatedBy: signal.owner
        });
      }
    }
    this.persistence.save(this.state);
    return this.enqueueJob(batches, `登记新信号 ${signal.id}，纳入台账基线报告`, signal.owner || '安全台账');
  }

  /* ---------------- 报告补录 / 撤回 ---------------- */

  submitReport(input: {
    dedupKey: string;
    batches: string[];
    action: 'supplement' | 'withdraw';
    signalId?: string | null;
    actor: string;
    note: string;
  }):
    | { accepted: true; report: FieldReport; jobId: string }
    | { accepted: false; reason: 'duplicate' | 'already_withdrawn' | 'missing_for_withdraw'; report?: FieldReport } {
    const key = input.dedupKey.trim().toUpperCase();
    const existing = this.state.reports.find((report) => report.dedupKey === key);

    if (input.action === 'supplement') {
      let acceptedReport: FieldReport;
      if (existing && !existing.withdrawnAt) {
        // 同一报告重复补录只算一次：保留原报告，不产生重算，只留审计。
        this.appendEvent({
          actor: input.actor,
          kind: 'report_duplicate',
          detail: `报告号 ${key} 已于 ${existing.createdAt.slice(0, 16).replace('T', ' ')} 补录，重复提交未重复计数（批号：${existing.batches.join('、')}）。`
        });
        this.persistence.save(this.state);
        return { accepted: false, reason: 'duplicate', report: existing };
      }
      const nowIso = this.now();
      if (existing?.withdrawnAt) {
        // 撤回后重新补录同一报告号：作为修订递增版本，恢复计数。
        existing.revision += 1;
        existing.withdrawnAt = undefined;
        existing.batches = Array.from(new Set(input.batches));
        existing.actor = input.actor;
        existing.note = input.note;
        existing.createdAt = nowIso;
        acceptedReport = existing;
        this.appendEvent({
          actor: input.actor,
          kind: 'report_accepted',
          detail: `报告号 ${key} 撤回后重新补录（修订 V${existing.revision}），按批号 ${existing.batches.join('、')} 重新计入。`
        });
      } else {
        acceptedReport = {
          id: makeId('RPT', nowIso),
          dedupKey: key,
          action: 'supplement',
          batches: Array.from(new Set(input.batches)),
          signalId: input.signalId ?? null,
          actor: input.actor,
          note: input.note,
          createdAt: nowIso,
          revision: 1
        };
        this.state.reports.unshift(acceptedReport);
        this.appendEvent({
          actor: input.actor,
          kind: 'report_accepted',
          detail: `补录现场报告 ${key}，覆盖批号 ${acceptedReport.batches.join('、')}，已按批号拆账计入。`
        });
      }
      for (const batch of input.batches) {
        if (!this.installBaseOf(batch)) {
          this.state.installBases.push({
            batch,
            installedUnits: 0,
            revision: 0,
            updatedAt: nowIso,
            updatedBy: input.actor
          });
        }
      }
      // enqueueJob 的 checkpoint 与失效标记同次落盘，无需提前保存。
      const jobId = this.enqueueJob(input.batches, `补录现场报告 ${key}`, input.actor);
      return { accepted: true, report: acceptedReport, jobId };
    }

    // withdraw
    if (!existing) {
      this.appendEvent({
        actor: input.actor,
        kind: 'report_missing',
        detail: `撤回失败：报告号 ${key} 未在台账中找到，未发生任何数字变化。`
      });
      this.persistence.save(this.state);
      return { accepted: false, reason: 'missing_for_withdraw' };
    }
    if (existing.withdrawnAt) {
      this.appendEvent({
        actor: input.actor,
        kind: 'report_already_withdrawn',
        detail: `报告号 ${key} 已撤回（${existing.withdrawnAt.slice(0, 10)}），重复撤回未生效。`
      });
      this.persistence.save(this.state);
      return { accepted: false, reason: 'already_withdrawn', report: existing };
    }
    existing.withdrawnAt = this.now();
    this.appendEvent({
      actor: input.actor,
      kind: 'report_withdrawn',
      detail: `撤回现场报告 ${key}，批号 ${existing.batches.join('、')} 的计数将在重算提交后移除。说明：${input.note}`
    });
    this.persistence.save(this.state);
    const jobId = this.enqueueJob(existing.batches, `撤回现场报告 ${key}`, input.actor);
    return { accepted: true, report: existing, jobId };
  }

  /* ---------------- 批号装机量修正（乐观并发） ---------------- */

  correctInstallBase(input: {
    batch: string;
    installedUnits: number;
    expectedRevision: number;
    actor: string;
  }):
    | { accepted: true; revision: number; jobId: string }
    | { accepted: false; conflict: RecalcConflict } {
    const batch = input.batch.trim();
    let base = this.installBaseOf(batch);
    if (!base) {
      base = {
        batch,
        installedUnits: 0,
        revision: 0,
        updatedAt: this.now(),
        updatedBy: input.actor
      };
      this.state.installBases.push(base);
    }

    if (input.expectedRevision !== base.revision) {
      // 后到者：输入保留在冲突记录里，装机量不变，不触发重算。
      const conflict: RecalcConflict = {
        id: makeId('CFL', this.now()),
        batch,
        actor: input.actor,
        expectedRevision: input.expectedRevision,
        actualRevision: base.revision,
        proposedUnits: input.installedUnits,
        installedUnits: base.installedUnits,
        jobId: null,
        message: `批号 ${batch} 已被他人更新至版本 V${base.revision}（装机量 ${base.installedUnits} 台），你输入的 ${input.installedUnits} 台未写入，已保留待确认。`,
        createdAt: this.now(),
        resolved: false
      };
      this.state.conflicts.unshift(conflict);
      this.appendEvent({
        actor: input.actor,
        kind: 'conflict_detected',
        detail: conflict.message
      });
      this.persistence.save(this.state);
      return { accepted: false, conflict };
    }

    const previous = base.installedUnits;
    base.installedUnits = input.installedUnits;
    base.revision += 1;
    base.updatedAt = this.now();
    base.updatedBy = input.actor;
    this.appendEvent({
      actor: input.actor,
      kind: 'install_base_corrected',
      detail: `批号 ${batch} 装机量修正：${previous} -> ${input.installedUnits} 台（版本 V${base.revision}）。`
    });
    this.persistence.save(this.state);
    const jobId = this.enqueueJob([batch], `修正批号 ${batch} 装机量为 ${input.installedUnits} 台`, input.actor);
    return { accepted: true, revision: base.revision, jobId };
  }

  /** 冲突处理：后到者确认覆盖（带最新版本重新提交）或放弃。 */
  resolveConflict(
    conflictId: string,
    decision: 'overwrite' | 'discard',
    actor: string
  ): { accepted: true; revision?: number; jobId?: string } | { accepted: false; message: string } {
    const conflict = this.state.conflicts.find((item) => item.id === conflictId);
    if (!conflict) return { accepted: false, message: '冲突记录不存在' };
    if (conflict.resolved) return { accepted: false, message: '该冲突已处理' };
    conflict.resolved = true;

    if (decision === 'discard') {
      this.appendEvent({
        actor,
        kind: 'conflict_resolved',
        detail: `批号 ${conflict.batch} 的冲突修正已放弃（保留 ${conflict.installedUnits} 台）。`
      });
      this.persistence.save(this.state);
      return { accepted: true };
    }

    const base = this.installBaseOf(conflict.batch);
    if (!base) return { accepted: false, message: '批号装机量记录已不存在' };
    const previous = base.installedUnits;
    base.installedUnits = conflict.proposedUnits;
    base.revision += 1;
    base.updatedAt = this.now();
    base.updatedBy = actor;
    this.appendEvent({
      actor,
      kind: 'conflict_resolved',
      detail: `批号 ${conflict.batch} 冲突已按后到者输入覆盖：${previous} -> ${base.installedUnits} 台（版本 V${base.revision}）。`
    });
    this.persistence.save(this.state);
    const jobId = this.enqueueJob(
      [conflict.batch],
      `冲突解决后修正批号 ${conflict.batch} 装机量`,
      actor
    );
    return { accepted: true, revision: base.revision, jobId };
  }

  /* ---------------- 读模型：各页面只认 effectiveVersion ---------------- */

  private batchFact(batch: string): PendingBatchRate {
    const activeReports = this.state.reports.filter((report) => !report.withdrawnAt);
    let reportCount = this.state.baselineReportCount[batch] ?? 0;
    for (const report of activeReports) {
      for (const allocation of allocations(report)) {
        if (allocation.batch === batch) reportCount += allocation.weight;
      }
    }
    const base = this.installBaseOf(batch);
    const installedUnits = base?.installedUnits ?? 0;
    return {
      batch,
      reportCount: round2(reportCount),
      installedUnits,
      rate: installedUnits > 0 ? round2((reportCount / installedUnits) * 100) : null
    };
  }

  /** 批号视图：数字来自快照，版本落后或处于 stale 即待更新。 */
  batchView(batch: string) {
    return selectBatchView(this.state, batch);
  }

  /** 信号聚合视图：受影响批号中任一待更新，整条信号显示待更新并沿用旧数字。 */
  signalView(signal: SignalCase) {
    return selectSignalView(this.state, signal);
  }

  /* ---------------- 任务流水线 ---------------- */

  private enqueueJob(affectedBatches: string[], reason: string, actor: string): string {
    const nowIso = this.now();
    const newBatches = Array.from(new Set(affectedBatches));

    // 批号已被一个尚未提交的任务覆盖：并入该任务，一次重算覆盖全部变更，
    // 避免两个排队任务在同一批号上产生版本漂移与 stale 标记丢失。
    const inflight = this.jobs().find(
      (job) => job.status !== 'committed' && newBatches.some((batch) => job.affectedBatches.includes(batch))
    );
    if (inflight) {
      const merged = newBatches.filter((batch) => !inflight.affectedBatches.includes(batch));
      inflight.affectedBatches = Array.from(new Set([...inflight.affectedBatches, ...newBatches]));
      inflight.reason = `${inflight.reason}；${reason}`;
      inflight.updatedAt = nowIso;
      // 已完成的批号/信号阶段需要把新批号补进去：回退到 batch_rates 让其重算。
      if (merged.length) {
        inflight.completedStages = inflight.completedStages.filter(
          (stage) => stage !== 'batch_rates' && stage !== 'signal_refresh' && stage !== 'finalize'
        );
        inflight.pendingSignals = [];
        this.markStaleBatches(merged, inflight.id, nowIso);
      }
      this.persistence.save(this.state);
      return inflight.id;
    }

    const job: EngineJob = {
      id: makeId('JOB', nowIso),
      status: 'running',
      affectedBatches: newBatches,
      completedStages: [],
      doneBatches: [],
      targetVersion: 0, // finalize 时取 effectiveVersion + 1
      committedVersion: null,
      reason,
      actor,
      createdAt: nowIso,
      updatedAt: nowIso,
      failure: null,
      pendingRates: [],
      pendingSignals: [],
      appliedAt: null
    };
    this.state.jobs.unshift(job);
    // 报告一变化：受影响批号的旧发生率立刻失效并随任务入队持久化，
    // 页面在重算开始前就能显示待更新标记。
    this.markStaleBatches(job.affectedBatches, job.id, nowIso);
    this.persistence.save(this.state);
    this.queuedJobIds.push(job.id);
    this.kick();
    return job.id;
  }

  private markStaleBatches(batches: string[], jobId: string, at: string) {
    for (const batch of batches) {
      const snapshot = this.snapshotOf(batch);
      if (snapshot && snapshot.staleSince === null) {
        snapshot.staleSince = at;
        snapshot.staleJobId = jobId;
      }
    }
  }

  private kick() {
    this.running = this.running.then(() => this.drain()).catch(() => undefined);
  }

  /** 启动恢复：未提交（running/failed）的任务从断点续跑；已提交未应用的补应用。 */
  recover() {
    for (const job of [...this.jobs()].reverse()) {
      if (job.status !== 'committed' && !this.queuedJobIds.includes(job.id)) {
        this.queuedJobIds.push(job.id);
      }
    }
    // 已提交但信号表未确认应用的任务直接补应用。
    for (const job of this.jobs()) {
      if (job.status === 'committed' && !job.appliedAt) {
        this.applyToSignals(job);
        job.appliedAt = this.now();
        this.persistence.save(this.state);
      }
    }
    if (this.queuedJobIds.length) this.kick();
  }

  private async drain() {
    while (this.queuedJobIds.length) {
      const jobId = this.queuedJobIds[0];
      const job = this.jobs().find((item) => item.id === jobId);
      if (!job) {
        this.queuedJobIds.shift();
        continue;
      }
      try {
        await this.runJob(job);
        this.queuedJobIds.shift();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stage = RECALC_STAGES.find((name) => !job.completedStages.includes(name)) ?? 'finalize';
        job.status = 'failed';
        job.failure = { at: stage, message, atTime: this.now() };
        job.updatedAt = this.now();
        this.appendEvent({
          actor: job.actor,
          kind: 'job_failed',
          jobId: job.id,
          detail: `重算在「${stageLabel(stage)}」阶段写入失败：${message}。数字仍停留在 V${this.state.effectiveVersion}，可从断点继续。`
        });
        this.persistence.save(this.state);
        this.queuedJobIds.shift();
      }
    }
  }

  /** 失败任务手动续跑（页面按钮）。 */
  retry(jobId?: string) {
    const target = jobId
      ? this.jobs().find((job) => job.id === jobId && job.status === 'failed')
      : this.jobs().find((job) => job.status === 'failed');
    if (target && !this.queuedJobIds.includes(target.id)) {
      this.appendEvent({
        actor: target.actor,
        kind: 'job_resumed',
        jobId: target.id,
        detail: `从断点「${stageLabel(target.failure?.at ?? 'mark_stale')}」继续重算 ${target.id}。`
      });
      this.persistence.save(this.state);
      this.queuedJobIds.push(target.id);
      this.kick();
      return true;
    }
    return false;
  }

  /** 记录不产生任务的运维动作（如故障演练武装）。 */
  recordEvent(actor: string, kind: RecalcEvent['kind'], detail: string) {
    this.appendEvent({ actor, kind, detail });
    this.persistence.save(this.state);
  }

  private async runJob(job: EngineJob) {
    for (const stage of RECALC_STAGES) {
      // 运行中的任务可能被新的同批号变更合并（affectedBatches 扩大、阶段回退），
      // 每轮都按 id 重新取实例并检查最新 checkpoint。
      const current = this.jobs().find((item) => item.id === job.id);
      if (!current || current.status === 'committed') return;
      if (current.completedStages.includes(stage)) continue;
      await this.clock.delay(stage === 'batch_rates' ? 120 + current.affectedBatches.length * 90 : 180);
      await this.runStage(current, stage);
      current.updatedAt = this.now();
      // 模拟 checkpoint 写入失败：阶段结果只在内存，completedStages 不含本阶段，
      // 恢复时整体重跑该阶段（纯计算，幂等）。
      if (this.shouldFault(stage, current)) {
        throw new RecalcError(stage, `模拟写入失败（阶段 ${stageLabel(stage)}）`);
      }
      current.completedStages.push(stage);
      this.persistence.save(this.state);
    }
  }

  private runStage(job: EngineJob, stage: RecalcStage) {
    switch (stage) {
      case 'mark_stale':
        this.stageMarkStale(job);
        break;
      case 'batch_rates':
        this.stageBatchRates(job);
        break;
      case 'signal_refresh':
        this.stageSignalRefresh(job);
        break;
      case 'finalize':
        this.stageFinalize(job);
        break;
    }
  }

  /** 阶段 1：幂等复核失效标记（入队时已先行持久化，崩溃重跑也不会丢）。 */
  private stageMarkStale(job: EngineJob) {
    this.markStaleBatches(job.affectedBatches, job.id, this.now());
  }

  /** 阶段 2：逐批号重算并保存子断点；结果暂存于任务，页面尚不可见。 */
  private stageBatchRates(job: EngineJob) {
    for (const batch of job.affectedBatches) {
      if (job.doneBatches.includes(batch)) continue;
      const fact = this.batchFact(batch);
      const existingIndex = job.pendingRates.findIndex((item) => item.batch === batch);
      if (existingIndex >= 0) job.pendingRates[existingIndex] = fact;
      else job.pendingRates.push(fact);
      job.doneBatches.push(batch);
    }
  }

  /** 阶段 3：聚合成信号数字并按新发生率重排任务期限（同样暂存）。 */
  private stageSignalRefresh(job: EngineJob) {
    const today = this.clock.today();
    const signals = this.gateway.getSignals();
    const affectedSet = new Set(job.affectedBatches);
    const pendingByBatch = new Map(job.pendingRates.map((item) => [item.batch, item]));

    job.pendingSignals = [];
    for (const signal of signals) {
      const batches = signal.affectedBatches.length ? signal.affectedBatches : [signal.batch];
      if (!batches.some((batch) => affectedSet.has(batch))) continue;

      const parts = batches.map((batch) => {
        const pending = pendingByBatch.get(batch);
        if (pending) return { ...pending };
        const snapshot = this.snapshotOf(batch);
        return {
          batch,
          reportCount: snapshot?.reportCount ?? 0,
          installedUnits: snapshot?.installedUnits ?? 0,
          rate: snapshot?.rate ?? null
        };
      });
      const reportCount = round2(parts.reduce((sum, part) => sum + part.reportCount, 0));
      const exposedUnits = parts.reduce((sum, part) => sum + part.installedUnits, 0);
      const rate = exposedUnits > 0 ? round2((reportCount / exposedUnits) * 100) : null;
      const previousRate = signal.occurrenceRate || null;

      const reschedules: PendingTaskReschedule[] = [];
      const critical = rate !== null && rate >= RATE_CRITICAL;
      const slaDays = rate === null ? null : critical ? 2 : rate >= RATE_THRESHOLD ? 5 : null;
      if (slaDays !== null && rate !== null) {
        const deadline = addBusinessDays(today, slaDays);
        for (const task of signal.tasks) {
          if (task.status === 'done') continue;
          if (task.reschedule?.byJobId === job.id) continue;
          if (deadline < task.dueAt) {
            reschedules.push({
              signalId: signal.id,
              taskId: task.id,
              title: task.title,
              from: task.dueAt,
              to: deadline,
              reason: critical
                ? `重算发生率 ${rate.toFixed(2)}% 达到 ${RATE_CRITICAL}% 临界线，调查期限收紧至 ${slaDays} 个工作日`
                : `重算发生率 ${rate.toFixed(2)}% 超过 ${RATE_THRESHOLD}% 阈值，调查期限收紧至 ${slaDays} 个工作日`
            });
          }
        }
      }

      job.pendingSignals.push({
        signalId: signal.id,
        reportCount,
        exposedUnits,
        rate,
        batchRates: parts,
        changed: round2(previousRate ?? -1) !== round2(rate ?? -1) || reportCount !== signal.reportCount,
        previousRate,
        reschedules
      });
    }
  }

  /** 阶段 4：整体提交——快照升版本、effectiveVersion 推进，一次写入，不留半套数字。 */
  private stageFinalize(job: EngineJob) {
    // 提交已落盘、仅应用未确认时从崩溃中恢复：不重复升版本，只补应用与审计。
    if (job.status === 'committed' && job.committedVersion === this.state.effectiveVersion) {
      if (!job.appliedAt) {
        this.applyToSignals(job);
        job.appliedAt = this.now();
      }
      if (!this.state.events.some((event) => event.kind === 'job_committed' && event.jobId === job.id)) {
        this.appendEvent({
          actor: job.actor,
          kind: 'job_committed',
          jobId: job.id,
          detail: `重算 ${job.id} 已提交 V${job.committedVersion}（恢复后补登记审计）。`
        });
      }
      return;
    }

    const nowIso = this.now();
    for (const pending of job.pendingRates) {
      const snapshot = this.snapshotOf(pending.batch);
      const next: BatchRateSnapshot = {
        batch: pending.batch,
        reportCount: pending.reportCount,
        installedUnits: pending.installedUnits,
        rate: pending.rate,
        version: this.state.effectiveVersion + 1,
        computedAt: nowIso,
        staleSince: null,
        staleJobId: null
      };
      if (snapshot) {
        const index = this.state.snapshots.indexOf(snapshot);
        this.state.snapshots[index] = next;
      } else {
        this.state.snapshots.push(next);
      }
    }
    this.state.effectiveVersion += 1;
    job.targetVersion = this.state.effectiveVersion;
    job.committedVersion = this.state.effectiveVersion;
    job.status = 'committed';
    job.failure = null;

    // 先持久化版本提交，再把结果应用到信号表；失败恢复时按 appliedAt 补应用。
    this.persistence.save(this.state);
    this.applyToSignals(job);
    job.appliedAt = this.now();

    const changedSignals = job.pendingSignals.filter((signal) => signal.changed);
    this.appendEvent({
      actor: job.actor,
      kind: 'job_committed',
      jobId: job.id,
      at: nowIso,
      detail:
        `重算 ${job.id} 已提交 V${job.committedVersion}：批号 ${job.affectedBatches.join('、')} 发生率刷新` +
        (changedSignals.length
          ? `；信号 ${changedSignals
              .map((signal) => `${signal.signalId}（${signal.previousRate === null ? '不可算' : signal.previousRate.toFixed(2) + '%'} -> ${signal.rate === null ? '不可算' : signal.rate.toFixed(2) + '%'}）`)
              .join('、')}`
          : '') +
        '。'
    });
  }

  private applyToSignals(job: EngineJob) {
    this.gateway.applyRecalc({ version: job.committedVersion ?? job.targetVersion, jobId: job.id, signals: job.pendingSignals });
  }
}

export function stageLabel(stage: RecalcStage): string {
  const labels: Record<RecalcStage, string> = {
    mark_stale: '标记失效',
    batch_rates: '批号发生率',
    signal_refresh: '信号与任务期限',
    finalize: '版本提交'
  };
  return labels[stage];
}

/** 简单的工作日加法（跳过周六周日）。 */
export function addBusinessDays(from: string, days: number): string {
  const date = new Date(`${from}T00:00:00Z`);
  let added = 0;
  while (added < days) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return date.toISOString().slice(0, 10);
}
