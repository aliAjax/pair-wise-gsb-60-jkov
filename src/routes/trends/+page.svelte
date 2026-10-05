<script lang="ts">
  import StaleMarker from '$lib/components/StaleMarker.svelte';
  import TrendChart from '$lib/components/TrendChart.svelte';
  import { RATE_THRESHOLD, RATE_CRITICAL } from '$lib/services/recalc-engine';
  import { batchView } from '$lib/services/recalc-views';
  import { recalcStateStore } from '$lib/stores/recalc-store';
  import { signalStore } from '$lib/stores/signal-store';

  $: signals = $signalStore;
  $: state = $recalcStateStore;

  // 趋势图：各批号有效版本发生率与统一阈值对比，待更新批号使用虚线标记。
  $: batchPoints = state.installBases
    .map((base) => {
      const view = batchView(state, base.batch);
      return {
        label: base.batch,
        // 待更新时图中仍展示上一版完整数字，stale 控制样式。
        value: view.rate ?? 0,
        threshold: RATE_THRESHOLD,
        stale: view.stale,
        computable: view.rate !== null
      };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  $: overThreshold = signals
    .map((signal) => {
      const affected = signal.affectedBatches.length ? signal.affectedBatches : [signal.batch];
      const stale = affected.some((batch) => {
        const snapshot = state.snapshots.find((item) => item.batch === batch);
        // 无快照（新批号尚未物化）或正被活动任务重算才算待更新；版本较旧但无任务则保持上次结果。
        return !snapshot || snapshot.staleSince !== null;
      });
      return { signal, rate: signal.occurrenceRate, stale, reportCount: signal.reportCount, exposedUnits: signal.exposedUnits };
    })
    .filter((row) => row.rate >= RATE_THRESHOLD);

  $: staleBatchCount = state.snapshots.filter((snapshot) => snapshot.staleSince !== null).length;
  $: pendingNewBatches = state.installBases.filter(
    (base) => !state.snapshots.some((snapshot) => snapshot.batch === base.batch)
  ).length;
</script>

<svelte:head><title>趋势核对 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <h1 class="text-2xl font-semibold">发生率趋势核对</h1>
    <p class="mt-1 text-sm text-surface-600-300">
      按批号对比有效版本发生率（V{state.effectiveVersion}）与统一监测阈值，数字与总览、批次页同源。
    </p>
  </div>
  <span class="badge {staleBatchCount + pendingNewBatches > 0 ? 'bg-amber-100 text-amber-950' : 'variant-soft-primary'}">
    {staleBatchCount + pendingNewBatches > 0
      ? `${staleBatchCount + pendingNewBatches} 个批号待更新`
      : `全部批号已是 V${state.effectiveVersion}`}
  </span>
</div>

<div class="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
  <section class="rounded border border-surface-300-700 bg-surface-100-900 p-5">
    <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="font-semibold">批号发生率对比（当前有效版本）</h2>
        <p class="mt-1 text-xs text-surface-500-400">红色线为监测阈值 {RATE_THRESHOLD}%，临界线 {RATE_CRITICAL}%</p>
      </div>
    </div>
    {#if batchPoints.length === 0}
      <p class="py-10 text-center text-sm text-surface-500-400">暂无批号装机量数据。</p>
    {:else}
      <TrendChart points={batchPoints} />
      <ul class="mt-4 space-y-1 text-xs text-surface-500-400">
        {#each batchPoints.filter((point) => point.stale) as point (point.label)}
          <li class="flex items-center gap-2">
            <StaleMarker /> {point.label} 旧发生率已失效，图中暂沿用上一版完整数字。
          </li>
        {/each}
        {#each batchPoints.filter((point) => !point.computable) as point (point.label)}
          <li>{point.label}：装机量为 0，发生率暂不可算。</li>
        {/each}
      </ul>
    {/if}
  </section>

  <aside class="rounded border border-surface-300-700 bg-surface-100-900 p-5">
    <h2 class="font-semibold">趋势判断</h2>
    <div class="mt-4 space-y-4 text-sm">
      <div class="border-l-2 border-amber-500 pl-3">
        <p class="font-medium">{overThreshold.length} 条信号达到/超过阈值</p>
        <p class="mt-1 text-surface-500-400">
          统一按批号装机量重算，补录与撤回只通过重算版本生效，避免各页面口径漂移。
        </p>
      </div>
      <div class="border-l-2 border-teal-600 pl-3">
        <p class="font-medium">任务期限跟随风险</p>
        <p class="mt-1 text-surface-500-400">
          发生率 ≥ {RATE_THRESHOLD}% 期限收紧至 5 个工作日；≥ {RATE_CRITICAL}% 收紧至 2 个工作日。
        </p>
      </div>
      {#if staleBatchCount > 0}
        <div class="border-l-2 border-red-500 pl-3">
          <p class="font-medium">存在待更新批号</p>
          <p class="mt-1 text-surface-500-400">重算提交前不对新数字做趋势结论，防止按旧风险继续排期。</p>
        </div>
      {/if}
    </div>
  </aside>
</div>

<section class="mt-6 rounded border border-surface-300-700 bg-surface-100-900">
  <div class="border-b border-surface-300-700 px-4 py-3">
    <h2 class="font-semibold">需要趋势复核的信号</h2>
  </div>
  <div class="overflow-x-auto">
    <table class="data-table min-w-[820px]">
      <thead>
        <tr>
          <th>信号</th>
          <th>产品</th>
          <th>报告 / 装机</th>
          <th>核查发生率</th>
          <th>版本状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        {#each overThreshold as row (row.signal.id)}
          <tr>
            <td>{row.signal.id}</td>
            <td>{row.signal.product}</td>
            <td>{row.reportCount} / {row.exposedUnits}</td>
            <td class="metric-value">{row.rate.toFixed(2)}%</td>
            <td>
              {#if row.stale}
                <StaleMarker detail="受影响批号待更新，当前为旧数字" />
              {:else}
                <span class="badge variant-soft-primary">V{state.effectiveVersion} 有效</span>
              {/if}
            </td>
            <td><a class="btn btn-sm variant-soft-primary" href={`/signals/${row.signal.id}`}>核对详情</a></td>
          </tr>
        {:else}
          <tr>
            <td colspan="6" class="py-10 text-center text-surface-500-400">当前有效版本没有信号超过阈值。</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
