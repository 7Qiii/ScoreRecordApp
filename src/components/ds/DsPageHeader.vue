<script setup>
/**
 * 页面头部：标题 + 说明 + 右侧操作区。
 * 各业务页统一用它，保证标题字号、间距、操作区位置一致。
 */
defineProps({
  title: { type: String, required: true },
  description: { type: String, default: "" },
  eyebrow: { type: String, default: "" }
});
</script>

<template>
  <header class="ds-page-head">
    <div>
      <p v-if="eyebrow" class="ds-page-eyebrow">{{ eyebrow }}</p>
      <h1>{{ title }}</h1>
      <p v-if="description">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="ds-page-actions">
      <slot name="actions" />
    </div>
  </header>
</template>
