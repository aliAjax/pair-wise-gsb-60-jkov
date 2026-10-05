<script lang="ts">
  import { page } from '$app/stores';
  import { recalc, recalcStateStore } from '$lib/stores/recalc-store';
  import { stageLabel, type RecalcStage } from '$lib/services/recalc-engine';

  const stageOrder: RecalcStage[] = ['mark_stale', 'batch_rates', 'signal_refresh', 'finalize'];

  $: jobs = $recalcStateStore.jobs;
  $: runningJobs = jobs.filter((job) => job.status === 'running');
  $: failedJobs = jobs.filter((job) => job.status === 'failed');
  $: openConflicts = $recalcStateStore.conflicts.filter((conflict) => !conflict.resolved);
  $: effectiveVersion = $recalcStateStore.effectiveVersion;

  function retry(jobId: string) {
    recalc.retry(jobId);
  }

  function progress(job: (typeof runningJobs)[number]) {
    const done = job.completedStages.length;
    return Math.round((done / stageOrder.length) * 100);
  }
</script>

{#if runningJobs.length > 0 || failedJobs.length > 0 || openConflicts.length > 0}
  <div class="space-y-2">
    {#each runningJobs as job (job.id)}
      {@const nextStage = stageOrder.find((stage) => !job.completedStages.includes(stage))}
      <div
        class="flex flex-wrap items-center gap-3 rounded border border-teal-500/40 bg-teal-50 px-4 py-2 text-sm text-teal-900 dark:bg-teal-950/40 dark:text-teal-100"
        role="status"
      >
        <span class="animate-pulse font-medium">⟳ 重算进行中</span>
        <span class="text-teal-800 dark:text-teal-200">{job.reason}</span>
        <span class="text-xs text-teal-700 dark:text-teal-300">
          阶段 {job.completedStages.length}/4{nextStage ? ` · 下一步：${stageLabel(nextStage)}` : ' · 即将提交'}
          · 批号 {job.affectedBatches.join('、')}
        </span>
        <div class="h-1.5 min-w-[120px] flex-1 overflow-hidden rounded bg-teal-200/70">
          <div class="h-full bg-teal-600 transition-all" style={`width: ${progress(job)}%`}></div>
        </div>
        <span class="text-xs">有效版本 V{effectiveVersion}，提交前页面显示旧数字与待更新标记</span>
      </div>
    {/each}

    {#each failedJobs as job (job.id)}
      <div
        class="flex flex-wrap items-center gap-3 rounded border border-red-400 bg-red-50 px-4 py-2 text-sm text-red-900 dark:bg-red-950/40 dark:text-red-100"
        role="alert"
      >
        <span class="font-medium">⚠ 重算中断（断点已保留）</span>
        <span>
          {job.reason} · 停在「{stageLabel(job.failure?.at ?? 'mark_stale')}」：{job.failure?.message ?? '写入失败'}
        </span>
        <span class="text-xs">各页面仍只认同一份完整版本 V{effectiveVersion}，不会出现半套数字。</span>
        <button class="btn btn-sm variant-filled-error ml-auto" type="button" on:click={() => retry(job.id)}>
          从断点继续
        </button>
        <a class="btn btn-sm variant-ghost-surface" href="/audit">查看审计</a>
      </div>
    {/each}

    {#if openConflicts.length > 0}
      <a
        href="/batches"
        class="flex flex-wrap items-center gap-3 rounded border border-amber-400 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
        class:hidden={$page.url.pathname === '/batches'}
      >
        <span class="font-medium">⚔ 装机量并发冲突 {openConflicts.length} 项</span>
        <span>后到者的输入已保留，前往批次页确认覆盖或放弃。</span>
      </a>
    {/if}
  </div>
{/if}
