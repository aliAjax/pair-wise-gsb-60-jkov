<script lang="ts">
  import type { SignalCase } from '$lib/models/signal';
  import type { RecalcState } from '$lib/models/recalc';
  import { signalRecalcView } from '$lib/services/recalc-views';

  export let state: RecalcState;
  export let signal: SignalCase;
  export let size: 'sm' | 'md' = 'sm';

  $: view = signalRecalcView(state, signal);
  const padding = size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-xs';
</script>

{#if view.stale}
  <span
    class="badge animate-pulse {padding} bg-amber-100 text-amber-950"
    title={`受影响批号：${view.staleBatches.join('、')}；旧发生率已失效，重算完成后更新`}
  >
    待更新（显示 RV{view.version || '—'} 旧值）
  </span>
{:else if view.neverCalculated}
  <span class="badge {padding} bg-surface-200-800" title="尚未纳入任何一次有效重算">
    待重算
  </span>
{:else}
  <span class="badge {padding} bg-emerald-100 text-emerald-900" title="当前数字来自有效重算版本">
    RV{view.version}
  </span>
{/if}
