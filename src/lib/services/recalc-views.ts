import type { SignalCase } from '$lib/models/signal';
import type { BatchResult, RecalcState } from '$lib/models/recalc';
import { buildMonthlyTrend } from './recalc';

/* 所有页面（总览/批次/趋势/审计）通过这里的只读选择器读取同一份 canonical 状态，
 * 不再各自计算发生率。 */

export function canonicalVersion(state: RecalcState): number {
  return state.currentVersion;
}

export function isBatchStale(state: RecalcState, batch: string): boolean {
  return state.staleBatches.includes(batch);
}

export function batchResult(state: RecalcState, batch: string): BatchResult | undefined {
  return state.batchResults[batch];
}

export function rateText(rate: number | null): string {
  return rate === null ? '待装机量' : `${rate.toFixed(2)}%`;
}

export interface SignalRecalcView {
  /** 受影响批号已进入待更新：页面展示旧数字 + 待更新标记。 */
  stale: boolean;
  /** 从未被任何重算版本纳入（人工新建、尚无报告/装机量）。 */
  neverCalculated: boolean;
  /** 该信号当前数字来自哪个重算版本（未受影响时保持上次完整结果版本）。 */
  version: number;
  staleBatches: string[];
}

export function signalRecalcView(state: RecalcState, signal: SignalCase): SignalRecalcView {
  const staleBatches = signal.affectedBatches.filter((batch) => state.staleBatches.includes(batch));
  return {
    stale: staleBatches.length > 0,
    neverCalculated: signal.recalcVersion === 0,
    version: signal.recalcVersion,
    staleBatches
  };
}

export function signalRateText(signal: SignalCase): string {
  if (!signal.rateKnown) return '待装机量';
  return `${signal.occurrenceRate.toFixed(2)}%`;
}

export const TREND_MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
export const TREND_THRESHOLD = 0.75;

export interface CumulativeTrendPoint {
  label: string;
  value: number;
  cumulativeReports: number;
  units: number;
}

/** 趋势图：截至每月末的累计发生率（分子累计未撤回报告，分母为批号装机量合计）。 */
export function cumulativeTrend(
  state: RecalcState,
  batches: string[],
  months: string[] = TREND_MONTHS
): CumulativeTrendPoint[] {
  const monthly = buildMonthlyTrend(state.reports, state.installs, batches, months);
  let cumulativeReports = 0;
  return monthly.map((point) => {
    cumulativeReports += point.reports;
    return {
      label: point.label,
      cumulativeReports,
      units: point.units,
      value: point.units > 0 ? Math.round((cumulativeReports / point.units) * 10000) / 100 : 0
    };
  });
}

/** 趋势是否整体待更新：涉及的任一批号处于待更新。 */
export function trendStale(state: RecalcState, batches: string[]): boolean {
  return batches.some((batch) => state.staleBatches.includes(batch));
}
