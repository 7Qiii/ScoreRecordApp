<script setup>
/**
 * 通用弹窗：遮罩 + Escape 关闭 + 焦点圈 + 打开时锁滚动。
 *
 * 键盘行为统一交给 useDialogA11y。以前这里自己写了一份 Escape 监听，
 * 但没做焦点圈 —— 而焦点圈恰恰是手写弹窗最容易漏、又最容易被忽略的一项。
 */
import { ref, toRef } from "vue";
import { X } from "@lucide/vue";
import { useDialogA11y } from "../../composables/useDialogA11y";

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: "" },
  description: { type: String, default: "" },
  wide: { type: Boolean, default: false },
  closeOnBackdrop: { type: Boolean, default: true },
  /**
   * 是否往历史里压一条「同地址」记录，好让返回手势/系统返回键变成「关弹窗」。
   * 默认开。**路由守卫里弹出的确认框要传 false** —— 守卫正卡在一次导航中间，
   * 这时动历史栈会把 vue-router「导航失败退回原地址」的那次 go(-1) 搅乱。
   * 详见 composables/useDialogA11y.js。
   */
  historyEntry: { type: Boolean, default: true }
});

const emit = defineEmits(["update:modelValue", "close"]);

const dialogRef = ref(null);

function close() {
  emit("update:modelValue", false);
  emit("close");
}

useDialogA11y(toRef(props, "modelValue"), dialogRef, {
  onClose: close,
  // 传函数：按「打开的那一刻」读 prop，而不是按组件初始化那一刻
  historyEntry: () => props.historyEntry
});
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="ds-modal-backdrop" @mousedown.self="closeOnBackdrop && close()">
      <section
        ref="dialogRef"
        class="ds-modal"
        :class="{ 'is-wide': wide }"
        role="dialog"
        aria-modal="true"
        :aria-label="title || undefined"
      >
        <div class="ds-modal-head">
          <div>
            <h2>{{ title }}</h2>
            <p v-if="description">{{ description }}</p>
          </div>
          <button class="icon-button" type="button" aria-label="关闭" @click="close">
            <X :size="16" />
          </button>
        </div>
        <div class="ds-modal-body">
          <slot />
        </div>
        <div v-if="$slots.footer" class="ds-modal-foot">
          <slot name="footer" />
        </div>
      </section>
    </div>
  </Teleport>
</template>
