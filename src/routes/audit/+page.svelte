<script lang="ts">
  import { recalcStore } from '$lib/stores/recalc-store';
  import { signalStore } from '$lib/stores/signal-store';

  $: state = $recalcStore;
  $: signals = $signalStore;

  type TimelineEntry = {
    id: string;
    createdAt: string;
    actor: string;
    action: string;
    detail: string;
    scope: string;
    version?: number;
  };

  $: signalEntries = signals.flatMap((signal): TimelineEntry[] =>
    signal.audit.map((entry) => ({
      id: entry.id,
      createdAt: entry.createdAt,
      actor: entry.actor,
      action: entry.action,
      detail: entry.detail,
      scope: `${signal.id} · ${signal.product}`,
      version: entry.recalcVersion
    }))
  );

  $: ledgerEntries = state.ledger.map((entry): TimelineEntry => ({
    id: entry.id,
    createdAt: entry.createdAt,
    actor: entry.actor,
    action: `重算台账 · ${entry.action}`,
    detail: entry.detail,
    scope: '全局版本',
    version: entry.version
  }));

  $: auditEntries = [...signalEntries, ...ledgerEntries].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );

  function exportAll() {
    const payload = {
      generatedAt: new Date().toISOString(),
      canonicalRecalcVersion: state.currentVersion,
      batchResults: Object.values(state.batchResults),
      recalcLedger: state.ledger,
      signals: signals.map((signal) => ({
        id: signal.id,
        product: signal.product,
        batch: signal.batch,
        status: signal.status,
        risk: signal.riskLevel,
        reportCount: signal.reportCount,
        exposedUnits: signal.exposedUnits,
        occurrenceRate: signal.rateKnown ? signal.occurrenceRate : null,
        recalcVersion: signal.recalcVersion,
        conclusion: signal.versions[0] ?? null,
        audit: signal.audit
      }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `medical-device-safety-audit-rv${state.currentVersion}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
</script>

<svelte:head><title>审计报告 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <h1 class="text-2xl font-semibold">审计与可追溯报告</h1>
    <p class="mt-1 text-sm text-surface-600-300">
      证据、结论、状态流转与每次重算（报告/装机量/发生率/期限）都带操作者、时间与 RV 版本。
    </p>
  </div>
  <div class="flex items-center gap-3">
    <span class="badge bg-teal-700 text-white">导出基线 RV{state.currentVersion}</span>
    <button class="btn variant-filled-primary" type="button" on:click={exportAll}>导出完整审计包</button>
  </div>
</div>

<section class="rounded border border-surface-300-700 bg-surface-100-900">
  <div class="border-b border-surface-300-700 px-4 py-3">
    <h2 class="font-semibold">统一审计时间线</h2>
    <p class="mt-1 text-xs text-surface-500-400">
      共 {auditEntries.length} 条记录（信号审计 {signalEntries.length} · 重算台账 {ledgerEntries.length}）
    </p>
  </div>
  <div class="space-y-5 p-5">
    {#each auditEntries as entry}
      <article class="timeline-item" class:opacity-70={entry.scope === '全局版本'}>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm font-medium">
            {entry.action} · {entry.actor}
            {#if entry.version}
              <span class="badge ml-2 bg-emerald-100 text-emerald-900">RV{entry.version}</span>
            {/if}
          </p>
          <span class="text-xs text-surface-500-400">{entry.createdAt.slice(0, 16).replace('T', ' ')}</span>
        </div>
        <p class="mt-1 text-sm text-surface-600-300">{entry.detail}</p>
        <p class="mt-1 text-xs text-surface-500-400">{entry.scope}</p>
      </article>
    {/each}
  </div>
</section>
