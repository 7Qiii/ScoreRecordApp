<script setup>
/**
 * 空状态：图标 + 标题 + 说明 + 可选操作。
 * 所有列表在「确实没有数据」时都走这里，不再各写一套。
 */
defineProps({
  icon: { type: [Object, Function], default: null },
  title: { type: String, default: "暂无数据" },
  description: { type: String, default: "" }
});
</script>

<template>
  <div class="ds-empty">
    <component :is="icon" v-if="icon" :size="26" />
    <strong>{{ title }}</strong>
    <span v-if="description">{{ description }}</span>
    <div v-if="$slots.action" class="ds-empty-action">
      <slot name="action" />
    </div>
  </div>
</template>
