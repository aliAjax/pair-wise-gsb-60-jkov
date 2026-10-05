import type { RiskLevel, SignalCase, SignalRecalcPatch, InvestigationTask, AuditEntry } from '$lib/models/signal';
import type {
  BatchInstall,
  BatchResult,
  FieldReport,
  PendingCommit,
  RecalcAuditEntry,
  RecalcJob,
  RecalcState
} from '$lib/models/recalc';

/* ============================================================================
 * 纯函数重算引擎：发生率 / 风险 / 任务期限 / 审计 / 提交计划全部在此计算。
 * 不触碰 localStorage 与 svelte store，因此可以被反复重放（崩溃恢复）而
 * 不会产生重复审计或重复期限重排。
 * ========================================================================== */

/** 发生率阈值（%）：>=2 严重，>=1 高，>=0.5 中，否则低。 */
export function riskFromRate(ratePercent: number | null): RiskLevel {
  if (ratePercent === null) return 'low';
  if (ratePercent >= 2) return 'critical';
  if (ratePercent >= 1) return 'high';
  if (ratePercent >= 0.5) return 'medium';
  return 'low';
}

export function riskFromSeverity(severity: number): RiskLevel {
  if (severity >= 5) return 'critical';
  if (severity >= 4) return 'high';
  if (severity >= 3) return 'medium';
  return 'low';
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/** 风险联动后的任务期限 SLA（天）：严重 3 / 高 7 / 中 14 / 低 30。 */
export const SLA_DAYS: Record<RiskLevel, number> = {
  critical: 3,
  high: 7,
  medium: 14,
  low: 30
};

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function batchKeyOf(reportRef: string, batch: string): string {
  return `${reportRef}::${batch}`;
}

/* ---------------- 批号维度统计 ---------------- */

export function countReportsForBatch(reports: FieldReport[], batch: string): number {
  return reports.reduce((count, report) => count + (!report.withdrawn && report.batch === batch ? 1 : 0), 0);
}

export function computeBatchResult(
  batch: string,
  reports: FieldReport[],
  installs: Record<string, BatchInstall>,
  at: string,
  version: number
): BatchResult {
  const reportCount = countReportsForBatch(reports, batch);
  const install = installs[batch];
  const exposedUnits = install?.units ?? 0;
  const status = install ? 'valid' : 'install_missing';
  const occurrenceRate = exposedUnits > 0 ? round2((reportCount / exposedUnits) * 100) : null;
  return { batch, reportCount, exposedUnits, occurrenceRate, status, computedAt: at, version };
}

/* ---------------- 信号维度聚合（报告跨批号拆开后汇总） ---------------- */

export interface SignalAggregate {
  reportCount: number;
  exposedUnits: number;
  occurrenceRate: number;
  rateKnown: boolean;
  rateRisk: RiskLevel;
  perBatch: Array<{ batch: string; reports: number; units: number; rate: number | null }>;
}

export function aggregateSignal(signal: SignalCase, state: RecalcState): SignalAggregate {
  const perBatch = signal.affectedBatches.map((batch) => {
    const reports = countReportsForBatch(state.reports, batch);
    const units = state.installs[batch]?.units ?? 0;
    return {
      batch,
      reports,
      units,
      rate: units > 0 ? round2((reports / units) * 100) : null
    };
  });
  const reportCount = perBatch.reduce((sum, item) => sum + item.reports, 0);
  const exposedUnits = perBatch.reduce((sum, item) => sum + item.units, 0);
  // 任一批号装机量缺失，分母不完整：信号级发生率标记为不可算（null 语义），
  // 不在页面上用部分批号分母冒充整体发生率。
  const rateKnown = perBatch.length > 0 && perBatch.every((item) => item.units > 0);
  const occurrenceRate = rateKnown ? round2((reportCount / exposedUnits) * 100) : 0;
  return {
    reportCount,
    exposedUnits,
    occurrenceRate,
    rateKnown,
    rateRisk: riskFromRate(rateKnown ? occurrenceRate : null),
    perBatch
  };
}

/* ---------------- 任务期限重排 ---------------- */

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function rescheduleTasks(tasks: InvestigationTask[], risk: RiskLevel, commitDate: string): InvestigationTask[] {
  const earliest = addDays(commitDate, SLA_DAYS[risk]);
  return tasks.map((task) => {
    // 已完成的任务不动；SLA 只会收紧（更早），不会因风险回落而放宽。
    if (task.status === 'done' || task.dueAt <= earliest) return task;
    return { ...task, dueAt: earliest };
  });
}

/* ---------------- 提交计划（唯一的原子事实来源） ---------------- */

export interface CommitContext {
  version: number;
  committedAt: string;
  makeId: (prefix: string) => string;
}

/**
 * 根据已写入输入后的草稿状态，计算全部受影响批号/信号的新结果、风险联动、
 * 任务期限与审计，产出一份可重放的提交计划。纯函数：同样的输入必然产出
 * 同样的计划，崩溃恢复时直接重放即可。
 */
export function buildCommitPlan(
  draft: RecalcState,
  staleBatches: string[],
  signals: SignalCase[],
  job: RecalcJob,
  ctx: CommitContext
): PendingCommit {
  const { version, committedAt, makeId } = ctx;
  const today = committedAt.slice(0, 10);

  const batchResults: BatchResult[] = staleBatches.map((batch) =>
    computeBatchResult(batch, draft.reports, draft.installs, committedAt, version)
  );

  const affectedSignalIds = new Set(
    signals
      .filter((signal) => signal.affectedBatches.some((batch) => staleBatches.includes(batch)))
      .map((signal) => signal.id)
  );

  // 在草稿状态上叠加本批新结果，用于信号聚合（其余批号保持上次完整结果，
  // 这里读取的 draft.batchResults 未变化，信号聚合只依赖 reports/installs）。
  const signalPatches: Record<string, SignalRecalcPatch> = {};
  const actor = jobActor(job);

  for (const signal of signals) {
    if (!affectedSignalIds.has(signal.id)) continue;
    const aggregate = aggregateSignal(signal, draft);
    const severityRisk = riskFromSeverity(signal.severity);
    const effectiveRisk = aggregate.rateKnown
      ? maxRisk(severityRisk, aggregate.rateRisk)
      : severityRisk;

    const audits: AuditEntry[] = [];
    const splitDetail = aggregate.perBatch
      .map((item) => `${item.batch} ${item.reports} 条/${item.units > 0 ? `${item.units} 台` : '装机量缺失'}`)
      .join('；');
    audits.push({
      id: makeId('AUD'),
      actor: '重算引擎',
      action: '发生率重算',
      detail: `RV${version}：按批号拆分复核，${splitDetail}；合计 ${aggregate.reportCount} 条/${aggregate.exposedUnits} 台，发生率 ${
        aggregate.rateKnown ? `${aggregate.occurrenceRate.toFixed(2)}%` : '装机量缺失暂不可算'
      }。`,
      createdAt: committedAt,
      recalcVersion: version,
      jobId: job.id
    });

    let tasks = signal.tasks;
    if (signal.status !== 'closed') {
      const rescheduled = rescheduleTasks(signal.tasks, effectiveRisk, today);
      for (const task of rescheduled) {
        const before = signal.tasks.find((item) => item.id === task.id);
        if (before && before.dueAt !== task.dueAt) {
          audits.push({
            id: makeId('AUD'),
            actor: '重算引擎',
            action: '期限重排',
            detail: `RV${version}：风险联动为${riskLabel(effectiveRisk)}，任务「${task.title}」截止 ${before.dueAt} -> ${task.dueAt}（SLA ${SLA_DAYS[effectiveRisk]} 天）。`,
            createdAt: committedAt,
            recalcVersion: version,
            jobId: job.id
          });
        }
      }
      tasks = rescheduled.map((task) =>
        task.dueAt !== signal.tasks.find((item) => item.id === task.id)?.dueAt
          ? { ...task, scheduledByVersion: version }
          : task
      );
    }

    if (effectiveRisk !== signal.riskLevel && signal.status !== 'closed') {
      audits.push({
        id: makeId('AUD'),
        actor: '重算引擎',
        action: '风险联动',
        detail: `RV${version}：重算发生率后风险等级 ${riskLabel(signal.riskLevel)} -> ${riskLabel(effectiveRisk)}（严重度基线 ${riskLabel(severityRisk)}）。`,
        createdAt: committedAt,
        recalcVersion: version,
        jobId: job.id
      });
    }

    signalPatches[signal.id] = {
      reportCount: aggregate.reportCount,
      exposedUnits: aggregate.exposedUnits,
      occurrenceRate: aggregate.occurrenceRate,
      rateKnown: aggregate.rateKnown,
      riskLevel: signal.status === 'closed' ? signal.riskLevel : effectiveRisk,
      audits,
      tasks
    };
  }

  const ledger: RecalcAuditEntry[] = [
    {
      id: makeId('LED'),
      version,
      jobId: job.id,
      kind: job.kind,
      actor,
      action: ledgerAction(job.kind),
      detail: ledgerDetail(job, staleBatches, batchResults, signalPatches, version),
      createdAt: committedAt
    }
  ];

  return { jobId: job.id, version, committedAt, staleBatches, batchResults, signalPatches, ledger };
}

function jobActor(job: RecalcJob): string {
  const input = job.input as { actor?: string };
  return input.actor ?? '重算引擎';
}

function ledgerAction(kind: RecalcJob['kind']): string {
  switch (kind) {
    case 'backfill':
      return '报告补录';
    case 'withdraw':
      return '报告撤回';
    case 'install_correction':
      return '装机量修正';
  }
}

function ledgerDetail(
  job: RecalcJob,
  staleBatches: string[],
  results: BatchResult[],
  patches: Record<string, SignalRecalcPatch>,
  version: number
): string {
  const rateText = results
    .map((result) => `${result.batch}=${result.occurrenceRate === null ? '待装机量' : `${result.occurrenceRate.toFixed(2)}%`}`)
    .join('，');
  return `RV${version} 生效：受影响批号 [${staleBatches.join('、')}]，新发生率 ${rateText}；联动信号 [${Object.keys(patches).join('、') || '无'}]，作业 ${job.id}。`;
}

export function riskLabel(risk: RiskLevel): string {
  return { low: '低', medium: '中', high: '高', critical: '严重' }[risk];
}

/* ---------------- 趋势（全部来自 canonical 批号结果/原始报告） ---------------- */

export interface TrendPoint {
  label: string;
  value: number; // 月度发生率 %
  reports: number;
  units: number;
}

/** 按发生月聚合：分子为当月未撤回报告数，分母为这些批号当前装机量合计。 */
export function buildMonthlyTrend(
  reports: FieldReport[],
  installs: Record<string, BatchInstall>,
  batches: string[],
  monthLabels: string[]
): TrendPoint[] {
  const batchSet = new Set(batches);
  const units = Array.from(batchSet).reduce((sum, batch) => sum + (installs[batch]?.units ?? 0), 0);
  return monthLabels.map((label) => {
    const count = reports.filter(
      (report) => !report.withdrawn && batchSet.has(report.batch) && report.occurredAt.startsWith(label)
    ).length;
    return {
      label,
      reports: count,
      units,
      value: units > 0 ? round2((count / units) * 100) : 0
    };
  });
}
