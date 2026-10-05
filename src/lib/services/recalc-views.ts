import type { RecalcState } from './recalc-engine';
import { round2 } from './recalc-math';
import type { SignalCase } from '../models/signal';

/**
 * 读模型纯函数：所有页面通过这组选择器读取物化层，
 * 只认同一份 effectiveVersion；版本落后或标记 stale 即返回待更新。
 */

function snapshotOf(state: RecalcState, batch: string) {
  return state.snapshots.find((item) => item.batch === batch);
}

export function batchView(
  state: RecalcState,
  batch: string
): {
  batch: string;
  reportCount: number | null;
  installedUnits: number | null;
  rate: number | null;
  revision: number | null;
  stale: boolean;
  jobId: string | null;
  exists: boolean;
} {
  const base = state.installBases.find((item) => item.batch === batch);
  const snapshot = snapshotOf(state, batch);
  if (!snapshot) {
    return {
      batch,
      reportCount: null,
      installedUnits: base?.installedUnits ?? null,
      rate: null,
      revision: base?.revision ?? null,
      stale: true,
      jobId: state.jobs.find((job) => job.status !== 'committed' && job.affectedBatches.includes(batch))?.id ?? null,
      exists: !!base
    };
  }
  const stale = snapshot.staleSince !== null;
  return {
    batch,
    reportCount: snapshot.reportCount,
    installedUnits: snapshot.installedUnits,
    rate: snapshot.rate,
    revision: base?.revision ?? null,
    stale,
    jobId: snapshot.staleJobId,
    exists: true
  };
}

export function signalView(
  state: RecalcState,
  signal: SignalCase
): {
  stale: boolean;
  reportCount: number;
  exposedUnits: number;
  rate: number | null;
  version: number | null;
  staleBatches: string[];
  batchRates: Array<{ batch: string; reportCount: number; installedUnits: number; rate: number | null; stale: boolean }>;
} {
  const batches = signal.affectedBatches.length ? signal.affectedBatches : [signal.batch];
  const batchRates = batches.map((batch) => {
    const view = batchView(state, batch);
    return {
      batch,
      reportCount: view.reportCount ?? 0,
      installedUnits: view.installedUnits ?? 0,
      rate: view.rate,
      stale: view.stale
    };
  });
  const staleBatches = batchRates.filter((item) => item.stale).map((item) => item.batch);
  const reportCount = round2(batchRates.reduce((sum, item) => sum + item.reportCount, 0));
  const exposedUnits = batchRates.reduce((sum, item) => sum + item.installedUnits, 0);
  const rate = exposedUnits > 0 ? round2((reportCount / exposedUnits) * 100) : null;
  const snapshots = batches.map((batch) => snapshotOf(state, batch));
  const version =
    snapshots.length && snapshots.every((snapshot) => snapshot)
      ? Math.min(...snapshots.map((snapshot) => snapshot!.version))
      : null;
  return { stale: staleBatches.length > 0, reportCount, exposedUnits, rate, version, staleBatches, batchRates };
}

export function hasPendingWork(state: RecalcState): boolean {
  return (
    state.jobs.some((job) => job.status !== 'committed') ||
    state.conflicts.some((conflict) => !conflict.resolved)
  );
}
