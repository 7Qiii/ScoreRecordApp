<script setup>
/**
 * 记录卡片：移动端列表替代表格的一行。
 * 传了 to 就是可点击的链接，否则渲染成普通容器（用于只读展示）。
 */
import { RouterLink } from "vue-router";

defineProps({
  to: { type: [String, Object], default: "" },
  title: { type: String, default: "" },
  score: { type: [String, Number], default: "" },
  fullScore: { type: [String, Number], default: "" },
  meta: { type: Array, default: () => [] },
  /** 科目色，画在标题左侧的竖条上 */
  accent: { type: String, default: "" }
});
</script>

<template>
  <component
    :is="to ? RouterLink : 'div'"
    :to="to || undefined"
    class="ds-record-card"
    :style="accent ? { '--ds-accent': accent } : undefined"
  >
    <div class="ds-record-card-top">
      <div class="ds-record-card-main">
        <p class="ds-record-card-title">
          <i v-if="accent" class="ds-record-card-accent" aria-hidden="true"></i>
          {{ title }}
        </p>
      </div>
      <p v-if="score !== '' && score !== null" class="ds-record-card-score">
        {{ score }}<small v-if="fullScore">/{{ fullScore }}</small>
      </p>
    </div>
    <div v-if="meta.length || $slots.tags" class="ds-record-card-meta">
      <slot name="tags" />
      <span v-for="(item, index) in meta" :key="index">{{ item }}</span>
    </div>
    <div v-if="$slots.actions" class="ds-record-card-actions">
      <slot name="actions" />
    </div>
  </component>
</template>
