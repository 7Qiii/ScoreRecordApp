<script setup>
/**
 * 加载态：骨架屏。
 * 默认渲染若干行骨架，用于列表/表格；传 variant="cards" 渲染卡片骨架。
 */
defineProps({
  rows: { type: Number, default: 4 },
  variant: { type: String, default: "rows" },
  label: { type: String, default: "正在加载…" }
});
</script>

<template>
  <div class="ds-loading" role="status" :aria-label="label">
    <template v-if="variant === 'cards'">
      <div v-for="index in rows" :key="index" class="ds-skeleton ds-skeleton-card" />
    </template>
    <template v-else>
      <div v-for="index in rows" :key="index" class="ds-skeleton ds-skeleton-row" />
    </template>
  </div>
</template>
