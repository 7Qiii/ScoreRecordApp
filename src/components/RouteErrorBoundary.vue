<script setup>
import { onErrorCaptured, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { AlertTriangle } from "@lucide/vue";
import DsEmptyState from "./ds/DsEmptyState.vue";

const props = defineProps({
  path: { type: String, required: true }
});
const failed = ref(false);

watch(() => props.path, () => { failed.value = false; });
onErrorCaptured((error, _instance, info) => {
  console.error("页面组件异常", info, error);
  failed.value = true;
  return false;
});
</script>

<template>
  <DsEmptyState
    v-if="failed"
    :icon="AlertTriangle"
    title="此页面暂时无法显示"
    description="可以重试此页面，或前往备份与恢复查看能否导出本机档案。"
    role="alert"
  >
    <template #action>
      <button class="secondary-button" type="button" @click="failed = false">重试页面</button>
      <RouterLink v-if="path !== '/backup'" class="text-link" to="/backup">前往备份与恢复</RouterLink>
    </template>
  </DsEmptyState>
  <slot v-else />
</template>
