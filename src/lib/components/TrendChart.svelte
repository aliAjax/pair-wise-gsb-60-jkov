<script lang="ts">
  export let points: Array<{ label: string; value: number; threshold: number; stale?: boolean; computable?: boolean }>;

  $: maxValue = Math.max(...points.flatMap((point) => [point.value, point.threshold]), 1);
</script>

<div class="space-y-4" aria-label="发生率趋势图">
  {#each points as point}
    <div class="grid grid-cols-[140px_1fr_64px] items-center gap-3">
      <span class="truncate text-sm text-surface-500-400" title={point.label}>{point.label}</span>
      <div class="relative h-7 overflow-hidden rounded bg-surface-200-800">
        {#if point.computable === false}
          <div class="absolute inset-0 flex items-center pl-2 text-xs text-surface-500-400">装机量缺失，不可算</div>
        {:else}
          <div
            class="absolute inset-y-0 left-0 {point.stale ? 'bg-amber-400/70' : 'bg-teal-600'}"
            class:animate-pulse={point.stale}
            style={`width: ${Math.max((point.value / maxValue) * 100, 3)}%`}
          ></div>
        {/if}
        <div
          class="absolute inset-y-0 w-0.5 bg-red-600"
          style={`left: ${(point.threshold / maxValue) * 100}%`}
          title={`阈值 ${point.threshold}%`}
        ></div>
      </div>
      <span class="metric-value flex items-center justify-end gap-1 text-right text-sm font-semibold">
        {#if point.stale}<span title="旧发生率已失效">⟳</span>{/if}
        {point.value.toFixed(2)}%
      </span>
    </div>
  {/each}
</div>
