<script lang="ts">
  import { enhance } from '$app/forms';
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import VersionStrip from '$lib/components/VersionStrip.svelte';
  import type { BackfillInput, InstallCorrectionInput, SubmitOutcome, WithdrawInput } from '$lib/models/recalc';
  import { isBatchStale, rateText } from '$lib/services/recalc-views';
  import {
    armCommitFailure,
    recalcStore,
    resolveConflict,
    submitBackfill,
    submitInstallCorrection,
    submitWithdraw
  } from '$lib/stores/recalc-store';
  import { signalStore } from '$lib/stores/signal-store';
  import type { ActionData } from './$types';

  export let form: ActionData;

  $: state = $recalcStore;
  $: signals = $signalStore;
  $: reports = [...state.reports].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  $: batchEntries = Object.values(state.batchResults).sort((a, b) => a.batch.localeCompare(b.batch));

  let selectedSignalId = '';
  let selectedReportKey = '';
  let outcome: SubmitOutcome | null = null;
  let busy = false;
  let armFailure = false;

  $: if (!selectedSignalId && signals.length > 0) selectedSignalId = signals[0].id;
  $: selectedSignal = signals.find((signal) => signal.id === selectedSignalId);
  $: installRevision = (batch: string) => state.installs[batch]?.revision ?? 0;

  function flash(next: SubmitOutcome) {
    outcome = next;
  }

  const backfillHandler = ({ result }: { result: { type: string; data?: { backfill?: BackfillInput & { batches: string[] } } } }) => {
    if (result.type === 'success' && result.data?.backfill) {
      const input = result.data.backfill;
      busy = true;
      submitBackfill(input).then((next) => {
        flash(next);
        busy = false;
      });
    }
  };

  const withdrawHandler = ({ result }: { result: { type: string; data?: { withdraw?: WithdrawInput } } }) => {
    if (result.type === 'success' && result.data?.withdraw) {
      busy = true;
      submitWithdraw(result.data.withdraw).then((next) => {
        flash(next);
        busy = false;
      });
    }
  };

  const installHandler = ({ result }: { result: { type: string; data?: { install?: InstallCorrectionInput } } }) => {
    if (result.type === 'success' && result.data?.install) {
      if (armFailure) {
        armCommitFailure();
        armFailure = false;
      }
      busy = true;
      submitInstallCorrection(result.data.install).then((next) => {
        flash(next);
        busy = false;
      });
    }
  };

  function withdrawDirect(batchKey: string, actor: string) {
    busy = true;
    submitWithdraw({ batchKey, actor, reason: '批次页撤回选中报告' }).then((next) => {
      flash(next);
      busy = false;
    });
  }

  async function reapplyConflict(conflictId: string) {
    busy = true;
    const next = await resolveConflict(conflictId);
    if (next) flash(next);
    busy = false;
  }

  function signalTitle(id: string) {
    return signals.find((signal) => signal.id === id)?.title ?? id;
  }

  const sourceLabels: Record<string, string> = {
    field_report: '现场报告',
    complaint: '投诉',
    repair: '维修',
    adverse_event: '不良事件'
  };
  const jobStatusLabels: Record<string, string> = {
    queued: '排队中',
    running: '重算中',
    conflicted: '冲突',
    failed: '中断可续',
    duplicate: '重复拦截',
    committed: '已提交'
  };
</script>

<svelte:head><title>批次追踪与重算 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <h1 class="text-2xl font-semibold">批次追踪与发生率重算</h1>
    <p class="mt-1 text-sm text-surface-600-300">
      现场报告、批号装机量是独立数据源；任一变化只重算受影响批号，其余批号保持上次完整结果。
    </p>
  </div>
</div>

<VersionStrip />

{#if outcome}
  <div
    class="mb-5 rounded border p-3 text-sm {outcome.type === 'committed'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30'
      : outcome.type === 'conflict'
        ? 'border-orange-300 bg-orange-50 text-orange-900 dark:bg-orange-950/30'
        : outcome.type === 'duplicate'
          ? 'border-surface-300-700 bg-surface-100-900 text-surface-700-300'
          : 'border-red-300 bg-red-50 text-red-900 dark:bg-red-950/30'}"
  >
    {#if outcome.type === 'committed'}
      已提交为有效版本 RV{outcome.version}（作业 {outcome.job.id}）。总览、批次、趋势现引用同一结果。
    {:else if outcome.type === 'conflict'}
      并发冲突：你的输入（{outcome.conflict.proposedUnits} 台，基于 revision {outcome.conflict.expectedRevision}）未生效；
      该批号当前为 {outcome.conflict.currentUnits} 台（revision {outcome.conflict.currentRevision}）。输入已保留，可在冲突中心决定是否覆盖。
    {:else if outcome.type === 'duplicate'}
      {outcome.job.note}
    {:else if outcome.type === 'blocked'}
      {outcome.reason}
    {:else}
      {outcome.error}
    {/if}
  </div>
{/if}

{#if form?.message}
  <div class="mb-5 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">{form.message}</div>
{/if}

<!-- 批号 canonical 结果 -->
<section class="mb-6 rounded border border-surface-300-700 bg-surface-100-900">
  <div class="border-b border-surface-300-700 px-4 py-3">
    <h2 class="font-semibold">批号发生率（canonical）</h2>
    <p class="mt-1 text-xs text-surface-500-400">待更新批号继续显示旧值，新 RV 提交后整行原子替换。</p>
  </div>
  <div class="overflow-x-auto">
    <table class="data-table min-w-[820px]">
      <thead>
        <tr>
          <th>批号</th>
          <th>装机量（revision）</th>
          <th>报告数</th>
          <th>发生率</th>
          <th>结果版本</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        {#each batchEntries as result}
          {@const stale = isBatchStale(state, result.batch)}
          <tr class={stale ? 'bg-amber-50/60 dark:bg-amber-950/20' : ''}>
            <td class="font-medium">{result.batch}</td>
            <td>
              {result.exposedUnits}
              <span class="text-xs text-surface-500-400">（rev {state.installs[result.batch]?.revision ?? '—'}）</span>
            </td>
            <td class:metric-value={stale}>{result.reportCount}</td>
            <td class="metric-value font-semibold">{rateText(result.occurrenceRate)}</td>
            <td class="text-xs text-surface-500-400">RV{result.version}</td>
            <td>
              {#if stale}
                <span class="badge animate-pulse bg-amber-100 text-amber-950">待更新（旧值）</span>
              {:else if result.status === 'install_missing'}
                <span class="badge bg-surface-200-800">装机量缺失</span>
              {:else}
                <span class="badge bg-emerald-100 text-emerald-900">有效</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<div class="grid gap-6 xl:grid-cols-3">
  <!-- 报告补录 -->
  <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
    <h2 class="font-semibold">现场报告补录</h2>
    <p class="mt-1 text-xs text-surface-500-400">同一报告号重复补录只算一次；多个批号用逗号或顿号分隔，按批号拆开。</p>
    <form method="POST" action="?/backfill" class="mt-4 space-y-3" use:enhance={() => backfillHandler}
      on:submit={() => (outcome = null)}
    >
      <label class="block">
        <span class="mb-1 block text-sm font-medium">外部报告号</span>
        <input class="input" name="reportRef" required minlength="3" placeholder="如 F-772 / AE-261005" />
      </label>
      <label class="block">
        <span class="mb-1 block text-sm font-medium">关联信号</span>
        <select class="select" name="signalId" bind:value={selectedSignalId}>
          {#each signals as signal}
            <option value={signal.id}>{signal.id} · {signal.title}</option>
          {/each}
        </select>
      </label>
      <label class="block">
        <span class="mb-1 block text-sm font-medium">覆盖批号（可多个）</span>
        <input class="input" name="batches" required value={selectedSignal?.affectedBatches.join('、') ?? ''} />
      </label>
      <div class="grid grid-cols-2 gap-3">
        <label>
          <span class="mb-1 block text-sm font-medium">来源</span>
          <select class="select" name="source">
            <option value="field_report">现场报告</option>
            <option value="complaint">投诉</option>
            <option value="repair">维修</option>
            <option value="adverse_event">不良事件</option>
          </select>
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">发生日期</span>
          <input class="input" name="occurredAt" type="date" required />
        </label>
      </div>
      <label class="block">
        <span class="mb-1 block text-sm font-medium">操作人</span>
        <input class="input" name="actor" required placeholder="两位以上姓名" />
      </label>
      <button class="btn w-full variant-filled-primary" type="submit" disabled={busy}>补录并重算</button>
    </form>
  </section>

  <!-- 报告撤回 -->
  <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
    <h2 class="font-semibold">现场报告撤回</h2>
    <p class="mt-1 text-xs text-surface-500-400">撤回只标记不删除，受影响批号立即按旧值待更新并重算。</p>
    <form method="POST" action="?/withdraw" class="mt-4 space-y-3" use:enhance={() => withdrawHandler}
      on:submit={() => (outcome = null)}
    >
      <label class="block">
        <span class="mb-1 block text-sm font-medium">选择报告 × 批号</span>
        <select class="select" name="batchKey" bind:value={selectedReportKey}>
          <option value="" disabled>请选择</option>
          {#each reports.filter((report) => !report.withdrawn) as report}
            <option value={`${report.reportRef}::${report.batch}`}>
              {report.reportRef} × {report.batch}（{signalTitle(report.signalId)}）
            </option>
          {/each}
        </select>
      </label>
      <label class="block">
        <span class="mb-1 block text-sm font-medium">撤回原因</span>
        <textarea class="textarea" name="reason" rows="2" required minlength="4"></textarea>
      </label>
      <label class="block">
        <span class="mb-1 block text-sm font-medium">操作人</span>
        <input class="input" name="actor" required />
      </label>
      <button class="btn w-full variant-soft-error" type="submit" disabled={busy || !selectedReportKey}>撤回并重算</button>
    </form>
  </section>

  <!-- 装机量修正 -->
  <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
    <h2 class="font-semibold">批号装机量修正</h2>
    <p class="mt-1 text-xs text-surface-500-400">带 revision 基线提交；两人同时修正同批号时，后到者保留输入并看到冲突。</p>
    <form method="POST" action="?/install" class="mt-4 space-y-3" use:enhance={() => installHandler}
      on:submit={() => (outcome = null)}
    >
      <label class="block">
        <span class="mb-1 block text-sm font-medium">批号</span>
        <input class="input" name="batch" list="known-batches" required placeholder="选择或输入新批号" />
        <datalist id="known-batches">
          {#each batchEntries as result}<option value={result.batch}>{result.batch}</option>{/each}
        </datalist>
      </label>
      <div class="grid grid-cols-2 gap-3">
        <label>
          <span class="mb-1 block text-sm font-medium">新装机量（台）</span>
          <input class="input" name="units" type="number" min="0" step="1" required />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">我看到的 revision</span>
          <input class="input" name="expectedRevision" type="number" min="0" step="1" required value="1" />
        </label>
      </div>
      <label class="block">
        <span class="mb-1 block text-sm font-medium">操作人</span>
        <input class="input" name="actor" required />
      </label>
      <label class="flex items-center gap-2 text-xs text-surface-500-400">
        <input type="checkbox" bind:checked={armFailure} />
        演练：让这次提交在「两阶段提交」阶段失败一次（验证断点继续、不留半套数字）
      </label>
      <button class="btn w-full variant-filled-secondary" type="submit" disabled={busy}>提交修正并重算</button>
    </form>
  </section>
</div>

<!-- 并发冲突中心 -->
{#if state.conflicts.length > 0}
  <section class="mt-6 rounded border border-orange-300 bg-orange-50/60 dark:bg-orange-950/20">
    <div class="border-b border-orange-200 px-4 py-3 dark:border-orange-800">
      <h2 class="font-semibold text-orange-900 dark:text-orange-200">并发修正冲突中心</h2>
      <p class="mt-1 text-xs text-orange-800 dark:text-orange-300">后到者的输入完整保留，确认后以最新 revision 为基线重新提交。</p>
    </div>
    <div class="divide-y divide-orange-200 dark:divide-orange-800">
      {#each state.conflicts as conflict}
        <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
          <div>
            <p class="font-medium">{conflict.batch} · {conflict.actor} 的修正</p>
            <p class="mt-1 text-xs text-surface-600-300">
              期望基线 rev {conflict.expectedRevision} → 提议 {conflict.proposedUnits} 台；
              当前已生效 {conflict.currentUnits} 台（rev {conflict.currentRevision}，先到者）
            </p>
          </div>
          {#if conflict.resolved}
            <span class="badge bg-emerald-100 text-emerald-900">已裁决</span>
          {:else}
            <button class="btn variant-filled-primary" type="button" disabled={busy} on:click={() => reapplyConflict(conflict.id)}>
              以我的输入（{conflict.proposedUnits} 台）覆盖并重算
            </button>
          {/if}
        </div>
      {/each}
    </div>
  </section>
{/if}

<!-- 作业流水线 -->
<section class="mt-6 rounded border border-surface-300-700 bg-surface-100-900">
  <div class="border-b border-surface-300-700 px-4 py-3">
    <h2 class="font-semibold">重算作业流水线（断点可恢复）</h2>
  </div>
  <div class="overflow-x-auto">
    <table class="data-table min-w-[860px]">
      <thead>
        <tr>
          <th>作业</th>
          <th>类型</th>
          <th>受影响批号</th>
          <th>断点</th>
          <th>状态</th>
          <th>RV</th>
        </tr>
      </thead>
      <tbody>
        {#each state.jobs.slice(0, 12) as job}
          <tr>
            <td class="text-xs">{job.id}</td>
            <td>{job.kind === 'backfill' ? '补录' : job.kind === 'withdraw' ? '撤回' : '装机量修正'}</td>
            <td class="text-xs">{job.affectedBatches.join('、') || '—'}</td>
            <td class="text-xs text-surface-500-400">{job.checkpoint}/7{job.note ? ` · ${job.note}` : ''}</td>
            <td><span class="badge bg-surface-200-800">{jobStatusLabels[job.status] ?? job.status}</span></td>
            <td class="text-xs">{job.version ? `RV${job.version}` : '—'}</td>
          </tr>
        {:else}
          <tr><td colspan="6" class="py-8 text-center text-surface-500-400">尚无重算作业，基线为 RV1。</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<!-- 信号风险联动速览 -->
<section class="mt-6 rounded border border-surface-300-700 bg-surface-100-900">
  <div class="border-b border-surface-300-700 px-4 py-3">
    <h2 class="font-semibold">受影响信号与任务期限</h2>
  </div>
  <div class="grid gap-3 p-4 md:grid-cols-2">
    {#each signals as signal}
      <article class="rounded border border-surface-300-700 p-3">
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="text-xs text-surface-500-400">{signal.id} · {signal.product}</p>
            <p class="mt-1 font-medium">{signal.batch}</p>
          </div>
          <RiskBadge risk={signal.riskLevel} status={signal.status} />
        </div>
        <p class="mt-2 text-sm">
          {signal.reportCount} 条 / {signal.exposedUnits} 台 ·
          <span class="metric-value font-semibold">{signal.rateKnown ? `${signal.occurrenceRate.toFixed(2)}%` : '待装机量'}</span>
          <span class="ml-2 text-xs text-surface-500-400">RV{signal.recalcVersion || '—'}</span>
        </p>
        <ul class="mt-2 space-y-1 text-xs text-surface-500-400">
          {#each signal.tasks as task}
            <li>
              {task.title} · 截止 {task.dueAt}
              {#if task.scheduledByVersion}（RV{task.scheduledByVersion} 重排）{/if}
            </li>
          {/each}
        </ul>
      </article>
    {/each}
  </div>
</section>

<!-- 最近按批号拆分的原始报告 -->
<section class="mt-6 rounded border border-surface-300-700 bg-surface-100-900">
  <div class="flex items-center justify-between border-b border-surface-300-700 px-4 py-3">
    <h2 class="font-semibold">报告 × 批号台账（已按批号拆开）</h2>
    <span class="text-xs text-surface-500-400">{reports.length} 条</span>
  </div>
  <div class="max-h-[360px] overflow-auto">
    <table class="data-table min-w-[760px]">
      <thead>
        <tr><th>报告号</th><th>批号</th><th>信号</th><th>来源</th><th>发生日期</th><th>操作人</th><th>状态</th></tr>
      </thead>
      <tbody>
        {#each reports as report}
          <tr class={report.withdrawn ? 'opacity-60' : ''}>
            <td class="font-medium">{report.reportRef}</td>
            <td>{report.batch}</td>
            <td class="text-xs">{report.signalId}</td>
            <td class="text-xs">{sourceLabels[report.source]}</td>
            <td class="text-xs">{report.occurredAt}</td>
            <td class="text-xs">{report.actor}</td>
            <td>
              {#if report.withdrawn}
                <span class="badge bg-surface-200-800">已撤回</span>
              {:else}
                <button class="btn btn-sm variant-ghost-surface" type="button" disabled={busy}
                  on:click={() => withdrawDirect(`${report.reportRef}::${report.batch}`, '批次页快速撤回')}>
                  撤回
                </button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
