<script lang="ts">
  import type { SignalCase } from '$lib/models/signal';
  import { signalView } from '$lib/services/recalc-views';
  import { recalcStateStore } from '$lib/stores/recalc-store';
  import RiskBadge from './RiskBadge.svelte';
  import StaleMarker from './StaleMarker.svelte';

  export let signals: SignalCase[];

  const sourceLabels: Record<SignalCase['sourceType'], string> = {
    complaint: '投诉',
    repair: '维修记录',
    adverse_event: '不良事件',
    field_report: '现场报告'
  };
</script>

<div class="overflow-x-auto">
  <table class="data-table min-w-[960px]">
    <thead>
      <tr>
        <th>信号</th>
        <th>产品 / 批号</th>
        <th>风险与状态</th>
        <th>发生率（有效版本 V{$recalcStateStore.effectiveVersion}）</th>
        <th>负责人</th>
        <th>更新时间</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      {#each signals as signal (signal.id)}
        {@const view = signalView($recalcStateStore, signal)}
        <tr>
          <td>
            <a class="font-semibold text-primary-700-300 hover:underline" href={`/signals/${signal.id}`}>
              {signal.id}
            </a>
            <p class="mt-1 max-w-[380px] text-sm text-surface-600-300">{signal.title}</p>
            <p class="mt-1 text-xs text-surface-500-400">{sourceLabels[signal.sourceType]}来源</p>
          </td>
          <td>
            <p class="font-medium">{signal.product}</p>
            <p class="text-sm text-surface-500-400">{signal.batch}</p>
          </td>
          <td><RiskBadge risk={signal.riskLevel} status={signal.status} /></td>
          <td>
            <div class="flex items-center gap-2">
              <p class="metric-value font-semibold">
                {view.rate === null ? '不可算' : `${view.rate.toFixed(2)}%`}
              </p>
              {#if view.stale}<StaleMarker detail={`待更新批号：${view.staleBatches.join('、')}`} />{/if}
            </div>
            <p class="text-xs text-surface-500-400">{view.reportCount} 条报告 / {view.exposedUnits} 台装机</p>
          </td>
          <td>{signal.owner}</td>
          <td>{signal.updatedAt.slice(0, 10)}</td>
          <td>
            <a class="btn btn-sm variant-soft-primary" href={`/signals/${signal.id}`}>打开核查</a>
          </td>
        </tr>
      {:else}
        <tr>
          <td colspan="7" class="py-12 text-center text-surface-500-400">没有符合当前条件的信号。</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
