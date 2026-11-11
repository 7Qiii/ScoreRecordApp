<script setup>
/**
 * 筛选栏容器：左侧自适应字段区，右侧操作区，底部可选一行结果说明。
 * 只管布局，具体控件由调用方通过插槽传入。
 */
defineProps({
  /** 字段区最小列宽，超过就自动换行 */
  minFieldWidth: { type: Number, default: 150 }
});
</script>

<template>
  <div class="ds-filter-bar">
    <div class="ds-filter-fields" :style="{ '--ds-field-min': `${minFieldWidth}px` }">
      <slot />
    </div>
    <div v-if="$slots.actions" class="ds-filter-actions">
      <slot name="actions" />
    </div>
    <div v-if="$slots.meta" class="ds-filter-meta">
      <slot name="meta" />
    </div>
  </div>
</template>
