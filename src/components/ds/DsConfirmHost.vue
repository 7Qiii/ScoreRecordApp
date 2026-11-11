<script setup>
/**
 * 全局确认弹窗宿主。挂在 App.vue 根节点下，配合 useConfirm() 使用。
 */
import { computed } from "vue";
import { AlertTriangle } from "@lucide/vue";
import DsModal from "./DsModal.vue";
import { settleConfirm, useConfirm } from "../../composables/useConfirm";

const { pending } = useConfirm();

const isOpen = computed(() => Boolean(pending.value));

function cancel() {
  settleConfirm(false);
}

function accept() {
  settleConfirm(true);
}
</script>

<template>
  <DsModal
    :model-value="isOpen"
    :title="pending?.title"
    :description="pending?.message"
    :history-entry="!pending?.noHistory"
    @update:model-value="cancel"
  >
    <p v-if="pending?.tone === 'danger'" class="ds-confirm-warning">
      <AlertTriangle :size="16" />
      此操作会立即生效，请确认后再继续。
    </p>
    <template #footer>
      <button class="secondary-button" type="button" @click="cancel">{{ pending?.cancelText }}</button>
      <button
        class="primary-button"
        :class="{ 'is-danger': pending?.tone === 'danger' }"
        type="button"
        @click="accept"
      >
        {{ pending?.confirmText }}
      </button>
    </template>
  </DsModal>
</template>
