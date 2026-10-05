<script lang="ts">
  export let detail: string = '旧发生率已失效，正在等待重算提交';
  export let size: 'sm' | 'md' = 'sm';
</script>

<span
  class="badge whitespace-nowrap bg-amber-100 text-amber-950 {size === 'md' ? 'px-3 py-2 text-xs' : ''}"
  title={detail}
>
  ⟳ 待更新
</span>
