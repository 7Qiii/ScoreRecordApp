<script setup>
import { computed, ref, shallowRef } from "vue";
import DsModal from "./ds/DsModal.vue";
import { BACKUP_FILE_LIMIT, BACKUP_TABLE_LABELS, BackupImportError, inspectBackupPayload } from "../services/backup";
import { useTrackerStore } from "../stores/tracker";
import { downloadBackup } from "../utils/downloadBackup";

const emit = defineEmits(["completed", "failed"]);
const store = useTrackerStore();
const input = ref(null);
const mode = ref("merge");
const fileName = ref("");
const busy = ref(false);
const isOpen = ref(false);
const backup = shallowRef(null);
const preview = shallowRef(null);
const restoreDeleted = ref(false);
const allowPartial = ref(false);
const notice = ref("");
const merge = computed(() => mode.value === "merge");
const missingTables = computed(() => Object.entries(BACKUP_TABLE_LABELS)
  .filter(([key]) => backup.value && !Object.hasOwn(backup.value.data, key))
  .map(([, label]) => label).join("、"));
const canApply = computed(() => preview.value && !preview.value.blockingMessage && (!preview.value.invalid || allowPartial.value));

function choose(nextMode = "merge") {
  if (busy.value || isOpen.value || (nextMode === "replace" && !store.canReplaceBackup)) return;
  mode.value = nextMode;
  input.value?.click();
}

function close(open) {
  if (open || busy.value) return;
  isOpen.value = false;
  preview.value = null;
  backup.value = null;
}

async function refreshPreview() {
  preview.value = await store.previewBackupImport(backup.value, { merge: merge.value, restoreDeleted: restoreDeleted.value });
}

function importMessage(error, fallback) {
  if (error instanceof BackupImportError) return error.message;
  if (error?.name === "QuotaExceededError" || error?.inner?.name === "QuotaExceededError") return "浏览器存储空间不足，导入未写入。";
  console.error(error);
  return fallback;
}

async function onFileChange(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file || busy.value) return;
  busy.value = true;
  restoreDeleted.value = false;
  allowPartial.value = false;
  notice.value = "";
  try {
    if (file.size > BACKUP_FILE_LIMIT) throw new BackupImportError("备份文件超过 96 MiB，无法在当前页面安全读取。");
    const content = await file.text();
    let payload;
    try {
      payload = JSON.parse(content);
    } catch {
      throw new BackupImportError("文件不是有效的 JSON 备份，请检查文件后重试。");
    }
    backup.value = inspectBackupPayload(payload);
    fileName.value = file.name;
    await refreshPreview();
    isOpen.value = true;
  } catch (error) {
    backup.value = null;
    emit("failed", importMessage(error, "无法读取备份，请检查文件后重试。"));
  } finally {
    busy.value = false;
  }
}

async function changeRestore(event) {
  restoreDeleted.value = event.target.checked;
  busy.value = true;
  notice.value = "";
  try {
    await refreshPreview();
  } catch (error) {
    preview.value = null;
    notice.value = importMessage(error, "无法更新预览，请重新选择备份。");
  } finally {
    busy.value = false;
  }
}

async function exportBeforeReplace() {
  busy.value = true;
  notice.value = "";
  try {
    await downloadBackup(store);
    notice.value = "已生成当前档案的备份文件。";
  } catch (error) {
    notice.value = importMessage(error, "无法导出当前档案，请稍后重试。");
  } finally {
    busy.value = false;
  }
}

async function apply() {
  if (busy.value || !canApply.value) return;
  busy.value = true;
  notice.value = "";
  const plan = preview.value;
  try {
    const result = await store.applyBackupImport(backup.value, {
      merge: merge.value,
      restoreDeleted: restoreDeleted.value,
      allowPartial: allowPartial.value,
      expectedUserId: plan.userId,
      expectedRevision: plan.revision,
      expectedRestoration: plan.restorationRevision,
      expectedInvalid: plan.invalid
    });
    const summary = `新增 ${result.added} 条，更新 ${result.updated} 条，跳过 ${result.skipped} 条。`;
    emit("completed", result.refreshFailed
      ? `备份已写入本机。${summary}页面刷新失败，请重新加载页面查看结果。`
      : `${merge.value ? "本机合并完成" : "本机覆盖恢复完成"}。${summary}`,
    Boolean(result.refreshFailed));
    isOpen.value = false;
    backup.value = null;
    preview.value = null;
  } catch (error) {
    notice.value = importMessage(error, "导入写入失败，请检查浏览器存储后重试。");
    if (error?.code === "STALE_PREVIEW") {
      try {
        await refreshPreview();
        allowPartial.value = false;
      } catch (previewError) {
        preview.value = null;
        notice.value = importMessage(previewError, "无法更新预览，请重新选择备份。");
      }
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <slot :choose="choose" :busy="busy" />
  <input
    ref="input"
    class="visually-hidden"
    type="file"
    accept=".json,application/json"
    aria-hidden="true"
    tabindex="-1"
    @change="onFileChange"
  />
  <DsModal
    :model-value="isOpen"
    :title="merge ? '预览合并导入' : '预览覆盖恢复'"
    :description="fileName"
    :close-on-backdrop="!busy"
    @update:model-value="close"
  >
    <template v-if="preview">
      <p v-if="backup.version === null" class="ds-muted">这是未标注版本的旧备份，已按兼容格式检查。</p>
      <p v-if="merge && missingTables" class="ds-muted">备份未包含{{ missingTables }}，这些本机数据会保留。</p>
      <p v-if="!merge" class="inline-alert danger">覆盖恢复会替换本机档案和最近删除中的可恢复内容。可先导出当前档案。</p>
      <ul class="backup-preview-list">
        <li v-for="(label, key) in BACKUP_TABLE_LABELS" :key="key">
          <strong>{{ label }}</strong>
          <span v-if="merge">
            新增 {{ preview.tables[key].added }}，更新 {{ preview.tables[key].updated }}，跳过 {{ preview.tables[key].skipped + preview.tables[key].invalid }}
          </span>
          <span v-else>本机 {{ preview.tables[key].current }} → 恢复 {{ preview.tables[key].added }}</span>
        </li>
      </ul>
      <p v-if="preview.remoteOnly" class="ds-muted">{{ preview.remoteOnly }} 张图片只有链接，查看时需要网络。</p>
      <p v-if="store.canReplaceBackup === false" class="ds-muted">此次操作写入本机。云端已有记录由后续同步比较版本。</p>
      <p v-if="preview.tables.records.deleted" class="ds-muted">{{ preview.tables.records.deleted }} 条成绩存在删除记录，当前会跳过。</p>
      <label v-if="preview.restorable" class="backup-option">
        <input :checked="restoreDeleted" type="checkbox" :disabled="busy" @change="changeRestore" />
        同时恢复曾删除的 {{ preview.restorable }} 条成绩
      </label>
      <div v-if="preview.invalid" class="inline-alert danger">
        <strong>{{ preview.invalid }} 条数据未通过校验</strong>
        <ul>
          <li v-for="(detail, index) in preview.details" :key="index">{{ detail }}</li>
        </ul>
        <label v-if="merge && !preview.blockingMessage" class="backup-option">
          <input v-model="allowPartial" type="checkbox" :disabled="busy" />
          跳过无效条目，导入其余数据
        </label>
      </div>
      <p v-if="preview.blockingMessage" class="inline-alert danger">{{ preview.blockingMessage }}</p>
    </template>
    <p v-if="notice" class="inline-alert" role="status">{{ notice }}</p>
    <template #footer>
      <button v-if="!merge" class="secondary-button" type="button" :disabled="busy" @click="exportBeforeReplace">先导出当前档案</button>
      <button class="secondary-button" type="button" :disabled="busy" @click="close(false)">取消</button>
      <button class="primary-button" type="button" :disabled="busy || !canApply" @click="apply">
        {{ busy ? "处理中…" : merge ? "确认合并" : "确认覆盖" }}
      </button>
    </template>
  </DsModal>
</template>

<style scoped>
.backup-preview-list {
  display: grid;
  gap: 0.5rem;
  margin: 0.75rem 0;
  padding: 0;
  list-style: none;
}

.backup-preview-list li {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  align-items: baseline;
}

.backup-option {
  display: flex;
  min-height: 44px;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}

.backup-option input {
  flex: none;
  width: 18px;
  height: 18px;
  min-height: 18px;
  margin: 0;
  padding: 0;
  box-shadow: none;
}
</style>
