<script lang="ts">
  import TrendChart from '$lib/components/TrendChart.svelte';
  import { recalcStore } from '$lib/stores/recalc-store';
  import { signalStore } from '$lib/stores/signal-store';
  import { cumulativeTrend, signalRateText, TREND_THRESHOLD } from '$lib/services/recalc-views';

  $: state = $recalcStore;
  $: signals = $signalStore;

  // 趋势聚焦：输注泵阻塞报警涉及的全部批号（报告跨批号拆开后的合集）。
  $: focusBatches = Array.from(
    new Set(
      signals.find((signal) => signal.id === 'SIG-2026-018')?.affectedBatches ?? ['IP8-260401', 'IP8-260403']
    )
  );
  $: stale = focusBatches.some((batch) => state.staleBatches.includes(batch));
  $: points = cumulativeTrend(state, focusBatches).map((point) => ({
    label: point.label,
    value: point.value,
    threshold: TREND_THRESHOLD
  }));
  $: latest = points[points.length - 1];
  $: threeMonthsAgo = points[points.length - 4];
  $: threeMonthGrowth =
    threeMonthsAgo && threeMonthsAgo.value > 0
      ? Math.round(((latest.value - threeMonthsAgo.value) / threeMonthsAgo.value) * 1000) / 10
      : 0;
  $: mom =
    points[points.length - 2] && points[points.length - 2].value > 0
      ? Math.round(
          ((latest.value - points[points.length - 2].value) / points[points.length - 2].value) * 1000
        ) / 10
      : 0;

  // 批号集中度：当前 RV 下焦点批号各自的报告数（未撤回）。
  $: focusResults = focusBatches.map((batch) => state.batchResults[batch]).filter(Boolean);
  $: focusReports = focusResults.reduce((sum, result) => sum + result.reportCount, 0);
  $: primary = focusResults.find((result) => result.batch === 'IP8-260401');
  $: concentration = focusReports > 0 && primary ? Math.round((primary.reportCount / focusReports) * 100) : 0;

  $: reviewSignals = signals.filter(
    (signal) => signal.rateKnown && signal.occurrenceRate >= TREND_THRESHOLD
  );
</script>

<svelte:head><title>趋势核对 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6">
  <h1 class="text-2xl font-semibold">发生率趋势核对</h1>
  <p class="mt-1 text-sm text-surface-600-300">
    趋势完全由 canonical 批号报告与装机量重算，不再独立估算；与总览、批次页共用 RV{state.currentVersion} 结果。
  </p>
</div>

{#if stale}
  <div class="mb-5 flex flex-wrap items-center gap-3 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/30">
    <span class="badge animate-pulse bg-amber-100 text-amber-950">趋势待更新</span>
    <span>焦点批号 {focusBatches.join('、')} 正在重算，当前曲线为 RV{state.currentVersion} 旧结果。</span>
    <a class="text-xs font-medium underline" href="/batches">前往查看 →</a>
  </div>
{/if}

<div class="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
  <section class="rounded border border-surface-300-700 bg-surface-100-900 p-5">
    <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="font-semibold">阻塞报警累计发生率（{focusBatches.join(' + ')}）</h2>
        <p class="mt-1 text-xs text-surface-500-400">
          分子为截至当月未撤回报告数，分母为批号装机量合计；红色线为监测阈值 {TREND_THRESHOLD}%
        </p>
      </div>
      <span class="badge bg-emerald-100 text-emerald-900">RV{state.currentVersion}{stale ? ' · 旧值待更新' : ''}</span>
    </div>
    <TrendChart {points} />
  </section>

  <aside class="rounded border border-surface-300-700 bg-surface-100-900 p-5">
    <h2 class="font-semibold">趋势判断</h2>
    <div class="mt-4 space-y-4 text-sm">
      <div class="border-l-2 border-amber-500 pl-3">
        <p class="font-medium">近三月增幅 {threeMonthGrowth}%</p>
        <p class="mt-1 text-surface-500-400">9 月环比增幅 {mom}%，分母使用当前装机量合计，装机量修正会整体重算曲线。</p>
      </div>
      <div class="border-l-2 border-teal-600 pl-3">
        <p class="font-medium">批号集中度 {concentration}%</p>
        <p class="mt-1 text-surface-500-400">
          {primary?.reportCount ?? 0} / {focusReports} 条报告关联 IP8-260401（RV{state.currentVersion}）。
        </p>
      </div>
    </div>
  </aside>
</div>

<section class="mt-6 rounded border border-surface-300-700 bg-surface-100-900">
  <div class="border-b border-surface-300-700 px-4 py-3">
    <h2 class="font-semibold">需要趋势复核的信号</h2>
  </div>
  <div class="overflow-x-auto">
    <table class="data-table min-w-[760px]">
      <thead>
        <tr>
          <th>信号</th>
          <th>产品</th>
          <th>报告数</th>
          <th>核查发生率</th>
          <th>结果版本</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        {#each reviewSignals as signal}
          <tr>
            <td>{signal.id}</td>
            <td>{signal.product}</td>
            <td>{signal.reportCount}</td>
            <td class="metric-value">{signalRateText(signal)}</td>
            <td class="text-xs text-surface-500-400">RV{signal.recalcVersion || '—'}</td>
            <td><a class="btn btn-sm variant-soft-primary" href={`/signals/${signal.id}`}>核对详情</a></td>
          </tr>
        {:else}
          <tr><td colspan="6" class="py-8 text-center text-surface-500-400">当前 RV 下没有超过阈值的信号。</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
