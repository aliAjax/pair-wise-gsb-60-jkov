<script lang="ts">
  import StaleMarker from '$lib/components/StaleMarker.svelte';
  import { fieldReportSchema, installBaseSchema } from '$lib/models/signal';
  import { batchView } from '$lib/services/recalc-views';
  import { recalc, recalcStateStore } from '$lib/stores/recalc-store';
  import { signalStore } from '$lib/stores/signal-store';
  import type { ZodError } from 'zod';

  $: signals = $signalStore;
  $: state = $recalcStateStore;
  let selectedBatch = 'all';

  $: allBatches = Array.from(
    new Set([
      ...state.installBases.map((base) => base.batch),
      ...signals.flatMap((signal) => signal.affectedBatches)
    ])
  ).sort();

  $: batchCards = allBatches
    .map((batch) => {
      const view = batchView(state, batch);
      const linkedSignals = signals.filter(
        (signal) => (signal.affectedBatches.length ? signal.affectedBatches : [signal.batch]).includes(batch)
      );
      const activeReports = state.reports.filter(
        (report) => !report.withdrawnAt && report.batches.includes(batch)
      );
      return { batch, view, linkedSignals, activeReports };
    })
    .filter((card) => selectedBatch === 'all' || card.batch === selectedBatch);

  $: openConflicts = state.conflicts.filter((conflict) => !conflict.resolved);

  /* ---------------- 报告补录 / 撤回表单 ---------------- */
  const reportForm = {
    dedupKey: '',
    batches: '',
    action: 'supplement' as 'supplement' | 'withdraw',
    signalId: '',
    actor: '安全评审专员',
    note: ''
  };
  let reportMessage: { tone: 'ok' | 'warn' | 'error'; text: string } | null = null;

  // 选择关联信号时带出其覆盖批号（仍可手工增删）。
  function onSignalChange(event: Event) {
    const signalId = (event.currentTarget as HTMLSelectElement).value;
    reportForm.signalId = signalId;
    const linked = signals.find((signal) => signal.id === signalId);
    if (linked && !reportForm.batches.trim()) {
      reportForm.batches = (linked.affectedBatches.length ? linked.affectedBatches : [linked.batch]).join(', ');
    }
  }

  function submitReport() {
    reportMessage = null;
    const parsed = fieldReportSchema.safeParse({ ...reportForm, signalId: reportForm.signalId || undefined });
    if (!parsed.success) {
      reportMessage = { tone: 'error', text: (parsed.error as ZodError).issues[0]?.message ?? '表单校验失败' };
      return;
    }
    const input = parsed.data;
    const result = recalc.submitReport({
      dedupKey: input.dedupKey,
      batches: input.batches,
      action: input.action,
      signalId: input.signalId ?? null,
      actor: input.actor,
      note: input.note
    });
    if (!result.accepted) {
      if (result.reason === 'duplicate') {
        reportMessage = {
          tone: 'warn',
          text: `报告号 ${input.dedupKey} 已补录过，重复提交只算一次，未触发重算。`
        };
      } else if (result.reason === 'already_withdrawn') {
        reportMessage = { tone: 'warn', text: `报告号 ${input.dedupKey} 已撤回，重复撤回未生效。` };
      } else {
        reportMessage = { tone: 'error', text: `撤回失败：台账中没有报告号 ${input.dedupKey}。` };
      }
      return;
    }
    reportMessage = {
      tone: 'ok',
      text:
        input.action === 'supplement'
          ? `已补录，批号 ${input.batches.join('、')} 旧发生率已失效，等待重算提交（任务 ${result.jobId}）。`
          : `已撤回，批号 ${input.batches.join('、')} 将在重算提交后移除该报告计数（任务 ${result.jobId}）。`
    };
    reportForm.dedupKey = '';
    reportForm.batches = '';
    reportForm.note = '';
  }

  /* ---------------- 装机量修正表单（乐观并发） ---------------- */
  const installForm = { batch: '', installedUnits: 0, actor: '安全评审专员' };
  let installMessage: { tone: 'ok' | 'error'; text: string } | null = null;

  $: selectedBase = state.installBases.find((base) => base.batch === installForm.batch) ?? null;

  function pickBatch(batch: string) {
    installForm.batch = batch;
    const base = state.installBases.find((item) => item.batch === batch);
    installForm.installedUnits = base ? base.installedUnits : 0;
    installMessage = null;
  }

  function submitInstallBase() {
    installMessage = null;
    if (!selectedBase) {
      installMessage = { tone: 'error', text: '请选择要修正的批号。' };
      return;
    }
    const parsed = installBaseSchema.safeParse({
      batch: installForm.batch,
      installedUnits: installForm.installedUnits,
      // 以页面打开时看到的 revision 作为乐观锁依据。
      expectedRevision: selectedBase.revision,
      actor: installForm.actor
    });
    if (!parsed.success) {
      installMessage = { tone: 'error', text: (parsed.error as ZodError).issues[0]?.message ?? '表单校验失败' };
      return;
    }
    const result = recalc.correctInstallBase(parsed.data);
    if (!result.accepted) {
      installMessage = { tone: 'error', text: result.conflict.message };
      return;
    }
    installMessage = {
      tone: 'ok',
      text: `装机量已更新至版本 V${result.revision}，批号旧发生率失效，等待重算提交。`
    };
  }

  function resolve(conflictId: string, decision: 'overwrite' | 'discard') {
    recalc.resolveConflict(conflictId, decision, installForm.actor || '安全评审专员');
  }

  function rateText(rate: number | null) {
    return rate === null ? '装机量为 0，暂不可算' : `${rate.toFixed(2)}%`;
  }
</script>

<svelte:head><title>批次追踪 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <h1 class="text-2xl font-semibold">批号装机量与现场报告重算</h1>
    <p class="mt-1 text-sm text-surface-600-300">
      报告补录 / 撤回与装机量修正统一进入一次可恢复重算；各批号数字只显示当前有效版本
      V{state.effectiveVersion}。
    </p>
  </div>
  <label class="min-w-[240px]">
    <span class="mb-1 block text-sm font-medium">目标批号</span>
    <select class="select" bind:value={selectedBatch}>
      <option value="all">全部批号</option>
      {#each allBatches as batch}
        <option value={batch}>{batch}</option>
      {/each}
    </select>
  </label>
</div>

<div class="grid gap-6 xl:grid-cols-2">
  <!-- 报告补录 / 撤回 -->
  <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
    <h2 class="font-semibold">现场报告补录 / 撤回</h2>
    <p class="mt-1 text-xs text-surface-500-400">
      同一报告号重复补录只算一次；多个批号用逗号分隔，系统按批号拆开计入。
    </p>
    <form
      class="mt-4 grid gap-4 md:grid-cols-2"
      on:submit|preventDefault={submitReport}
    >
      <label>
        <span class="mb-1 block text-sm font-medium">操作类型</span>
        <select class="select" bind:value={reportForm.action}>
          <option value="supplement">补录报告</option>
          <option value="withdraw">撤回报告</option>
        </select>
      </label>
      <label>
        <span class="mb-1 block text-sm font-medium">报告号（幂等键）</span>
        <input class="input" bind:value={reportForm.dedupKey} placeholder="如 FR-2026-1007" required />
      </label>
      <label class="md:col-span-2">
        <span class="mb-1 block text-sm font-medium">覆盖批号（多个用逗号分隔）</span>
        <input
          class="input"
          bind:value={reportForm.batches}
          placeholder="如 IP8-260401, IP8-260403"
          required
        />
      </label>
      <label>
        <span class="mb-1 block text-sm font-medium">关联信号（可空）</span>
        <select class="select" value={reportForm.signalId} on:change={onSignalChange}>
          <option value="">仅按批号，不关联信号</option>
          {#each signals as signal}
            <option value={signal.id}>{signal.id} · {signal.product}</option>
          {/each}
        </select>
      </label>
      <label>
        <span class="mb-1 block text-sm font-medium">操作人</span>
        <input class="input" bind:value={reportForm.actor} required />
      </label>
      <label class="md:col-span-2">
        <span class="mb-1 block text-sm font-medium">说明</span>
        <textarea class="textarea" rows="2" bind:value={reportForm.note} placeholder="补录来源或撤回原因"></textarea>
      </label>
      <div class="md:col-span-2">
        <button class="btn variant-filled-primary" type="submit">
          {reportForm.action === 'supplement' ? '补录并触发重算' : '撤回并触发重算'}
        </button>
      </div>
      {#if reportMessage}
        <p
          class="rounded p-3 text-sm md:col-span-2 {reportMessage.tone === 'ok'
            ? 'bg-success-100 text-success-900'
            : reportMessage.tone === 'warn'
              ? 'bg-amber-100 text-amber-950'
              : 'bg-error-100 text-error-900'}"
        >
          {reportMessage.text}
        </p>
      {/if}
    </form>
  </section>

  <!-- 装机量修正 -->
  <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
    <h2 class="font-semibold">批号装机量修正</h2>
    <p class="mt-1 text-xs text-surface-500-400">
      修正带版本乐观锁：两人同时改同一批号时，后到者输入保留并提示冲突，不会静默覆盖。
    </p>
    <form class="mt-4 grid gap-4 md:grid-cols-2" on:submit|preventDefault={submitInstallBase}>
      <label class="md:col-span-2">
        <span class="mb-1 block text-sm font-medium">批号</span>
        <select class="select" value={installForm.batch} on:change={(e) => pickBatch(e.currentTarget.value)}>
          <option value="">请选择批号…</option>
          {#each state.installBases as base}
            <option value={base.batch}>{base.batch}（当前 {base.installedUnits} 台 · V{base.revision}）</option>
          {/each}
        </select>
      </label>
      {#if selectedBase}
        <label>
          <span class="mb-1 block text-sm font-medium">修正后装机量（台）</span>
          <input class="input" type="number" min="0" step="1" bind:value={installForm.installedUnits} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">操作人</span>
          <input class="input" bind:value={installForm.actor} required />
        </label>
        <p class="text-xs text-surface-500-400 md:col-span-2">
          本表单基于版本 V{selectedBase.revision}；提交时若版本已变化，将作为冲突保留你的输入。
        </p>
      {/if}
      <div class="md:col-span-2">
        <button class="btn variant-filled-primary" type="submit" disabled={!selectedBase}>提交装机量修正</button>
      </div>
      {#if installMessage}
        <p
          class="rounded p-3 text-sm md:col-span-2 {installMessage.tone === 'ok'
            ? 'bg-success-100 text-success-900'
            : 'bg-error-100 text-error-900'}"
        >
          {installMessage.text}
        </p>
      {/if}
    </form>

    {#if openConflicts.length > 0}
      <div class="section-rule mt-5 pt-4">
        <h3 class="font-medium text-amber-800">待处理并发冲突（{openConflicts.length}）</h3>
        <div class="mt-3 space-y-3">
          {#each openConflicts as conflict (conflict.id)}
            <article class="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
              <p class="font-medium">{conflict.batch}</p>
              <p class="mt-1 text-surface-700-300">{conflict.message}</p>
              <p class="mt-1 text-xs text-surface-500-400">
                提交人 {conflict.actor} · {conflict.createdAt.slice(0, 16).replace('T', ' ')}
              </p>
              <div class="mt-3 flex gap-2">
                <button
                  class="btn btn-sm variant-filled-primary"
                  type="button"
                  on:click={() => resolve(conflict.id, 'overwrite')}
                >
                  用 {conflict.proposedUnits} 台覆盖
                </button>
                <button
                  class="btn btn-sm variant-ghost-surface"
                  type="button"
                  on:click={() => resolve(conflict.id, 'discard')}
                >
                  放弃该修正
                </button>
              </div>
            </article>
          {/each}
        </div>
      </div>
    {/if}
  </section>
</div>

<!-- 批号物化卡片：唯一有效版本 -->
<section class="mt-6">
  <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
    <h2 class="font-semibold">批号发生率（有效版本 V{state.effectiveVersion}）</h2>
    <p class="text-xs text-surface-500-400">待更新卡片沿用上次完整结果，不与新数字混用</p>
  </div>
  <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
    {#each batchCards as card (card.batch)}
      <article
        class="rounded border bg-surface-100-900 p-4 {card.view.stale
          ? 'border-amber-400'
          : 'border-surface-300-700'}"
      >
        <div class="flex items-start justify-between gap-3">
          <div>
            <h3 class="font-semibold">{card.batch}</h3>
            <p class="mt-1 text-xs text-surface-500-400">
              {card.linkedSignals.map((signal) => signal.product).join('、') || '暂无关联信号'}
            </p>
          </div>
          {#if card.view.stale}
            <StaleMarker detail={`批号 ${card.batch} 旧发生率已失效，等待重算提交`} />
          {/if}
        </div>
        <dl class="mt-4 grid grid-cols-3 gap-2 text-sm">
          <div>
            <dt class="text-surface-500-400">报告数</dt>
            <dd class="metric-value mt-1 font-semibold">
              {card.view.reportCount === null ? '—' : card.view.reportCount}
            </dd>
          </div>
          <div>
            <dt class="text-surface-500-400">装机量</dt>
            <dd class="metric-value mt-1 font-semibold">
              {card.view.installedUnits === null ? '—' : card.view.installedUnits}
            </dd>
          </div>
          <div>
            <dt class="text-surface-500-400">发生率</dt>
            <dd class="metric-value mt-1 font-semibold">{rateText(card.view.rate)}</dd>
          </div>
        </dl>
        <p class="mt-3 text-xs text-surface-500-400">
          {#if card.view.stale}
            展示为上一版完整数字，任务 {card.view.jobId ?? ''} 提交后刷新。
          {:else}
            数字版本 V{state.snapshots.find((s) => s.batch === card.batch)?.version ?? 0}
            {card.view.revision !== null ? ` · 装机量修订 V${card.view.revision}` : ''}
          {/if}
        </p>
        {#if card.activeReports.length > 0}
          <div class="section-rule mt-3 pt-3">
            <p class="text-xs font-medium text-surface-500-400">生效中的补录报告（{card.activeReports.length}）</p>
            <ul class="mt-1 space-y-1 text-xs text-surface-600-300">
              {#each card.activeReports as report (report.id)}
                <li>
                  {report.dedupKey} · {report.actor} · {report.createdAt.slice(0, 10)}
                  {#if report.batches.length > 1}（{report.batches.length} 批号等分）{/if}
                </li>
              {/each}
            </ul>
          </div>
        {/if}
        <div class="mt-3 flex flex-wrap gap-2">
          {#each card.linkedSignals as signal (signal.id)}
            <a class="btn btn-sm variant-soft-primary" href={`/signals/${signal.id}`}>{signal.id}</a>
          {/each}
        </div>
      </article>
    {/each}
  </div>
</section>
