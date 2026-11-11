<script setup>
/**
 * 指标卡：标签 + 主数值 + 趋势/补充说明。
 * 数值本身保持中性色，颜色只用在趋势说明上，避免整页花掉。
 */
defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], default: "--" },
  unit: { type: String, default: "" },
  hint: { type: String, default: "" },
  /** up / down / flat，决定 hint 的颜色 */
  trend: { type: String, default: "" },
  icon: { type: [Object, Function], default: null }
});
</script>

<template>
  <article class="ds-stat">
    <p class="ds-stat-label">
      <component :is="icon" v-if="icon" :size="15" />
      <span>{{ label }}</span>
    </p>
    <p class="ds-stat-value">
      {{ value }}<small v-if="unit">{{ unit }}</small>
    </p>
    <p
      v-if="hint"
      class="ds-stat-hint"
      :class="{ 'is-up': trend === 'up', 'is-down': trend === 'down' }"
    >
      {{ hint }}
    </p>
  </article>
</template>
