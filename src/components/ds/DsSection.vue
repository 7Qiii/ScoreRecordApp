<script setup>
/**
 * 区块卡片：统一「标题 + 说明 + 右侧操作 + 内容」的节奏。
 * flush 模式下标题带下边框、内容自带内边距，适合直接放表格。
 */
import { ChevronDown, X } from "@lucide/vue";

const props = defineProps({
  title: { type: String, default: "" },
  description: { type: String, default: "" },
  flush: { type: Boolean, default: false },
  closable: { type: Boolean, default: false },
  /** 可折叠：标题区变成开关，点一下收起 / 展开 */
  collapsible: { type: Boolean, default: false },
  collapsed: { type: Boolean, default: false }
});

const emit = defineEmits(["close", "update:collapsed"]);

function toggle() {
  if (!props.collapsible) return;
  emit("update:collapsed", !props.collapsed);
}
</script>

<template>
  <section class="ds-section" :class="{ 'is-flush': flush, 'is-collapsed': collapsible && collapsed }">
    <div v-if="title || $slots.actions || $slots.meta" class="ds-section-head">
      <div
        :class="{ 'ds-section-toggle': collapsible }"
        :role="collapsible ? 'button' : undefined"
        :tabindex="collapsible ? 0 : undefined"
        :aria-expanded="collapsible ? String(!collapsed) : undefined"
        @click="toggle"
        @keydown.enter.prevent="toggle"
        @keydown.space.prevent="toggle"
      >
        <h2>
          <ChevronDown v-if="collapsible" class="ds-section-chevron" :size="15" aria-hidden="true" />
          {{ title }}
        </h2>
        <span v-if="description" class="ds-section-meta">{{ description }}</span>
      </div>
      <div class="ds-section-tools">
        <slot name="meta" />
        <slot name="actions" />
        <button v-if="closable" class="icon-button" type="button" aria-label="关闭" @click="$emit('close')">
          <X :size="15" />
        </button>
      </div>
    </div>
    <div v-show="!collapsible || !collapsed" :class="flush ? 'ds-section-body' : ''">
      <slot />
    </div>
  </section>
</template>
