<script setup>
/**
 * Excel 导出面板。
 *
 * 从 RecordsPage.vue 里抽出来 —— 它有 400 多行模板、20 多个 computed，
 * 混在成绩列表里既看不清边界，也没法单独验证。抽出来之后页面只管
 * 「用哪些成绩导出」，剩下的事（范围、筛选、布局、分列、配色）全在这里。
 *
 * 对外只需要三样东西：
 *   - 当前筛选结果（范围选「当前查询」时用）
 *   - 已勾选的成绩（范围选「已选记录」时用）
 *   - 筛选是否生效（只影响文案是「当前筛选」还是「当前列表」）
 * 科目名 / 科目颜色 / 全部成绩 / 提示条都直接从 store 取。
 */
import { computed, reactive, ref, watch } from "vue";
import { Check, FileSpreadsheet, X } from "@lucide/vue";
import {
  buildExportMatrix,
  defaultMatrixFields,
  exportColumnGroups,
  exportColumnOptions,
  exportMatrixFieldOptions,
  exportRecordsToExcel,
  exportThemeOptions
} from "../services/excelExport";
import { useDialogA11y } from "../composables/useDialogA11y";
import { useTrackerStore } from "../stores/tracker";
import {
  formatDuration,
  formatScoreValue,
  normalizePaperVariant,
  normalizeScoreValue,
  readingCellText,
  recordTitle,
  recordTypeLabel,
  recordVariantLabel,
  recordYear,
  stripNoteMeta
} from "../utils/recordDisplay";

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** 页面当前筛选出来的成绩 */
  filteredRecords: { type: Array, default: () => [] },
  /** 页面里被勾选的成绩 */
  selectedRecords: { type: Array, default: () => [] },
  /** 页面筛选栏是否有生效条件，只用来决定范围按钮上的文案 */
  hasActiveFilters: { type: Boolean, default: false }
});

const emit = defineEmits(["update:modelValue"]);

const store = useTrackerStore();

const isExporting = ref(false);
// 「阅读」默认就带上：它在非英语科目里是空列，但英语成绩的分篇结果
// 只存在这条结构化数据里（备注里那块会被剥掉），不默认勾上就等于
// 用户填了、导出却没有。
const recommendedExportColumns = ["subject", "record", "scoreText", "reading", "note"];
const exportLayoutStorageKey = "exam-tracker-export-layout";
const exportMatrixFieldsStorageKey = "exam-tracker-export-matrix-fields";
const exportMatrixExcludedStorageKey = "exam-tracker-export-matrix-excluded";
const exportYearModeStorageKey = "exam-tracker-export-year-mode";
const exportLayoutOptions = [
  { value: "rows", label: "明细行", hint: "一行一条成绩，字段做列" },
  { value: "matrix", label: "按卷子分列", hint: "一套卷子占一列，竖着对比" }
];

function readExportLayout() {
  if (typeof localStorage === "undefined") return "rows";
  return localStorage.getItem(exportLayoutStorageKey) === "matrix" ? "matrix" : "rows";
}

function readExportMatrixFields() {
  const fallback = [...defaultMatrixFields];
  if (typeof localStorage === "undefined") return fallback;
  try {
    const saved = JSON.parse(localStorage.getItem(exportMatrixFieldsStorageKey) || "[]");
    const valid = Array.isArray(saved) ? saved.filter((id) => exportMatrixFieldOptions.some((field) => field.id === id)) : [];
    return valid.length ? valid : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 「按卷子分列」里被手动排除的成绩 id。
 *
 * 存的是「排除项」而不是「选中项」：新记的成绩默认就在导出里，
 * 不会因为以前挑过一次就被悄悄漏掉。
 */
function readExportMatrixExcluded() {
  if (typeof localStorage === "undefined") return [];
  try {
    const saved = JSON.parse(localStorage.getItem(exportMatrixExcludedStorageKey) || "[]");
    return Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

const exportForm = reactive({
  scope: "filtered",
  sheetMode: "single",
  layout: readExportLayout(),
  mergeYears: localStorage.getItem(exportYearModeStorageKey) === "merge",
  matrixFields: readExportMatrixFields(),
  matrixExcluded: readExportMatrixExcluded(),
  theme: "ocean",
  filename: `成绩导出-${new Date().toISOString().slice(0, 10)}`,
  includeSummary: false,
  subjectIds: [],
  recordType: "all",
  paperVariant: "all",
  columns: [...recommendedExportColumns]
});

const exportRecordTypeOptions = [
  { value: "all", label: "全部类型", hint: "试卷、习题、合成" },
  { value: "paper", label: "试卷", hint: "成套成绩" },
  { value: "exercise", label: "习题", hint: "单题或习题册" },
  { value: "composite", label: "合成", hint: "汇总成绩" }
];
const exportPaperVariantOptions = [
  { value: "all", label: "全部卷型", hint: "不限制真题/模拟" },
  { value: "true", label: "真题", hint: "历年真题" },
  { value: "mock", label: "模拟卷", hint: "模考套卷" }
];

const exportBaseRecords = computed(() => {
  // Keep dialog choices, but do not process records while the dialog is closed.
  if (!props.modelValue) return [];
  if (exportForm.scope === "selected") return props.selectedRecords;
  if (exportForm.scope === "all") return store.records;
  return props.filteredRecords;
});
const exportSourceRecords = computed(() => exportBaseRecords.value.filter(matchesExportFilters));
const exportAvailableSubjects = computed(() => {
  const counts = new Map();
  exportBaseRecords.value.forEach((record) => counts.set(record.subjectId, (counts.get(record.subjectId) || 0) + 1));
  const knownSubjects = store.subjects.filter((subject) => counts.has(subject.id)).map((subject) => ({ ...subject, count: counts.get(subject.id) }));
  const knownIds = new Set(knownSubjects.map((subject) => subject.id));
  const unknownSubjects = [...counts.entries()]
    .filter(([id]) => !knownIds.has(id))
    .map(([id, count]) => ({ id, name: store.subjectName(id), color: store.subjectColor(id), count }));
  return [...knownSubjects, ...unknownSubjects];
});
const exportSubjectCount = computed(() => new Set(exportSourceRecords.value.map((record) => record.subjectId)).size);
const exportSelectionLabel = computed(() => {
  if (exportForm.scope === "selected") return `已选 ${props.selectedRecords.length} 条`;
  if (exportForm.scope === "all") return `全部 ${store.records.length} 条`;
  return props.hasActiveFilters ? `当前筛选 ${props.filteredRecords.length} 条` : `当前列表 ${props.filteredRecords.length} 条`;
});
const exportSubjectLabel = computed(() => {
  if (!exportForm.subjectIds.length) return "全部科目";
  if (exportForm.subjectIds.length === 1) return store.subjectName(exportForm.subjectIds[0]);
  return `${exportForm.subjectIds.length} 个科目`;
});
const exportTypeLabel = computed(() => {
  const type = exportRecordTypeOptions.find((option) => option.value === exportForm.recordType)?.label || "全部类型";
  const variant = exportPaperVariantOptions.find((option) => option.value === exportForm.paperVariant)?.label || "全部卷型";
  return exportForm.paperVariant === "all" ? type : `${type} · ${variant}`;
});
const exportPreviewColumns = computed(() => exportColumnOptions.filter((column) => exportForm.columns.includes(column.id)));
const exportPreviewRecords = computed(() => [...exportSourceRecords.value].sort(compareExportRecordsByName));
const exportPreviewRows = computed(() => exportPreviewRecords.value.map((record) => buildExportPreviewRow(record)));
const exportPreviewAverageRow = computed(() => buildExportAverageRow(exportPreviewRecords.value));
const isMatrixExport = computed(() => exportForm.layout === "matrix");

/**
 * 只跟当前记录集求交集，历史遗留的排除 id 自然失效，不用额外清理。
 */
const exportMatrixExcludedIds = computed(() => {
  const known = new Set(exportPreviewRecords.value.map((record) => record.id));
  return new Set(exportForm.matrixExcluded.filter((id) => known.has(id)));
});

/** 没被排除的成绩 —— 真正会写进 Excel 的那批 */
const exportMatrixRecords = computed(() =>
  exportMatrixExcludedIds.value.size
    ? exportPreviewRecords.value.filter((record) => !exportMatrixExcludedIds.value.has(record.id))
    : exportPreviewRecords.value
);

/**
 * 选择器用「没排除任何东西」的完整矩阵，预览和导出用过滤后的矩阵。
 * 必须分成两份：某一列被清空后，如果选择器读的是过滤后的数据，
 * 那个分组会整个消失，用户就再也点不回来了。
 */
const exportMatrixAll = computed(() =>
  buildExportMatrix({
    records: exportPreviewRecords.value,
    subjects: store.subjects,
    fields: exportForm.matrixFields,
    mergeYears: exportForm.mergeYears
  })
);
const exportMatrix = computed(() =>
  buildExportMatrix({
    records: exportMatrixRecords.value,
    subjects: store.subjects,
    fields: exportForm.matrixFields,
    mergeYears: exportForm.mergeYears
  })
);
const exportMatrixGroupCount = computed(() => exportMatrix.value.groups.length);
const exportMatrixColumnCount = computed(() => exportMatrixGroupCount.value * exportMatrix.value.fields.length);
const exportMatrixExcludedCount = computed(() => exportMatrixExcludedIds.value.size);
// 把「组 × 子字段」摊平成一行表头，顺序与后端写表时完全一致
const exportMatrixColumns = computed(() =>
  exportMatrix.value.groups.flatMap((group) =>
    exportMatrix.value.fields.map((field) => ({ groupKey: group.key, fieldId: field.id, fieldLabel: field.label }))
  )
);
const exportPreviewCount = computed(() => {
  if (isMatrixExport.value) return exportMatrix.value.rows.length + (exportMatrix.value.average ? 1 : 0);
  return exportPreviewRows.value.length + (exportPreviewAverageRow.value ? 1 : 0);
});
const exportActualCount = computed(() => isMatrixExport.value ? exportMatrixRecords.value.length : exportSourceRecords.value.length);
watch(() => exportForm.mergeYears, (merge) => {
  localStorage.setItem(exportYearModeStorageKey, merge ? "merge" : "separate");
});
const exportReady = computed(() => {
  if (!exportPreviewRecords.value.length) return false;
  if (isMatrixExport.value) return exportForm.matrixFields.length > 0 && exportMatrixRecords.value.length > 0;
  return exportForm.columns.length > 0;
});
const exportLayoutHint = computed(() => {
  if (!isMatrixExport.value) return "一行一条成绩，字段作为列，适合逐条核对";
  if (!exportMatrixGroupCount.value) return "当前范围内没有可分组的数据";
  const base = `${exportMatrixGroupCount.value} 套卷子 · 每套 ${exportMatrix.value.fields.length} 列 · 共 ${exportMatrixColumnCount.value} 列`;
  return exportMatrixExcludedCount.value ? `${base} · 已排除 ${exportMatrixExcludedCount.value} 条` : base;
});

const dialogRef = ref(null);

useDialogA11y(
  computed(() => props.modelValue),
  dialogRef,
  { onClose: closeExportDialog }
);

// 科目筛选里残留的 id（比如切了导出范围之后）要跟着可用科目一起收掉
watch(exportAvailableSubjects, () => {
  if (!props.modelValue) return;
  const availableIds = new Set(exportAvailableSubjects.value.map((subject) => subject.id));
  const nextIds = exportForm.subjectIds.filter((id) => availableIds.has(id));
  if (nextIds.length !== exportForm.subjectIds.length) {
    exportForm.subjectIds = nextIds;
  }
});

function closeExportDialog() {
  if (isExporting.value) return;
  emit("update:modelValue", false);
}

function matchesExportFilters(record) {
  if (exportForm.subjectIds.length && !exportForm.subjectIds.includes(record.subjectId)) return false;
  if (exportForm.recordType !== "all" && (record.recordType || "paper") !== exportForm.recordType) return false;
  if (exportForm.paperVariant !== "all") {
    return (record.recordType || "paper") === "paper" && normalizePaperVariant(record) === exportForm.paperVariant;
  }
  return true;
}

function toggleExportSubject(subjectId) {
  exportForm.subjectIds = exportForm.subjectIds.includes(subjectId)
    ? exportForm.subjectIds.filter((id) => id !== subjectId)
    : [...exportForm.subjectIds, subjectId];
}

function clearExportSubjects() {
  exportForm.subjectIds = [];
}

function setExportRecordType(value) {
  exportForm.recordType = value;
  if (value !== "all" && value !== "paper") {
    exportForm.paperVariant = "all";
  }
}

function chooseExportPaperVariant(value) {
  if (exportForm.recordType !== "all" && exportForm.recordType !== "paper") return;
  exportForm.paperVariant = value;
}

function toggleExportColumn(columnId) {
  const next = exportForm.columns.includes(columnId)
    ? exportForm.columns.filter((id) => id !== columnId)
    : [...exportForm.columns, columnId];
  if (next.length) exportForm.columns = next;
}

function selectAllExportColumns() {
  exportForm.columns = exportColumnOptions.map((column) => column.id);
}

function resetExportColumns() {
  exportForm.columns = [...recommendedExportColumns];
}

function setExportLayout(value) {
  exportForm.layout = value === "matrix" ? "matrix" : "rows";
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(exportLayoutStorageKey, exportForm.layout);
  }
}

function toggleExportMatrixField(fieldId) {
  const next = exportForm.matrixFields.includes(fieldId)
    ? exportForm.matrixFields.filter((id) => id !== fieldId)
    : [...exportForm.matrixFields, fieldId];
  if (!next.length) return;
  // 按选项定义顺序排列，保证列的顺序稳定可预期
  exportForm.matrixFields = exportMatrixFieldOptions.filter((field) => next.includes(field.id)).map((field) => field.id);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(exportMatrixFieldsStorageKey, JSON.stringify(exportForm.matrixFields));
  }
}

function resetExportMatrixFields() {
  exportForm.matrixFields = [...defaultMatrixFields];
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(exportMatrixFieldsStorageKey, JSON.stringify(exportForm.matrixFields));
  }
}

/* ------------------------------------------------------------------ *
 * 「每列包含哪些成绩」：按列（卷子组）挑行
 * ------------------------------------------------------------------ */

function persistMatrixExcluded() {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(exportMatrixExcludedStorageKey, JSON.stringify(exportForm.matrixExcluded));
}

function isMatrixRecordExcluded(id) {
  return exportMatrixExcludedIds.value.has(id);
}

function toggleMatrixRecord(id) {
  if (!id) return;
  exportForm.matrixExcluded = exportMatrixExcludedIds.value.has(id)
    ? exportForm.matrixExcluded.filter((item) => item !== id)
    : [...exportForm.matrixExcluded, id];
  persistMatrixExcluded();
}

function groupSelectedCount(group) {
  return group.records.filter((record) => !exportMatrixExcludedIds.value.has(record.id)).length;
}

/** 这一列全部保留 */
function keepGroupRecords(group) {
  const ids = new Set(group.records.map((record) => record.id));
  exportForm.matrixExcluded = exportForm.matrixExcluded.filter((id) => !ids.has(id));
  persistMatrixExcluded();
}

/** 这一列全部去掉（分组本身仍留在选择器里，随时能点回来） */
function dropGroupRecords(group) {
  const existing = new Set(exportForm.matrixExcluded);
  const ids = group.records.map((record) => record.id).filter((id) => !existing.has(id));
  exportForm.matrixExcluded = [...exportForm.matrixExcluded, ...ids];
  persistMatrixExcluded();
}

function keepAllMatrixRecords() {
  exportForm.matrixExcluded = [];
  persistMatrixExcluded();
}

function dropAllMatrixRecords() {
  exportForm.matrixExcluded = exportMatrixAll.value.groups.flatMap((group) => group.records.map((record) => record.id));
  persistMatrixExcluded();
}

function compareExportRecordsByName(a, b) {
  return (
    String(recordTitle(a) || "").localeCompare(String(recordTitle(b) || ""), "zh-Hans-CN", {
      numeric: true,
      sensitivity: "base"
    }) ||
    String(store.subjectName(a.subjectId) || "").localeCompare(String(store.subjectName(b.subjectId) || ""), "zh-Hans-CN", {
      numeric: true,
      sensitivity: "base"
    }) ||
    String(a.date || "").localeCompare(String(b.date || "")) ||
    String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
  );
}

function buildExportPreviewRow(record) {
  const score = formatScoreValue(record.score);
  const fullScore = formatScoreValue(record.fullScore);
  return {
    id: record.id,
    subject: store.subjectName(record.subjectId),
    year: recordYear(record) || "",
    record: recordTitle(record),
    date: record.date || "",
    type: recordTypeLabel(record),
    variant: recordVariantLabel(record),
    scoreText: `${score} / ${fullScore}`,
    score,
    fullScore,
    rate: `${scorePercent(record)}%`,
    exerciseBook: record.exerciseBookName || "",
    exercisePage: record.exercisePage || "",
    exerciseQuestion: record.exerciseQuestion || "",
    duration: formatDuration(record.durationMinutes),
    reading: readingCellText(record),
    sync: record.pendingSync ? "待同步" : "已同步",
    // 备注里挂着合成来源、阅读分篇等结构化块，预览和导出文件都必须先剥掉，
    // 否则预览里会露出一串百分号编码。
    note: stripNoteMeta(record.note),
    subjectColor: store.subjectColor(record.subjectId),
    isSummary: false
  };
}

function buildExportAverageRow(records) {
  const scoredRecords = records.filter((record) => Number(record.fullScore) > 0);
  if (!records.length) return null;
  const totalScore = scoredRecords.reduce((sum, record) => sum + normalizeScoreValue(record.score), 0);
  const totalFullScore = scoredRecords.reduce((sum, record) => sum + normalizeScoreValue(record.fullScore), 0);
  const divisor = scoredRecords.length || records.length;
  const avgScore = divisor ? totalScore / divisor : 0;
  const avgFullScore = divisor ? totalFullScore / divisor : 0;
  return {
    id: "average-row",
    subject: "平均",
    year: "",
    record: "平均分",
    date: "",
    type: "",
    variant: "",
    scoreText: `${formatScoreValue(avgScore)} / ${formatScoreValue(avgFullScore)}`,
    score: formatScoreValue(avgScore),
    fullScore: formatScoreValue(avgFullScore),
    rate: totalFullScore ? `${Math.round((totalScore / totalFullScore) * 100)}%` : "0%",
    exerciseBook: "",
    exercisePage: "",
    exerciseQuestion: "",
    duration: "",
    reading: "",
    sync: "",
    note: `共 ${records.length} 条`,
    subjectColor: "#2563eb",
    isSummary: true
  };
}

function scorePercent(record) {
  const fullScore = normalizeScoreValue(record.fullScore);
  if (!fullScore) return 0;
  const rate = Math.round((normalizeScoreValue(record.score) / fullScore) * 100);
  return Math.max(0, Math.min(100, rate));
}

async function exportExcel() {
  if (isExporting.value || !exportReady.value) return;
  isExporting.value = true;
  try {
    // 「按卷子分列」走手动挑过的那批；明细行不受每列选择影响
    const recordsForExport = isMatrixExport.value ? exportMatrixRecords.value : exportPreviewRecords.value;
    await exportRecordsToExcel({
      records: recordsForExport,
      subjects: store.subjects,
      columns: exportForm.columns,
      sheetMode: exportForm.sheetMode,
      layout: exportForm.layout,
      matrixFields: exportForm.matrixFields,
      mergeYears: exportForm.mergeYears,
      theme: exportForm.theme,
      filename: exportForm.filename,
      includeSummary: exportForm.includeSummary
    });
    emit("update:modelValue", false);
    const suffix = isMatrixExport.value ? `，按 ${exportMatrixGroupCount.value} 套卷子分列` : "";
    const excludedSuffix = isMatrixExport.value && exportMatrixExcludedCount.value ? `，已排除 ${exportMatrixExcludedCount.value} 条` : "";
    store.notify(`Excel 已导出，共 ${recordsForExport.length} 条成绩${suffix}${excludedSuffix}。`, "success");
  } catch (error) {
    store.notify(error.message || "Excel 导出失败，请稍后重试。", "error", 6000);
  } finally {
    isExporting.value = false;
  }
}
</script>

<template>
  <div v-if="modelValue" class="export-dialog-backdrop" @mousedown.self="closeExportDialog">
    <section ref="dialogRef" class="export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-dialog-title">
      <div class="export-dialog-head">
        <div>
          <p class="eyebrow">在线预览</p>
          <h2 id="export-dialog-title">Excel 表格预览</h2>
          <span class="section-meta">{{ exportSelectionLabel }} · {{ exportSubjectCount }} 个科目 · 所见即所得</span>
        </div>
        <button class="icon-button" type="button" title="关闭预览" aria-label="关闭预览" @click="closeExportDialog">
          <X :size="17" />
        </button>
      </div>

      <div class="export-dialog-layout">
        <div class="export-dialog-main">
          <div class="export-summary-strip">
            <article>
              <span>预览明细</span>
              <strong>{{ exportActualCount }}</strong>
              <small>{{ exportSubjectLabel }} · {{ exportTypeLabel }}</small>
            </article>
            <article>
              <span>{{ isMatrixExport ? "分列情况" : "预览行数" }}</span>
              <strong>{{ isMatrixExport ? exportMatrixColumnCount : exportPreviewCount }}</strong>
              <small>{{ isMatrixExport ? `${exportMatrixGroupCount} 套卷子 · 每套 ${exportMatrix.fields.length} 列` : "底部附平均分" }}</small>
            </article>
          </div>

          <div class="export-option-section">
            <div class="export-option-title">
              <strong>导出范围</strong>
              <span>选择要放进文件的成绩</span>
            </div>
            <div class="export-segmented">
              <button type="button" :class="{ active: exportForm.scope === 'filtered' }" @click="exportForm.scope = 'filtered'">
                当前查询
                <small>{{ filteredRecords.length }} 条</small>
              </button>
              <button type="button" :class="{ active: exportForm.scope === 'selected' }" :disabled="!selectedRecords.length" @click="exportForm.scope = 'selected'">
                已选记录
                <small>{{ selectedRecords.length }} 条</small>
              </button>
              <button type="button" :class="{ active: exportForm.scope === 'all' }" @click="exportForm.scope = 'all'">
                全部成绩
                <small>{{ store.records.length }} 条</small>
              </button>
            </div>
          </div>

          <div class="export-option-section">
            <div class="export-option-title">
              <strong>导出筛选</strong>
              <span>可在导出前单独选择科目、试卷类型和真题 / 模拟卷</span>
            </div>
            <div class="export-filter-block">
              <div class="export-filter-head">
                <strong>科目</strong>
                <button type="button" :class="{ active: !exportForm.subjectIds.length }" @click="clearExportSubjects">
                  全部科目
                </button>
              </div>
              <div class="export-subject-grid">
                <button
                  v-for="subject in exportAvailableSubjects"
                  :key="subject.id"
                  class="export-subject-option"
                  type="button"
                  :class="{ active: exportForm.subjectIds.includes(subject.id) }"
                  :style="{ '--subject-color': subject.color }"
                  @click="toggleExportSubject(subject.id)"
                >
                  <span class="subject-dot"></span>
                  <span>{{ subject.name }}</span>
                  <small>{{ subject.count }} 条</small>
                  <Check v-if="exportForm.subjectIds.includes(subject.id)" :size="14" />
                </button>
              </div>
            </div>
            <div class="export-filter-split">
              <div class="export-filter-block">
                <div class="export-filter-head">
                  <strong>记录类型</strong>
                </div>
                <div class="export-choice-grid">
                  <button
                    v-for="option in exportRecordTypeOptions"
                    :key="option.value"
                    class="export-choice-option"
                    type="button"
                    :class="{ active: exportForm.recordType === option.value }"
                    @click="setExportRecordType(option.value)"
                  >
                    <span>{{ option.label }}</span>
                    <small>{{ option.hint }}</small>
                  </button>
                </div>
              </div>
              <div class="export-filter-block">
                <div class="export-filter-head">
                  <strong>卷型</strong>
                </div>
                <div class="export-choice-grid">
                  <button
                    v-for="option in exportPaperVariantOptions"
                    :key="option.value"
                    class="export-choice-option"
                    type="button"
                    :disabled="exportForm.recordType !== 'all' && exportForm.recordType !== 'paper'"
                    :class="{ active: exportForm.paperVariant === option.value }"
                    @click="chooseExportPaperVariant(option.value)"
                  >
                    <span>{{ option.label }}</span>
                    <small>{{ option.hint }}</small>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="export-option-section">
            <div class="export-option-title">
              <strong>工作表布局</strong>
              <span>按你习惯的方式显示单表或分科目</span>
            </div>
            <div class="export-segmented two">
              <button type="button" :class="{ active: exportForm.sheetMode === 'single' }" @click="exportForm.sheetMode = 'single'">
                单表明细
                <small>适合汇总查看</small>
              </button>
              <button type="button" :class="{ active: exportForm.sheetMode === 'subject' }" @click="exportForm.sheetMode = 'subject'">
                按科目分表
                <small>适合分类复盘</small>
              </button>
            </div>
          </div>

          <div class="export-option-section">
            <div class="export-option-title">
              <strong>表格布局</strong>
              <span>{{ exportLayoutHint }}</span>
            </div>
            <div class="export-segmented two">
              <button
                v-for="option in exportLayoutOptions"
                :key="option.value"
                type="button"
                :class="{ active: exportForm.layout === option.value }"
                @click="setExportLayout(option.value)"
              >
                {{ option.label }}
                <small>{{ option.hint }}</small>
              </button>
            </div>
          </div>

          <div v-if="isMatrixExport" class="export-option-section">
            <div class="export-option-title">
              <strong>年份识别</strong>
              <span>自动识别简称、全称与套号；没有年份的名称单独归组，不用练习日期猜年份。</span>
            </div>
            <div class="export-segmented two" role="group" aria-label="年份分组方式">
              <button type="button" :class="{ active: !exportForm.mergeYears }" :aria-pressed="!exportForm.mergeYears" @click="exportForm.mergeYears = false">
                按年份分开（推荐）<small>26张八与27张八各占一组</small>
              </button>
              <button type="button" :class="{ active: exportForm.mergeYears }" :aria-pressed="exportForm.mergeYears" @click="exportForm.mergeYears = true">
                跨年份合并<small>适合把历年真题放在同一组</small>
              </button>
            </div>
            <p class="export-recognition-example">{{ exportForm.mergeYears ? '26张八1、27张宇八套卷第2套 → 张宇八套卷' : '26张八1、2026张宇八套卷第2套 → 2026 张宇八套卷；27张八 → 2027 张宇八套卷' }}</p>
          </div>

          <div v-if="!isMatrixExport" class="export-option-section">
            <div class="export-option-title">
              <strong>导出字段</strong>
              <span>至少保留一项，可按需要精简</span>
            </div>
            <div class="export-field-actions">
              <button type="button" @click="resetExportColumns">恢复推荐</button>
              <button type="button" @click="selectAllExportColumns">全选字段</button>
            </div>
            <div class="export-field-groups">
              <div v-for="group in exportColumnGroups" :key="group.id" class="export-field-group">
                <strong>{{ group.label }}</strong>
                <div class="export-field-grid">
                  <button
                    v-for="column in group.columns"
                    :key="column.id"
                    class="export-field-option"
                    type="button"
                    :class="{ active: exportForm.columns.includes(column.id) }"
                    @click="toggleExportColumn(column.id)"
                  >
                    <span class="export-field-check">
                      <Check v-if="exportForm.columns.includes(column.id)" :size="13" />
                    </span>
                    {{ column.label }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div v-else class="export-option-section">
            <div class="export-option-title">
              <strong>每组包含</strong>
              <span>每套卷子下面并排显示的字段，至少保留一项</span>
            </div>
            <div class="export-field-actions">
              <button type="button" @click="resetExportMatrixFields">恢复推荐</button>
            </div>
            <div class="export-field-grid export-field-grid-flat">
              <button
                v-for="field in exportMatrixFieldOptions"
                :key="field.id"
                class="export-field-option"
                type="button"
                :class="{ active: exportForm.matrixFields.includes(field.id) }"
                @click="toggleExportMatrixField(field.id)"
              >
                <span class="export-field-check">
                  <Check v-if="exportForm.matrixFields.includes(field.id)" :size="13" />
                </span>
                {{ field.label }}
              </button>
            </div>
          </div>

          <div v-if="isMatrixExport" class="export-option-section">
            <div class="export-option-title">
              <strong>每列包含哪些成绩</strong>
              <span>点一下把不需要的从这一列去掉 —— 比如阅读只保留 11 年往后的，其它列同理</span>
            </div>
            <div class="export-field-actions">
              <button type="button" @click="keepAllMatrixRecords">全部保留</button>
              <button type="button" @click="dropAllMatrixRecords">全部去掉</button>
              <span v-if="exportMatrixExcludedCount" class="export-selection-note">已排除 {{ exportMatrixExcludedCount }} 条</span>
            </div>

            <div v-if="exportMatrixAll.groups.length" class="matrix-picker">
              <div v-for="group in exportMatrixAll.groups" :key="group.key" class="matrix-picker-group">
                <div class="matrix-picker-head">
                  <strong :style="{ color: group.subjectColor || undefined }">{{ group.label }}</strong>
                  <span>{{ group.subjectName }} · 已选 {{ groupSelectedCount(group) }} / {{ group.records.length }}</span>
                  <div class="matrix-picker-actions">
                    <button type="button" @click="keepGroupRecords(group)">全选</button>
                    <button type="button" @click="dropGroupRecords(group)">清空</button>
                  </div>
                </div>
                <div class="matrix-picker-chips">
                  <button
                    v-for="record in group.records"
                    :key="record.id"
                    type="button"
                    class="matrix-picker-chip"
                    :class="{ 'is-off': isMatrixRecordExcluded(record.id) }"
                    :aria-pressed="!isMatrixRecordExcluded(record.id)"
                    :title="`${recordTitle(record)} · ${record.score} / ${record.fullScore}`"
                    @click="toggleMatrixRecord(record.id)"
                  >
                    <span class="matrix-picker-check">
                      <Check v-if="!isMatrixRecordExcluded(record.id)" :size="12" />
                    </span>
                    {{ recordTitle(record) }}
                  </button>
                </div>
              </div>
            </div>
            <p v-else class="export-preview-empty">当前范围内还没有可以分组的成绩。</p>
          </div>

          <div class="export-option-section export-preview-section">
            <div class="export-option-title">
              <strong>在线表格预览</strong>
              <span v-if="isMatrixExport">{{ exportForm.mergeYears ? '同科目、同系列跨年份合并。' : '同科目、同年份、同系列合并，不同年份分开。' }}组内按套号排列，最后一行是平均分；下方预览与导出文件一致。</span>
              <span v-else>字体已加粗，科目和分数会更清楚，最后一行是平均分</span>
            </div>

            <div v-if="isMatrixExport" class="export-preview-table-wrap">
              <table v-if="exportMatrix.groups.length" class="export-preview-table export-preview-table-matrix">
                <thead>
                  <tr class="matrix-group-row">
                    <th class="matrix-index-head" rowspan="2">#</th>
                    <th
                      v-for="group in exportMatrix.groups"
                      :key="group.key"
                      :colspan="group.span"
                      class="matrix-group-head"
                      :style="{ '--subject-color': group.subjectColor || '#2563eb' }"
                      :title="`${group.subjectName} · ${group.label} · ${group.records.length} 条`"
                    >
                      <span class="matrix-group-name">{{ group.label }}</span>
                      <small>{{ group.subjectName }} · {{ group.records.length }} 条</small>
                    </th>
                  </tr>
                  <tr class="matrix-field-row">
                    <th
                      v-for="(column, index) in exportMatrixColumns"
                      :key="`${column.groupKey}-${column.fieldId}-${index}`"
                      :class="['matrix-field-head', `matrix-field-${column.fieldId}`]"
                    >
                      {{ column.fieldLabel }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in exportMatrix.rows" :key="row.key">
                    <td class="matrix-index-cell">{{ row.index }}</td>
                    <td
                      v-for="(cell, index) in row.cells"
                      :key="`${cell.groupKey}-${cell.fieldId}-${index}`"
                      :class="['preview-cell', `preview-cell-${cell.fieldId}`, { 'score-cell': cell.fieldId === 'scoreText' || cell.fieldId === 'score' }]"
                    >
                      {{ cell.text || " " }}
                    </td>
                  </tr>
                  <tr v-if="exportMatrix.average" class="summary-preview-row">
                    <td class="matrix-index-cell">平均</td>
                    <td
                      v-for="(cell, index) in exportMatrix.average.cells"
                      :key="`avg-${cell.groupKey}-${cell.fieldId}-${index}`"
                      :class="['preview-cell', `preview-cell-${cell.fieldId}`, { 'score-cell': cell.fieldId === 'scoreText' || cell.fieldId === 'score' }]"
                    >
                      {{ cell.text || " " }}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="export-preview-empty">
                <template v-if="exportMatrixAll.groups.length">所有成绩都被排除了 —— 点上面「全部保留」就能恢复。</template>
                <template v-else>当前范围内没有可以按卷子分组的数据，换成「明细行」试试。</template>
              </p>
            </div>

            <div v-else class="export-preview-table-wrap">
              <table class="export-preview-table">
                <thead>
                  <tr>
                    <th v-for="column in exportPreviewColumns" :key="column.id">{{ column.label }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in exportPreviewRows" :key="row.id">
                    <td
                      v-for="column in exportPreviewColumns"
                      :key="column.id"
                      :class="[
                        `preview-cell preview-cell-${column.id}`,
                        {
                          'subject-cell': column.id === 'subject',
                          'score-cell': column.id === 'scoreText',
                          'is-summary': row.isSummary
                        }
                      ]"
                    >
                      {{ row[column.id] ?? " " }}
                    </td>
                  </tr>
                  <tr v-if="exportPreviewAverageRow" class="summary-preview-row">
                    <td
                      v-for="column in exportPreviewColumns"
                      :key="column.id"
                      :class="[
                        `preview-cell preview-cell-${column.id}`,
                        {
                          'subject-cell': column.id === 'subject',
                          'score-cell': column.id === 'scoreText',
                          'is-summary': true
                        }
                      ]"
                    >
                      {{ exportPreviewAverageRow[column.id] ?? " " }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <aside class="export-dialog-side">
          <label class="export-input-label">
            文件名
            <input v-model.trim="exportForm.filename" placeholder="成绩导出" />
          </label>
          <div class="export-option-title">
            <strong>表格颜色</strong>
            <span>科目颜色会同步到科目列与得分率</span>
          </div>
          <div class="export-theme-list">
            <button
              v-for="theme in exportThemeOptions"
              :key="theme.id"
              class="export-theme-option"
              type="button"
              :class="{ active: exportForm.theme === theme.id }"
              @click="exportForm.theme = theme.id"
            >
              <span class="export-theme-preview" :style="{ '--theme-color': `#${theme.header}`, '--theme-accent': `#${theme.accent}` }"></span>
              <span>{{ theme.label }}</span>
              <Check v-if="exportForm.theme === theme.id" class="export-theme-selected" :size="15" />
            </button>
          </div>
          <label class="export-switch-row">
            <input v-model="exportForm.includeSummary" type="checkbox" />
            <span>
              <strong>包含导出概览</strong>
              <small>自动生成记录数量、累计分数和总体得分率</small>
            </span>
          </label>
          <div class="export-preview-card">
            <FileSpreadsheet :size="20" />
            <strong>{{ exportActualCount }} 条成绩</strong>
            <span>{{ exportSubjectLabel }} · {{ isMatrixExport ? `${exportMatrixColumnCount} 列` : `${exportForm.columns.length} 个字段` }}</span>
            <span>{{ exportForm.sheetMode === "subject" ? `${exportSubjectCount} 个科目分表` : "1 个明细表" }}</span>
            <span>{{ isMatrixExport ? `按卷子分列 · ${exportMatrixGroupCount} 套` : "明细行" }}</span>
          </div>
        </aside>
      </div>

      <div class="export-dialog-footer">
        <button class="secondary-button" type="button" :disabled="isExporting" @click="closeExportDialog">关闭</button>
        <button class="primary-button" type="button" :disabled="isExporting || !exportReady" @click="exportExcel">
          <FileSpreadsheet :size="17" />
          {{ isExporting ? "正在导出..." : "导出 Excel" }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.export-recognition-example {
  margin: 12px 0 0;
  padding: 12px 14px;
  border-left: 3px solid var(--blue);
  border-radius: var(--r-sm);
  background: var(--blue-soft);
  color: var(--ink);
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
</style>
