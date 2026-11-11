<script setup>
import { computed, ref } from "vue";
import { BookOpenCheck, ClipboardList, Database, Download, FolderCog, HardDrive, ShieldCheck, Trash2, Upload } from "@lucide/vue";
import { useTrackerStore } from "../stores/tracker";
import BackupImportControl from "../components/BackupImportControl.vue";
import DsPageHeader from "../components/ds/DsPageHeader.vue";
import DsSection from "../components/ds/DsSection.vue";
import DsStatCard from "../components/ds/DsStatCard.vue";
import { downloadBackup } from "../utils/downloadBackup";

const store = useTrackerStore();
const confirmText = ref("");
const message = ref("");
const error = ref("");
const clearing = ref(false);

const totals = computed(() => [
  { label: "科目", value: store.subjects.length, unit: "个", icon: FolderCog },
  { label: "成绩", value: store.records.length, unit: "条", icon: ClipboardList },
  { label: "错题", value: store.mistakes.length, unit: "条", icon: BookOpenCheck },
  { label: "图片", value: store.imageStorageStats.count, unit: "张", icon: HardDrive }
]);
const hasData = computed(() => Boolean(store.records.length || store.mistakes.length || store.images.length));
const backupAgeDays = computed(() => {
  if (!store.lastBackupAt) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - new Date(store.lastBackupAt).getTime()) / 86400000);
});
const backupHint = computed(() => {
  if (!hasData.value) return "当前还没有需要备份的数据。";
  if (!store.lastBackupAt) return "还没有导出过备份，建议先生成一份。";
  if (backupAgeDays.value >= 7) return `上次备份是 ${backupAgeDays.value} 天前，建议更新。`;
  return `上次备份：${new Date(store.lastBackupAt).toLocaleString("zh-CN")}`;
});
const shouldBackup = computed(() => hasData.value && (backupAgeDays.value >= 7 || !store.lastBackupAt));

async function exportData() {
  message.value = "";
  error.value = "";
  try {
    await downloadBackup(store);
    message.value = "备份文件已生成。";
  } catch (cause) {
    console.error(cause);
    error.value = "无法导出当前档案，请检查浏览器存储后重试。";
  }
}

function onImportCompleted(text, warning) {
  message.value = warning ? "" : text;
  error.value = warning ? text : "";
}

function onImportFailed(text) {
  message.value = "";
  error.value = text;
}

async function clearData() {
  if (clearing.value || !store.canReplaceBackup) return;
  message.value = "";
  error.value = "";
  if (confirmText.value !== "清空") {
    error.value = "请输入“清空”后再执行。";
    return;
  }
  clearing.value = true;
  try {
    await store.clearAll();
    confirmText.value = "";
    message.value = "成绩、错题、图片和最近删除中的可恢复内容已清空，科目配置保留。";
  } catch (cause) {
    console.error(cause);
    error.value = "清空未完成，请检查浏览器存储后重试。";
  } finally {
    clearing.value = false;
  }
}
</script>

<template>
  <div class="page-stack">
    <DsPageHeader title="备份与恢复" :description="backupHint">
      <template #actions>
        <button class="primary-button" type="button" @click="exportData">
          <Download :size="17" />
          导出备份
        </button>
      </template>
    </DsPageHeader>

    <div class="backup-mini-actions">
      <span class="detail-pill">{{ hasData ? "可导出当前本地档案" : "当前没有可备份内容" }}</span>
      <span class="detail-pill">{{ store.imageStorageStats.count }} 张图片 · {{ store.imageStorageStats.label }}</span>
    </div>

    <div v-if="shouldBackup" class="inline-alert">
      数据越多越值得定期备份。建议每周导出一份 JSON，尤其是错题图片较多时。
    </div>

    <section class="ds-stats">
      <DsStatCard
        v-for="item in totals"
        :key="item.label"
        :label="item.label"
        :value="item.value"
        :unit="item.unit"
        :icon="item.icon"
        hint="当前本地档案"
      />
    </section>

    <section class="content-grid">
      <DsSection title="导入恢复" description="先查看预览，再确认写入">
        <BackupImportControl v-slot="{ choose, busy }" @completed="onImportCompleted" @failed="onImportFailed">
          <div class="action-stack">
            <button class="secondary-button" type="button" :disabled="busy || clearing" @click="choose('merge')">
              <Upload :size="17" />
              合并导入
            </button>
            <button class="secondary-button" type="button" :disabled="busy || clearing || !store.canReplaceBackup" @click="choose('replace')">
              <Database :size="17" />
              覆盖恢复
            </button>
            <p class="form-tip">
              <ShieldCheck :size="16" />
              {{ store.canReplaceBackup ? "合并会保留较新的本机记录。覆盖会替换本机档案。" : "当前环境已配置云同步，仅支持合并导入。" }}
            </p>
          </div>
        </BackupImportControl>
      </DsSection>

      <DsSection title="危险操作" description="清空本机数据和可恢复快照，保留科目配置">
        <div class="form-grid">
          <label>
            输入“清空”确认
            <input v-model.trim="confirmText" placeholder="清空" :disabled="clearing || !store.canReplaceBackup" />
          </label>
          <button class="secondary-button danger-text" type="button" :disabled="clearing || !store.canReplaceBackup" @click="clearData">
            <Trash2 :size="17" />
            {{ clearing ? "正在清空…" : "清空成绩、错题和图片" }}
          </button>
          <p v-if="!store.canReplaceBackup" class="ds-muted">配置云同步的环境暂不支持清空。</p>
        </div>
      </DsSection>
    </section>

    <div v-if="message || error" class="inline-alert" :class="{ danger: error }" :role="error ? 'alert' : 'status'">
      {{ error || message }}
    </div>
  </div>
</template>
