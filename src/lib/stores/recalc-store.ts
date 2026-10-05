import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';
import type {
  BackfillInput,
  InstallConflict,
  InstallCorrectionInput,
  JobKind,
  RecalcJob,
  RecalcState,
  SubmitOutcome,
  WithdrawInput
} from '$lib/models/recalc';
import { buildSeedRecalcState, BASELINE_VERSION } from '$lib/services/recalc-seed';
import { buildCommitPlan } from '$lib/services/recalc';
import { signalStore } from './signal-store';

/* ============================================================================
 * 重算编排 store。
 *
 * 一次重算 = 一个 RecalcJob，按阶段推进并在每个阶段后落 checkpoint：
 *
 *   0 输入落库（报告/撤回/装机量）——受影响批号立即进入 staleBatches
 *   1 分批复算（按批号发生率）
 *   2 受影响信号聚合（其余批号保持上次完整结果）
 *   3 风险联动与任务期限重排 + 审计计划
 *   4 生成唯一提交计划并自增版本
 *   5 两阶段原子提交：先持久化 pendingCommit，再 applyPendingCommit 到信号
 *   6 提交销账：新批号结果/台账/审计生效，清除待更新标记
 *
 * 任一阶段写入失败，作业停在 failed + checkpoint，页面仍显示「待更新」
 * 与旧数字；resumeJob 从 checkpoint+1 继续，绝不留下半套数字。
 * ========================================================================== */

const STORAGE_KEY = 'medical-safety-recalc-v1';

const STAGE_LABELS = [
  '输入落库',
  '分批复算',
  '信号聚合',
  '风险与期限联动',
  '生成提交计划',
  '两阶段提交',
  '提交销账'
] as const;

function readState(): RecalcState {
  if (!browser) return buildSeedRecalcState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return buildSeedRecalcState();
    const parsed = JSON.parse(raw) as RecalcState;
    // 简单结构兼容校验，损坏则回退基线。
    if (!parsed.reports || !parsed.installs || !parsed.batchResults) return buildSeedRecalcState();
    return parsed;
  } catch {
    return buildSeedRecalcState();
  }
}

function now() {
  return new Date().toISOString();
}

let idCounter = 0;
function makeId(prefix: string) {
  idCounter += 1;
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${idCounter}`}`;
}

const internal = writable<RecalcState>(readState());

if (browser) {
  internal.subscribe((state) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });
}

/** 测试钩子：让「两阶段提交」阶段的写入失败一次，验证断点继续。 */
let failNextCommitOnce = false;
export function armCommitFailure() {
  failNextCommitOnce = true;
}

export function stageLabel(stage: number): string {
  return STAGE_LABELS[stage] ?? `阶段 ${stage}`;
}

/* ---------------- 阶段 5 的两阶段提交（崩溃恢复的关键） ---------------- */

function persistState(mutate: (draft: RecalcState) => void): RecalcState {
  let next: RecalcState = get(internal);
  internal.update((state) => {
    next = structuredClone(state);
    mutate(next);
    return next;
  });
  return next;
}

/** 应用（或重放）待完成提交。返回 true 表示本次真正执行了阶段 2。 */
function applyPendingCommitToSignals(state: RecalcState): boolean {
  const plan = state.pendingCommit;
  if (!plan) return false;
  const applied = signalStore.applyPendingCommit(plan);
  return applied >= 0; // applyPendingCommit 自身幂等，重放也安全
}

/* ---------------- 单 worker 串行执行 ---------------- */

let pumping = false;

async function delay(ms = 90) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextRunnableJob(state: RecalcState): RecalcJob | undefined {
  return state.jobs.find((job) => job.status === 'queued' || job.status === 'running');
}

async function pump() {
  if (!browser || pumping) return;
  pumping = true;
  try {
    while (true) {
      const state = get(internal);
      const job = nextRunnableJob(state);
      if (!job) break;
      await runJob(job.id);
    }
  } finally {
    pumping = false;
  }
}

/* ---------------- 单作业阶段推进 ---------------- */

class StageFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageFailure';
  }
}

function failJob(jobId: string, message: string) {
  persistState((draft) => {
    const job = draft.jobs.find((item) => item.id === jobId);
    if (job && (job.status === 'queued' || job.status === 'running')) {
      job.status = 'failed';
      job.note = message;
    }
  });
}

function setRunning(jobId: string) {
  persistState((draft) => {
    const job = draft.jobs.find((item) => item.id === jobId);
    if (job && job.status === 'queued') job.status = 'running';
  });
}

async function runJob(jobId: string) {
  setRunning(jobId);

  const initial = get(internal).jobs.find((item) => item.id === jobId);
  if (!initial) return;
  let startStage = initial.checkpoint;

  for (let stage = startStage; stage < STAGE_LABELS.length; stage += 1) {
    await delay();
    try {
      executeStage(jobId, stage);
    } catch (error) {
      failJob(jobId, error instanceof Error ? error.message : String(error));
      return;
    }
    startStage = stage;
  }
}

/** 每个阶段都是「读状态 -> 计算 -> 一次性落库 -> checkpoint 前移」。 */
function executeStage(jobId: string, stage: number) {
  const state = get(internal);
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job || (job.status !== 'running' && job.status !== 'queued')) return;

  switch (stage) {
    case 0:
      stageApplyInput(job);
      break;
    case 1:
    case 2:
    case 3:
    case 4:
      stagePrepareCommit(job, stage);
      break;
    case 5:
      stageCommit(job);
      break;
    case 6:
      stageFinalize(job);
      break;
  }

  persistState((draft) => {
    const target = draft.jobs.find((item) => item.id === jobId);
    if (target && target.status !== 'failed') target.checkpoint = stage + 1;
  });
}

/* ---- 阶段 0：输入落库（冲突在入队前判定，这里只做确定性写入） ---- */

function stageApplyInput(job: RecalcJob) {
  persistState((draft) => {
    const target = draft.jobs.find((item) => item.id === job.id);
    if (!target) return;

    if (job.kind === 'backfill') {
      const input = job.input as BackfillInput;
      const timestamp = now();
      for (const batch of input.batches) {
        const existing = draft.reports.find(
          (report) => report.reportRef === input.reportRef && report.batch === batch
        );
        if (existing) {
          existing.withdrawn = false;
          existing.jobId = job.id;
        } else {
          draft.reports.push({
            reportRef: input.reportRef,
            batch,
            signalId: input.signalId,
            source: input.source,
            occurredAt: input.occurredAt,
            receivedAt: timestamp,
            actor: input.actor,
            withdrawn: false,
            jobId: job.id
          });
        }
      }
    } else if (job.kind === 'withdraw') {
      const input = job.input as WithdrawInput;
      const [reportRef, batch] = splitBatchKey(input.batchKey);
      const report = draft.reports.find((item) => item.reportRef === reportRef && item.batch === batch);
      if (report) {
        report.withdrawn = true;
        report.jobId = job.id;
      }
    } else if (job.kind === 'install_correction') {
      const input = job.input as InstallCorrectionInput;
      const timestamp = now();
      const existing = draft.installs[input.batch];
      draft.installs[input.batch] = {
        batch: input.batch,
        units: input.units,
        revision: (existing?.revision ?? 0) + 1,
        updatedAt: timestamp,
        updatedBy: input.actor,
        jobId: job.id
      };
    }

    // 受影响批号立即进入待更新——页面此刻起只显示旧结果 + 待更新标记。
    for (const batch of job.affectedBatches) {
      if (!draft.staleBatches.includes(batch)) draft.staleBatches.push(batch);
    }
  });
}

function splitBatchKey(batchKey: string): [string, string] {
  const index = batchKey.indexOf('::');
  return [batchKey.slice(0, index), batchKey.slice(index + 2)];
}

/* ---- 阶段 1-4：在草稿上准备提交计划（幂等，失败重放结果一致） ---- */

function stagePrepareCommit(job: RecalcJob, stage: number) {
  // 计划在阶段 4 生成并写入 pendingCommit；1-3 的复算/聚合/联动语义都包含在
  // buildCommitPlan 中，按 checkpoint 分别等待，便于演示与恢复定位。
  if (stage !== 4) return;

  const draft = structuredClone(get(internal));
  const version = draft.currentVersion + 1;
  const committedAt = now();
  const plan = buildCommitPlan(
    draft,
    draft.staleBatches,
    signalStore.getSnapshot(),
    { ...job, checkpoint: 4 },
    { version, committedAt, makeId }
  );

  persistState((state) => {
    state.pendingCommit = plan;
  });
}

/* ---- 阶段 5：两阶段原子提交 ---- */

function stageCommit(job: RecalcJob) {
  const state = get(internal);
  if (!state.pendingCommit) {
    throw new StageFailure('缺少提交计划，无法提交');
  }

  // 失败注入只对本次作业的第一次尝试生效；恢复（attempts>0）不再触发。
  if (failNextCommitOnce && job.attempts === 0) {
    failNextCommitOnce = false;
    throw new StageFailure('模拟写入失败：提交计划已持久化，可从断点继续，信号侧尚未产生半套数字。');
  }

  // 阶段 2：把同一份计划应用到信号。applyPendingCommit 按 jobId::version 幂等。
  applyPendingCommitToSignals(state);
}

/* ---- 阶段 6：销账——新结果/台账生效，版本推进，清除待更新 ---- */

function stageFinalize(job: RecalcJob) {
  persistState((draft) => {
    const plan = draft.pendingCommit;
    if (!plan) throw new StageFailure('缺少提交计划，无法销账');

    for (const result of plan.batchResults) {
      draft.batchResults[result.batch] = result;
    }
    for (const entry of plan.ledger) {
      draft.ledger.unshift(entry);
    }
    draft.currentVersion = plan.version;
    draft.staleBatches = draft.staleBatches.filter((batch) => !plan.staleBatches.includes(batch));
    draft.pendingCommit = null;

    const target = draft.jobs.find((item) => item.id === job.id);
    if (target) {
      target.status = 'committed';
      target.committedAt = plan.committedAt;
      target.version = plan.version;
      target.note = undefined;
    }
  });
}

/* ---------------- 入队 ---------------- */

/**
 * 存在未完成提交时不允许再排队新作业：否则新作业的阶段 4 会覆盖尚未销账的
 * pendingCommit。必须先把失败作业「从断点继续」走完，数字才能再次前进。
 */
function unfinishedCommitBlock(state: RecalcState): string | null {
  if (state.pendingCommit) {
    return `存在尚未销账的提交 RV${state.pendingCommit.version}，请先从断点继续完成该重算。`;
  }
  const failed = state.jobs.find((job) => job.status === 'failed');
  if (failed) {
    return `作业 ${failed.id} 在「${stageLabel(failed.checkpoint < STAGE_LABELS.length ? failed.checkpoint : 0)}」阶段中断，请先从断点继续。`;
  }
  if (state.jobs.some((job) => job.status === 'queued' || job.status === 'running')) {
    return '上一次重算仍在进行，请等待其完成。';
  }
  return null;
}

function createJob(kind: JobKind, input: RecalcJob['input'], affectedBatches: string[]): RecalcJob {
  return {
    id: makeId('JOB'),
    kind,
    status: 'queued',
    input,
    createdAt: now(),
    checkpoint: 0,
    affectedBatches,
    attempts: 0
  };
}

async function enqueueAndWait(job: RecalcJob): Promise<RecalcJob> {
  persistState((draft) => {
    draft.jobs.unshift(job);
  });
  await pump();
  const finished = get(internal).jobs.find((item) => item.id === job.id);
  return finished ?? job;
}

/* ---------------- 公共操作：补录 ---------------- */

export async function submitBackfill(input: BackfillInput): Promise<SubmitOutcome> {
  const state = get(internal);
  const blocked = unfinishedCommitBlock(state);
  if (blocked) return { type: 'blocked', reason: blocked };

  // 同一报告重复补录只算一次：所有批号都已存在且未撤回 -> duplicate，不重算。
  const existingKeys = new Set(state.reports.map((report) => `${report.reportRef}::${report.batch}`));
  const requestedKeys = input.batches.map((batch) => `${input.reportRef}::${batch}`);
  const allKnown = requestedKeys.every((key) => {
    const report = state.reports.find((item) => `${item.reportRef}::${item.batch}` === key);
    return report && !report.withdrawn;
  });

  if (allKnown) {
    const duplicate = createJob('backfill', input, []);
    duplicate.status = 'duplicate';
    duplicate.checkpoint = STAGE_LABELS.length;
    duplicate.note = `报告 ${input.reportRef} 的批号 ${input.batches.join('、')} 此前已补录，重复提交只登记不重算。`;
    persistState((draft) => {
      draft.jobs.unshift(duplicate);
      draft.ledger.unshift({
        id: makeId('LED'),
        version: draft.currentVersion,
        jobId: duplicate.id,
        kind: 'backfill',
        actor: input.actor,
        action: '重复补录拦截',
        detail: `报告 ${input.reportRef}（批号 ${input.batches.join('、')}）重复补录，按同一报告只算一次处理，未触发重算。`,
        createdAt: now()
      });
    });
    return { type: 'duplicate', job: duplicate, reportRef: input.reportRef, batches: input.batches };
  }

  // 同一份报告已存在的批号去重，新批号照常拆分补录（一份报告覆盖多个批号）。
  const freshBatches = input.batches.filter((batch) => {
    const key = `${input.reportRef}::${batch}`;
    return !existingKeys.has(key);
  });
  const job = createJob(
    'backfill',
    { ...input, batches: freshBatches.length > 0 ? freshBatches : input.batches },
    freshBatches.length > 0 ? freshBatches : input.batches
  );
  const finished = await enqueueAndWait(job);
  return finished.status === 'committed'
    ? { type: 'committed', job: finished, version: finished.version ?? 0 }
    : { type: 'failed', job: finished, error: finished.note ?? '重算未完成' };
}

/* ---------------- 公共操作：撤回 ---------------- */

export async function submitWithdraw(input: WithdrawInput): Promise<SubmitOutcome> {
  const state = get(internal);
  const blocked = unfinishedCommitBlock(state);
  if (blocked) return { type: 'blocked', reason: blocked };

  const [reportRef, batch] = splitBatchKey(input.batchKey);
  const report = state.reports.find((item) => item.reportRef === reportRef && item.batch === batch);
  if (!report) {
    const job = { ...createJob('withdraw', input, []), status: 'failed' as const };
    job.note = `未找到报告 ${input.batchKey}，无法撤回。`;
    persistState((draft) => draft.jobs.unshift(job));
    return { type: 'failed', job, error: job.note };
  }
  if (report.withdrawn) {
    const job = { ...createJob('withdraw', input, []), status: 'duplicate' as const };
    job.checkpoint = STAGE_LABELS.length;
    job.note = `报告 ${input.batchKey} 已处于撤回状态。`;
    persistState((draft) => draft.jobs.unshift(job));
    return { type: 'duplicate', job, reportRef, batches: [batch] };
  }

  const job = createJob('withdraw', input, [batch]);
  const finished = await enqueueAndWait(job);
  return finished.status === 'committed'
    ? { type: 'committed', job: finished, version: finished.version ?? 0 }
    : { type: 'failed', job: finished, error: finished.note ?? '重算未完成' };
}

/* ---------------- 公共操作：装机量修正（乐观并发） ---------------- */

export async function submitInstallCorrection(input: InstallCorrectionInput): Promise<SubmitOutcome> {
  const state = get(internal);
  const blocked = unfinishedCommitBlock(state);
  if (blocked) return { type: 'blocked', reason: blocked };

  const current = state.installs[input.batch];
  const currentRevision = current?.revision ?? 0;

  // 两个同事同时修正：后到者基线 revision 落后 -> 冲突，保留输入但不生效。
  if (current && input.expectedRevision !== currentRevision) {
    const conflict: InstallConflict = {
      id: makeId('CFL'),
      batch: input.batch,
      jobId: '',
      actor: input.actor,
      proposedUnits: input.units,
      expectedRevision: input.expectedRevision,
      currentUnits: current.units,
      currentRevision,
      createdAt: now(),
      resolved: false
    };
    const job = createJob('install_correction', input, [input.batch]);
    job.status = 'conflicted';
    job.note = `并发冲突：${input.actor} 基于 revision ${input.expectedRevision} 提交 ${input.units} 台，但该批号已被修正为 ${current.units} 台（revision ${currentRevision}）。输入已保留。`;
    conflict.jobId = job.id;

    persistState((draft) => {
      draft.jobs.unshift(job);
      draft.conflicts.unshift(conflict);
    });
    return { type: 'conflict', job, conflict };
  }

  const job = createJob('install_correction', input, [input.batch]);
  const finished = await enqueueAndWait(job);
  return finished.status === 'committed'
    ? { type: 'committed', job: finished, version: finished.version ?? 0 }
    : { type: 'failed', job: finished, error: finished.note ?? '重算未完成' };
}

/** 冲突裁决：后到者确认在最新基线上重新提交（保留自己的输入值）。 */
export async function resolveConflict(conflictId: string): Promise<SubmitOutcome | null> {
  const conflict = get(internal).conflicts.find((item) => item.id === conflictId);
  if (!conflict || conflict.resolved) return null;
  const current = get(internal).installs[conflict.batch];
  persistState((draft) => {
    const target = draft.conflicts.find((item) => item.id === conflictId);
    if (target) target.resolved = true;
  });
  return submitInstallCorrection({
    batch: conflict.batch,
    units: conflict.proposedUnits,
    expectedRevision: current?.revision ?? 0,
    actor: conflict.actor
  });
}

/* ---------------- 断点继续 ---------------- */

export async function resumeJob(jobId: string): Promise<SubmitOutcome | null> {
  const job = get(internal).jobs.find((item) => item.id === jobId);
  if (!job || job.status !== 'failed') return null;

  persistState((draft) => {
    const target = draft.jobs.find((item) => item.id === jobId);
    if (target) {
      target.status = 'running';
      target.attempts += 1;
      target.note = undefined;
    }
  });
  await pump();
  const finished = get(internal).jobs.find((item) => item.id === jobId);
  if (!finished) return null;
  if (finished.status === 'committed') return { type: 'committed', job: finished, version: finished.version ?? 0 };
  return { type: 'failed', job: finished, error: finished.note ?? '重算未完成' };
}

/* ---------------- 启动恢复 ---------------- */

let recovered = false;

/** 测试支持：模拟重新打开页面（真实页面中每个会话只恢复一次）。 */
export function _resetRecoveryGateForTest() {
  recovered = false;
}

/**
 * 浏览器启动时：
 * 1) 若存在 pendingCommit（阶段 5/6 之间崩溃），先幂等重放阶段 2 再销账——
 *    页面任何时刻都只看到「完整旧版本」或「完整新版本」。
 * 2) 把崩溃时仍 running 的作业标记为 failed（checkpoint 保留），等待断点继续。
 */
export function recoverOnBoot() {
  if (!browser || recovered) return;
  recovered = true;

  const state = get(internal);

  if (state.pendingCommit) {
    // 重放阶段 2（信号侧幂等），再执行销账。
    try {
      applyPendingCommitToSignals(state);
      const plan = state.pendingCommit;
      const job = state.jobs.find((item) => item.id === plan.jobId);
      if (job) stageFinalize(job);
      persistState((draft) => {
        const target = draft.jobs.find((item) => item.id === plan.jobId);
        if (target) target.checkpoint = STAGE_LABELS.length;
      });
    } catch (error) {
      // 信号侧仍不可写：保持 pendingCommit，作业留在 failed，稍后人工 resume。
      const plan = state.pendingCommit;
      const job = state.jobs.find((item) => item.id === plan?.jobId);
      if (job) failJob(job.id, `启动恢复重放失败：${String(error)}`);
    }
  }

  persistState((draft) => {
    for (const job of draft.jobs) {
      if (job.status === 'running') {
        job.status = 'failed';
        job.note = '进程在重算过程中中断，可从断点继续。';
      }
    }
  });
}

/* ---------------- 只读视图 ---------------- */

export const recalcStore = {
  subscribe: internal.subscribe,
  reset() {
    internal.set(buildSeedRecalcState());
  }
};

export function getRecalcSnapshot(): RecalcState {
  return get(internal);
}

export { BASELINE_VERSION };
