<script lang="ts">
  import { recalcStore, resumeJob } from '$lib/stores/recalc-store';
  import { stageLabel } from '$lib/stores/recalc-store';
  import { rateText } from '$lib/services/recalc-views';

  $: state = $recalcStore;
  $: failedJobs = state.jobs.filter((job) => job.status === 'failed');
  $: conflictedJobs = state.jobs.filter((job) => job.status === 'conflicted');
  $: runningJobs = state.jobs.filter((job) => job.status === 'queued' || job.status === 'running');

  let busy = false;
  async function resume(jobId: string) {
    busy = true;
    await resumeJob(jobId);
    busy = false;
  }
</script>

<section class="mb-5 rounded border border-surface-300-700 bg-surface-100-900 p-4">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="flex flex-wrap items-center gap-3">
      <span class="badge bg-teal-700 text-white">当前有效版本 RV{state.currentVersion}</span>
      {#if state.staleBatches.length > 0}
        <span class="badge animate-pulse bg-amber-100 text-amber-950">
          {state.staleBatches.length} 个批号待更新：{state.staleBatches.join('、')}
        </span>
      {:else}
        <span class="badge bg-emerald-100 text-emerald-900">各页面数字一致，无待更新批号</span>
      {/if}
      {#if state.pendingCommit}
        <span class="badge bg-orange-100 text-orange-950">
          提交计划 RV{state.pendingCommit.version} 已落库，待销账
        </span>
      {/if}
    </div>
    <p class="text-xs text-surface-500-400">
      总览 / 批次 / 趋势只认同一份有效重算版本；旧结果在新 RV 生效前保持显示并标记待更新。
    </p>
  </div>

  {#if runningJobs.length > 0}
    <div class="mt-3 space-y-2">
      {#each runningJobs as job}
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span class="badge bg-surface-200-800">{job.id}</span>
          <span>正在执行：{stageLabel(Math.min(job.checkpoint, 6))}</span>
          <span class="text-xs text-surface-500-400">（阶段 {job.checkpoint + 1}/7 已持久化断点）</span>
        </div>
      {/each}
    </div>
  {/if}

  {#if failedJobs.length > 0}
    <div class="mt-3 rounded border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/30">
      {#each failedJobs as job}
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="text-sm">
            <p class="font-medium text-amber-900 dark:text-amber-200">
              作业 {job.id} 在「{stageLabel(Math.min(job.checkpoint, 6))}」阶段中断
            </p>
            <p class="mt-1 text-xs text-amber-800 dark:text-amber-300">{job.note}</p>
            <p class="mt-1 text-xs text-surface-500-400">
              受影响批号仍显示旧结果与待更新标记，数字不会停在半路。
            </p>
          </div>
          <button class="btn variant-filled-primary" type="button" disabled={busy} on:click={() => resume(job.id)}>
            从断点继续
          </button>
        </div>
      {/each}
    </div>
  {/if}

  {#if conflictedJobs.length > 0}
    <p class="mt-3 text-xs text-orange-700 dark:text-orange-300">
      {conflictedJobs.length} 个装机量修正存在并发冲突，请在下方冲突中心裁决。
    </p>
  {/if}

  <!-- 便于核对：当前批号 canonical 结果速览 -->
  <div class="mt-3 flex flex-wrap gap-2 text-xs text-surface-500-400">
    {#each Object.values(state.batchResults) as result}
      <span class:line-through={state.staleBatches.includes(result.batch)}>
        {result.batch}：{result.reportCount} 条 / {result.exposedUnits} 台 = {rateText(result.occurrenceRate)}
        {state.staleBatches.includes(result.batch) ? '（待更新）' : ''}
      </span>
    {/each}
  </div>
</section>
