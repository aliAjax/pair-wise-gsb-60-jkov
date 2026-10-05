<script lang="ts">
  import { armFault, recalc, recalcStateStore } from '$lib/stores/recalc-store';
  import { signalStore } from '$lib/stores/signal-store';
  import { stageLabel, type RecalcStage } from '$lib/services/recalc-engine';

  $: signals = $signalStore;
  $: state = $recalcStateStore;

  type TimelineEntry = {
    id: string;
    at: string;
    actor: string;
    title: string;
    detail: string;
    scope: string;
    tone: 'signal' | 'recalc' | 'conflict' | 'failure';
  };

  const signalEntries = (): TimelineEntry[] =>
    signals.flatMap((signal) =>
      signal.audit.map((entry) => ({
        id: entry.id,
        at: entry.createdAt,
        actor: entry.actor,
        title: entry.action,
        detail: entry.detail,
        scope: `${signal.id} · ${signal.product}`,
        tone: 'signal' as const
      }))
    );

  const recalcEntries = (): TimelineEntry[] =>
    state.events.map((event) => ({
      id: event.id,
      at: event.at,
      actor: event.actor,
      title: kindLabel(event.kind),
      detail: event.detail,
      scope: `重算${event.jobId ? ` · ${event.jobId}` : ' · 事件流'}`,
      tone:
        event.kind === 'job_failed'
          ? ('failure' as const)
          : event.kind === 'conflict_detected'
            ? ('conflict' as const)
            : ('recalc' as const)
    }));

  $: timeline = [...signalEntries(), ...recalcEntries()].sort((a, b) => b.at.localeCompare(a.at));
  $: failedJobs = state.jobs.filter((job) => job.status === 'failed');
  $: recentJobs = state.jobs.slice(0, 6);

  function kindLabel(kind: string): string {
    const labels: Record<string, string> = {
      report_accepted: '补录现场报告',
      report_duplicate: '重复补录拦截',
      report_withdrawn: '撤回现场报告',
      report_missing: '撤回未命中',
      report_already_withdrawn: '重复撤回拦截',
      install_base_corrected: '修正装机量',
      fault_configured: '设置故障演练',
      conflict_detected: '装机量并发冲突',
      conflict_resolved: '冲突已处理',
      job_failed: '重算中断',
      job_resumed: '断点续算',
      job_committed: '重算版本提交'
    };
    return labels[kind] ?? kind;
  }

  let faultStage: RecalcStage = 'batch_rates';
  const faultStages: RecalcStage[] = ['mark_stale', 'batch_rates', 'signal_refresh', 'finalize'];

  function arm() {
    armFault(faultStage);
    recalc.recordEvent(
      '安全评审专员',
      'fault_configured',
      `下一次重算将在「${stageLabel(faultStage)}」阶段模拟一次写入失败（断点保留，可续跑）。`
    );
  }

  function exportAll() {
    const payload = {
      generatedAt: new Date().toISOString(),
      effectiveRecalcVersion: state.effectiveVersion,
      jobs: state.jobs,
      conflicts: state.conflicts,
      recalcEvents: state.events,
      signals: signals.map((signal) => ({
        id: signal.id,
        product: signal.product,
        batch: signal.batch,
        status: signal.status,
        risk: signal.riskLevel,
        recalcVersion: signal.recalcVersion,
        conclusion: signal.versions[0] ?? null,
        audit: signal.audit
      }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `medical-device-safety-audit-v${state.effectiveVersion}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function resetAll() {
    if (confirm('确认清空本地台账与重算状态并恢复演示种子？')) {
      recalc.resetAll();
    }
  }
</script>

<svelte:head><title>审计报告 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <h1 class="text-2xl font-semibold">审计与可追溯报告</h1>
    <p class="mt-1 text-sm text-surface-600-300">
      信号操作与重算事件共用一条时间线；所有页面只认同一份有效版本 V{state.effectiveVersion}。
    </p>
  </div>
  <div class="flex gap-2">
    <button class="btn variant-ghost-surface" type="button" on:click={resetAll}>重置本地数据</button>
    <button class="btn variant-filled-primary" type="button" on:click={exportAll}>导出完整审计包</button>
  </div>
</div>

{#if failedJobs.length > 0}
  <section class="mb-6 rounded border border-red-300 bg-red-50 p-4 dark:bg-red-950/30">
    <h2 class="font-semibold text-red-900 dark:text-red-100">待恢复的中断重算（{failedJobs.length}）</h2>
    <div class="mt-3 space-y-3">
      {#each failedJobs as job (job.id)}
        <div class="flex flex-wrap items-center gap-3 text-sm">
          <span class="font-medium">{job.id}</span>
          <span class="text-surface-700-300">{job.reason}</span>
          <span class="text-xs text-red-700">
            断点：{stageLabel(job.failure?.at ?? 'mark_stale')} · 已完成 {job.completedStages.join(' → ') || '无'}
          </span>
          <button class="btn btn-sm variant-filled-error ml-auto" type="button" on:click={() => recalc.retry(job.id)}>
            从断点继续
          </button>
        </div>
      {/each}
    </div>
  </section>
{/if}

<div class="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
  <section class="rounded border border-surface-300-700 bg-surface-100-900">
    <div class="border-b border-surface-300-700 px-4 py-3">
      <h2 class="font-semibold">统一审计时间线</h2>
      <p class="mt-1 text-xs text-surface-500-400">共 {timeline.length} 条记录（信号审计 + 重算事件）</p>
    </div>
    <div class="max-h-[640px] space-y-5 overflow-y-auto p-5">
      {#each timeline as entry (entry.id)}
        <article class="timeline-item border-l-2 pl-3 {entry.tone === 'failure'
          ? 'border-red-500'
          : entry.tone === 'conflict'
            ? 'border-amber-500'
            : entry.tone === 'recalc'
              ? 'border-teal-600'
              : 'border-surface-400'}">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm font-medium">{entry.title} · {entry.actor}</p>
            <span class="text-xs text-surface-500-400">{entry.at.slice(0, 16).replace('T', ' ')}</span>
          </div>
          <p class="mt-1 text-sm text-surface-600-300">{entry.detail}</p>
          <p class="mt-1 text-xs text-surface-500-400">{entry.scope}</p>
        </article>
      {/each}
    </div>
  </section>

  <aside class="space-y-6">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">断点续算演练</h2>
      <p class="mt-1 text-xs text-surface-500-400">
        武装一次阶段故障后，下一次重算会在该阶段写入失败；任务保留断点，可从“从断点继续”恢复，不留半套数字。
      </p>
      <label class="mt-3 block">
        <span class="mb-1 block text-sm font-medium">故障阶段</span>
        <select class="select" bind:value={faultStage}>
          {#each faultStages as stage}
            <option value={stage}>{stageLabel(stage)}</option>
          {/each}
        </select>
      </label>
      <button class="btn mt-3 w-full variant-soft-error" type="button" on:click={arm}>
        武装一次「{stageLabel(faultStage)}」写入失败
      </button>
    </section>

    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">最近重算任务</h2>
      <ul class="mt-3 space-y-3 text-sm">
        {#each recentJobs as job (job.id)}
          <li class="border-l-2 border-surface-400 pl-3">
            <p class="font-medium">{job.id}</p>
            <p class="mt-1 text-xs text-surface-500-400">{job.reason}</p>
            <p class="mt-1 text-xs">
              {#if job.status === 'committed'}
                <span class="text-success-700">已提交 V{job.committedVersion}</span>
              {:else if job.status === 'failed'}
                <span class="text-red-700">中断于 {stageLabel(job.failure?.at ?? 'mark_stale')}</span>
              {:else}
                <span class="text-teal-700">进行中（{job.completedStages.length}/4）</span>
              {/if}
              · {job.actor}
            </p>
          </li>
        {:else}
          <li class="text-xs text-surface-500-400">尚无重算任务。</li>
        {/each}
      </ul>
    </section>
  </aside>
</div>
