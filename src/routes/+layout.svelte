<script lang="ts">
  import { onMount } from 'svelte';
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import AppShell from '$lib/components/AppShell.svelte';
  import { recalcStore } from '$lib/stores/recalc-store';
  import { recoverOnBoot } from '$lib/stores/recalc-store';
  import '../app.css';

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: false
      }
    }
  });

  // 重算版本/待更新批号变化（含崩溃恢复）后，令依赖信号的查询重新读取。
  let lastVersion = 0;
  let lastStaleKey = '';
  $: recalcVersion = $recalcStore.currentVersion;
  $: staleKey = $recalcStore.staleBatches.join(',');
  $: if (recalcVersion !== lastVersion || staleKey !== lastStaleKey) {
    lastVersion = recalcVersion;
    lastStaleKey = staleKey;
    if (lastVersion > 0) queryClient.invalidateQueries({ queryKey: ['signals'] });
  }

  onMount(() => recoverOnBoot());
</script>

<svelte:head>
  <title>医疗器械安全信号核查平台</title>
  <meta
    name="description"
    content="面向医疗器械上市后安全团队的信号聚类、证据核查、风险处置与审计工作台"
  />
</svelte:head>

<QueryClientProvider client={queryClient}>
  <AppShell>
    <slot />
  </AppShell>
</QueryClientProvider>
