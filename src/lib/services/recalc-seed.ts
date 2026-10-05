import type { SignalCase } from '$lib/models/signal';
import type { BatchInstall, BatchResult, FieldReport, RecalcAuditEntry, RecalcState } from '$lib/models/recalc';
import { round2 } from './recalc';

/**
 * 初始基线：现场报告按「报告号 × 批号」拆开存放，批号装机量独立登记，
 * 批号发生率结果全部由这两个数据源算出（RV1），与 seed 信号上的
 * reportCount / exposedUnits / occurrenceRate 严格一致。
 */

interface ReportSeed {
  ref: string;
  batch: string;
  signalId: string;
  day: string; // YYYY-MM-DD
  source: FieldReport['source'];
}

function spread(
  refPrefix: string,
  batch: string,
  signalId: string,
  counts: Record<string, number>,
  source: FieldReport['source'] = 'field_report'
): ReportSeed[] {
  const seeds: ReportSeed[] = [];
  let index = 1;
  for (const [month, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i += 1) {
      const day = String(6 + ((i * 7 + index) % 21)).padStart(2, '0');
      seeds.push({
        ref: `${refPrefix}-${String(index).padStart(3, '0')}`,
        batch,
        signalId,
        day: `${month}-${day}`,
        source
      });
      index += 1;
    }
  }
  return seeds;
}

const reportSeeds: ReportSeed[] = [
  // SIG-018：13 条集中在 260401，4 条在 260403，合计 17 / 2048 = 0.83%
  ...spread('RPT-IP8-A', 'IP8-260401', 'SIG-2026-018', {
    '2026-04': 1,
    '2026-05': 1,
    '2026-06': 2,
    '2026-07': 2,
    '2026-08': 3,
    '2026-09': 4
  }),
  ...spread('RPT-IP8-B', 'IP8-260403', 'SIG-2026-018', {
    '2026-06': 1,
    '2026-07': 1,
    '2026-08': 1,
    '2026-09': 1
  }),
  // SIG-015：9 / 876 = 1.03%
  ...spread('RPT-M12', 'M12-251118', 'SIG-2026-015', {
    '2026-07': 3,
    '2026-08': 3,
    '2026-09': 3
  }, 'repair'),
  // SIG-011：4 / 310 = 1.29%
  ...spread('RPT-SW5', 'SW-5.3.1', 'SIG-2026-011', {
    '2026-05': 2,
    '2026-06': 2
  }, 'field_report'),
  // SIG-019：3 / 120 = 2.50%
  ...spread('RPT-D9', 'D9-260722', 'SIG-2026-019', {
    '2026-09': 3
  }, 'adverse_event')
];

const installSeeds: Array<[string, number]> = [
  ['IP8-260401', 1568],
  ['IP8-260403', 480],
  ['M12-251118', 876],
  ['SW-5.3.1', 310],
  ['D9-260722', 120]
];

const BASELINE_AT = '2026-09-28T12:00:00.000Z';
export const BASELINE_VERSION = 1;

export function buildSeedReports(): FieldReport[] {
  return reportSeeds.map((seed) => ({
    reportRef: seed.ref,
    batch: seed.batch,
    signalId: seed.signalId,
    source: seed.source,
    occurredAt: seed.day,
    receivedAt: `${seed.day}T01:00:00.000Z`,
    actor: '初始基线',
    withdrawn: false
  }));
}

export function buildSeedInstalls(): Record<string, BatchInstall> {
  return Object.fromEntries(
    installSeeds.map(([batch, units]) => [
      batch,
      { batch, units, revision: 1, updatedAt: BASELINE_AT, updatedBy: '初始基线' }
    ])
  );
}

export function buildSeedBatchResults(reports: FieldReport[], installs: Record<string, BatchInstall>): Record<string, BatchResult> {
  const results: Record<string, BatchResult> = {};
  for (const [batch, install] of Object.entries(installs)) {
    const count = reports.filter((report) => !report.withdrawn && report.batch === batch).length;
    results[batch] = {
      batch,
      reportCount: count,
      exposedUnits: install.units,
      occurrenceRate: round2((count / install.units) * 100),
      status: 'valid',
      computedAt: BASELINE_AT,
      version: BASELINE_VERSION
    };
  }
  return results;
}

export const seedLedger: RecalcAuditEntry[] = [
  {
    id: 'LED-BASELINE',
    version: BASELINE_VERSION,
    jobId: 'JOB-BASELINE',
    kind: 'backfill',
    actor: '初始基线',
    action: '建立基线',
    detail:
      'RV1：导入现场报告（按批号拆分）与批号装机量，产出各批号初始发生率：' +
      'IP8-260401=0.83%（跨批合计）、M12-251118=1.03%、SW-5.3.1=1.29%、D9-260722=2.50%。',
    createdAt: BASELINE_AT
  }
];

export function buildSeedRecalcState(): RecalcState {
  const reports = buildSeedReports();
  const installs = buildSeedInstalls();
  return {
    reports,
    installs,
    batchResults: buildSeedBatchResults(reports, installs),
    jobs: [],
    conflicts: [],
    ledger: [...seedLedger],
    currentVersion: BASELINE_VERSION,
    staleBatches: [],
    pendingCommit: null
  };
}

/** 供信号基线使用：批号 -> RV1 发生率结果。 */
export function baselineRateFor(signals: SignalCase[]): Map<string, BatchResult> {
  const state = buildSeedRecalcState();
  const result = new Map<string, BatchResult>();
  for (const signal of signals) {
    for (const batch of signal.affectedBatches) {
      const batchResult = state.batchResults[batch];
      if (batchResult) result.set(batch, batchResult);
    }
  }
  return result;
}
