<script setup>
import { computed, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { ArrowLeft, Award, BookOpen, Edit3, FileText, Layers, Target, Timer, Trash2, X } from "@lucide/vue";
import RecordForm from "../components/RecordForm.vue";
import DsPageHeader from "../components/ds/DsPageHeader.vue";
import DsSection from "../components/ds/DsSection.vue";
import DsStatCard from "../components/ds/DsStatCard.vue";
import { useConfirm } from "../composables/useConfirm";
import { confirmDiscardChanges } from "../composables/useUnsavedChanges";
import { useTrackerStore } from "../stores/tracker";
import { READING_PART_FULL, formatDuration, normalizeDurationMinutes, readingCorrectTotal } from "../utils/recordDisplay";

const route = useRoute();
const router = useRouter();
const store = useTrackerStore();
const { confirm } = useConfirm();
const isEditing = ref(false);
const isRemoving = ref(false);

const record = computed(() => store.records.find((item) => item.id === route.params.id));
const relatedMistakes = computed(() => store.mistakes.filter((item) => item.sourceRecordId === route.params.id));
const recordTitle = computed(() => {
  if (!record.value) return "";
  if (record.value.recordType !== "exercise") return record.value.paperName;
  return [record.value.exerciseBookName || record.value.paperName, record.value.exercisePage ? `P${record.value.exercisePage}` : "", record.value.exerciseQuestion ? `第 ${record.value.exerciseQuestion} 题` : ""]
    .filter(Boolean)
    .join(" · ");
});
const recordVariantText = computed(() => recordVariantLabel(record.value));
const recordTypeText = computed(() => {
  if (record.value?.recordType === "composite") return "合成";
  if (record.value?.recordType === "exercise") return "习题";
  return recordVariantText.value ? `试卷 · ${recordVariantText.value}` : "试卷";
});
const recordMetaLine = computed(() =>
  record.value ? [record.value.date, recordTypeText.value, record.value.pendingSync ? "待同步" : "已同步"].filter(Boolean).join(" · ") : ""
);
const compositeSources = computed(() => store.compositeSourcesForRecord(record.value));
/** 英语阅读的 4 篇答对数；没填过就是 null，整块不渲染 */
const readingParts = computed(() => store.readingPartsForRecord(record.value));
const readingTotal = computed(() => readingCorrectTotal(readingParts.value));
const readingFullTotal = computed(() => (readingParts.value?.length || 0) * READING_PART_FULL);
const scoreRate = computed(() => {
  if (!record.value || !Number(record.value.fullScore)) return 0;
  return Math.round((Number(record.value.score || 0) / Number(record.value.fullScore)) * 100);
});
const recordStats = computed(() => {
  if (!record.value) return [];
  const items = [
    { label: "得分率", value: `${scoreRate.value}%`, hint: "本次得分占满分比例", icon: Target },
    { label: "得分", value: `${record.value.score} / ${record.value.fullScore}`, hint: "本次成绩", icon: Award },
    { label: "用时", value: formatDuration(record.value.durationMinutes), hint: "作答耗时", icon: Timer },
    { label: "类型", value: recordTypeText.value, hint: "成绩来源", icon: Layers }
  ];
  if (record.value.recordType === "exercise") {
    items.push({ label: "习题册", value: record.value.exerciseBookName || "未填写", hint: "练习出处", icon: BookOpen });
    items.push({
      label: "页码 / 题号",
      value: `${record.value.exercisePage || "--"} / ${record.value.exerciseQuestion || "--"}`,
      hint: "定位",
      icon: FileText
    });
  }
  return items;
});
const compositeSourceTotal = computed(() =>
  compositeSources.value.reduce(
    (total, item) => ({
      score: total.score + normalizeScoreValue(item.score),
      fullScore: total.fullScore + normalizeScoreValue(item.fullScore),
      durationMinutes:
        total.durationMinutes === "" || normalizeDurationMinutes(item.durationMinutes) === ""
          ? ""
          : Number(total.durationMinutes) + Number(normalizeDurationMinutes(item.durationMinutes))
    }),
    { score: 0, fullScore: 0, durationMinutes: 0 }
  )
);
async function remove() {
  if (!record.value || isRemoving.value) return;
  const ok = await confirm({
    title: "删除这条成绩？",
    message: `「${recordTitle.value}」会移入最近删除，24 小时内可以恢复。`,
    confirmText: "删除"
  });
  if (!ok) return;
  isRemoving.value = true;
  try {
    await store.removeRecord(record.value.id);
    router.push("/records");
  } finally {
    isRemoving.value = false;
  }
}

function startEdit() {
  isEditing.value = true;
}

function onSaved() {
  // 保存成功 = 用户已经表达了「这些内容我要了」，直接关，别再问。
  isEditing.value = false;
}

/**
 * 取消编辑。表单是 v-if 的，一关就被拆掉，改过但没保存的内容一起没
 * —— 以前这里是静默丢弃（错题详情页早就分成了「保存直接关 / 取消要问」，
 * 成绩详情页漏了这一步）。
 */
async function closeEdit() {
  if (!(await confirmDiscardChanges())) return;
  isEditing.value = false;
}

function normalizeScoreValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function sourceTypeText(source) {
  if (source.recordType === "composite") return "合成";
  if (source.recordType === "exercise") return "习题";
  const variant = recordVariantLabel(source);
  return variant ? `试卷 · ${variant}` : "试卷";
}

function recordVariantLabel(item) {
  if (!item || item.subjectId !== "math1" || (item.recordType || "paper") !== "paper") return "";
  const value = normalizePaperVariant(item);
  if (value === "true") return "真题";
  if (value === "mock") return "模拟卷";
  return "未分类";
}

function normalizePaperVariant(item) {
  const raw = String(item?.paperVariant || "").trim().toLowerCase();
  if (raw === "true" || raw === "mock") return raw;
  const name = String(item?.paperName || "").trim().toLowerCase();
  if (/mock|模拟|模考/.test(name)) return "mock";
  if (/真题|历年|历届/.test(name)) return "true";
  return "";
}

function sourceChanged(source) {
  return (
    Number(source.score) !== Number(source.originalScore) ||
    Number(source.fullScore) !== Number(source.originalFullScore) ||
    String(normalizeDurationMinutes(source.durationMinutes)) !== String(normalizeDurationMinutes(source.originalDurationMinutes))
  );
}
</script>

<template>
  <div class="page-stack">
    <RouterLink class="text-link" to="/records"><ArrowLeft :size="16" />返回成绩列表</RouterLink>

    <template v-if="record">
      <DsPageHeader
        :eyebrow="store.subjectName(record.subjectId)"
        :title="recordTitle"
        :description="recordMetaLine"
      >
        <template #actions>
          <button v-if="!isEditing" class="secondary-button" type="button" @click="startEdit"><Edit3 :size="16" />编辑</button>
          <button v-else class="secondary-button" type="button" @click="closeEdit"><X :size="16" />关闭</button>
          <button class="secondary-button danger-text" type="button" :disabled="isRemoving" @click="remove">
            <Trash2 :size="16" />{{ isRemoving ? "删除中..." : "删除" }}
          </button>
        </template>
      </DsPageHeader>

      <DsSection v-if="isEditing" title="编辑成绩" description="保存后会立即更新统计与趋势">
        <RecordForm :record="record" @saved="onSaved" />
      </DsSection>

      <template v-else>
        <section class="ds-stats">
          <DsStatCard
            v-for="item in recordStats"
            :key="item.label"
            :label="item.label"
            :value="item.value"
            :hint="item.hint"
            :icon="item.icon"
          />
        </section>

        <DsSection
          v-if="readingParts"
          title="英语阅读"
          :description="`4 篇 · 每篇 ${READING_PART_FULL} 题`"
        >
          <template #meta>
            <strong class="ds-section-total">{{ readingTotal }} / {{ readingFullTotal }}</strong>
          </template>
          <div class="reading-detail-grid">
            <article
              v-for="(part, index) in readingParts"
              :key="index"
              class="reading-detail-item"
              :class="{ weak: part !== null && part < READING_PART_FULL }"
            >
              <span>第 {{ index + 1 }} 篇</span>
              <strong>{{ part === null ? "—" : part }}</strong>
              <small>{{ part === null ? "未填" : `错 ${READING_PART_FULL - part}` }}</small>
            </article>
          </div>
        </DsSection>

        <DsSection
          v-if="record.recordType === 'composite'"
          title="分项构成"
          :description="compositeSources.length ? `共 ${compositeSources.length} 条来源记录` : '没有找到来源记录。'"
        >
          <template #meta>
            <strong v-if="compositeSources.length" class="ds-section-total">
              {{ compositeSourceTotal.score }} / {{ compositeSourceTotal.fullScore }}
            </strong>
          </template>
          <div v-if="compositeSources.length" class="composite-source-list detail-source-list">
            <article v-for="source in compositeSources" :key="source.id" class="detail-source-item">
              <div class="detail-source-main">
                <strong>{{ source.paperName }}</strong>
                <span>{{ store.subjectName(source.subjectId) }} · {{ sourceTypeText(source) }} · {{ source.date || "未记录日期" }}</span>
              </div>
              <div class="detail-source-score">
                <strong>{{ source.score }} / {{ source.fullScore }}</strong>
                <span>{{ formatDuration(source.durationMinutes) }}</span>
              </div>
              <i v-if="sourceChanged(source)">已自定义计入</i>
            </article>
          </div>
        </DsSection>

        <DsSection title="复盘备注" description="记录这次的问题与下一步">
          <p class="note-text">{{ store.displayRecordNote(record) || "还没有填写复盘备注。" }}</p>
        </DsSection>
      </template>
    </template>

    <DsSection title="关联错题" description="来自这条成绩的错题会出现在这里">
      <template #actions>
        <RouterLink class="text-link" to="/mistakes">新增错题</RouterLink>
      </template>
      <div class="card-list">
        <RouterLink v-for="item in relatedMistakes" :key="item.id" class="list-card" :to="`/mistakes/${item.id}`">
          <strong>{{ item.title }}</strong>
          <span>{{ item.knowledgePoint || "未填写知识点" }}</span>
        </RouterLink>
        <p v-if="!relatedMistakes.length" class="empty">这条成绩还没有关联错题。</p>
      </div>
    </DsSection>
  </div>
</template>
