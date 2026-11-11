<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import {
  AlertTriangle,
  ArrowDownUp,
  BarChart3,
  BookOpenCheck,
  Calculator,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Edit3,
  EyeOff,
  FileSpreadsheet,
  MoveRight,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Target,
  TrendingUp,
  Trash2,
  X
} from "@lucide/vue";
import ExportDialog from "../components/ExportDialog.vue";
import RecordForm from "../components/RecordForm.vue";
import DsLoadingState from "../components/ds/DsLoadingState.vue";
import DsPageHeader from "../components/ds/DsPageHeader.vue";
import DsStatCard from "../components/ds/DsStatCard.vue";
import { useConfirm } from "../composables/useConfirm";
import { useDialogA11y } from "../composables/useDialogA11y";
import { useDismissable } from "../composables/useDismissable";
import { confirmDiscardChanges } from "../composables/useUnsavedChanges";
import { useTrackerStore } from "../stores/tracker";
import { byId } from "../utils/sorting";
import {
  formatDuration,
  formatReadingParts,
  formatScoreValue,
  normalizeDurationMinutes,
  normalizePaperVariant,
  normalizeScoreValue,
  normalizeSearch,
  recordTitle,
  recordTypeLabel,
  recordVariantLabel,
  recordYear
} from "../utils/recordDisplay";

const HEALTH_IGNORE_KEY = "exam-tracker-ignored-health-issues";
const store = useTrackerStore();
const { confirm } = useConfirm();
const router = useRouter();
const page = ref(1);
const pageSize = 8;
const compositePage = ref(1);
const compositeSourceListRef = ref(null);
const sortBy = ref("date-desc");
const isSortMenuOpen = ref(false);
const sortOptions = [
  { value: "date-desc", label: "最近日期", shortLabel: "日期 ↓" },
  { value: "date-asc", label: "最早日期", shortLabel: "日期 ↑" },
  { value: "year-desc", label: "年份最新", shortLabel: "年份 ↓" },
  { value: "year-asc", label: "年份最早", shortLabel: "年份 ↑" },
  { value: "rate-desc", label: "得分率最高", shortLabel: "得分率 ↓" },
  { value: "rate-asc", label: "得分率最低", shortLabel: "得分率 ↑" },
  { value: "score-desc", label: "得分最高", shortLabel: "得分 ↓" }
];
const filters = reactive({ keyword: "", subjectId: "", paperVariant: "all" });
const draftFilters = reactive({ keyword: "", subjectId: "", paperVariant: "all" });
const showForm = ref(false);
const formPanelRef = ref(null);
const editingRecordId = ref("");
const selectedRecordIds = ref([]);
const compositeForm = reactive({ paperName: "", date: "", note: "" });
const compositeRows = reactive(Object.create(null));
const isCompositeDialogOpen = ref(false);
const isCompositeSaving = ref(false);
const isRestorePanelOpen = ref(false);
const restorePage = ref(1);
const batchSubjectId = ref("");
const isBatchWorking = ref(false);
const workingRecordActions = reactive(new Set());
const isExportDialogOpen = ref(false);
const ignoredHealthIssueIds = ref(readIgnoredHealthIssues());
const isIgnoredHealthOpen = ref(false);
const isHealthPanelExpanded = ref(false);

const paperVariantOptions = [
  { value: "all", label: "全部" },
  { value: "true", label: "真题" },
  { value: "mock", label: "模拟卷" }
];
const isMathDraftFilter = computed(() => draftFilters.subjectId === "math1");

const filteredRecords = computed(() => {
  const keyword = normalizeSearch(filters.keyword);
  return store.records
    .filter((record) => {
      if (filters.subjectId && record.subjectId !== filters.subjectId) return false;
      if (!matchesPaperVariantFilter(record)) return false;
      if (!keyword) return true;
      const subject = store.subjectName(record.subjectId);
      const haystack = normalizeSearch([
        record.paperName,
        recordTypeLabel(record),
        recordVariantLabel(record),
        record.exerciseBookName,
        record.exercisePage,
        record.exerciseQuestion,
        record.note,
        subject,
        record.score,
        record.fullScore,
        record.durationMinutes,
        formatDuration(record.durationMinutes),
        record.date,
        `${record.score}/${record.fullScore}`,
        `${record.score} / ${record.fullScore}`
      ].join(" "));
      return haystack.includes(keyword);
    })
    .sort(compareRecords);
});

const pageCount = computed(() => Math.max(1, Math.ceil(filteredRecords.value.length / pageSize)));
const pagedRecords = computed(() => filteredRecords.value.slice((page.value - 1) * pageSize, page.value * pageSize));
const currentSortOption = computed(() => sortOptions.find((option) => option.value === sortBy.value) || sortOptions[0]);
const editingRecord = computed(() => editingRecordId.value ? store.recordMap.get(editingRecordId.value) || null : null);
const hasActiveFilters = computed(() => Boolean(filters.keyword || filters.subjectId || filters.paperVariant !== "all"));
const selectableFilteredRecords = computed(() => filteredRecords.value.filter((record) => record.recordType !== "composite"));
const selectedRecords = computed(() =>
  selectedRecordIds.value
    .map((id) => store.recordMap.get(id))
    .filter((record) => record && record.recordType !== "composite")
);
const selectedIds = computed(() => new Set(selectedRecordIds.value));
const allFilteredRecordsSelected = computed(() =>
  selectedIds.value.size >= selectableFilteredRecords.value.length &&
  selectableFilteredRecords.value.length > 0 &&
  selectableFilteredRecords.value.every((record) => selectedIds.value.has(record.id))
);
const previewSelection = computed(() => selectedRecords.value.slice(0, pageSize));
const selectedSubjectCount = computed(() => new Set(selectedRecords.value.map((record) => record.subjectId)).size);
const canCreateComposite = computed(() => selectedRecords.value.length >= 2 && selectedSubjectCount.value === 1 && compositeSummary.value.fullScore > 0);
const selectedCompositeRows = computed(() => selectedRecords.value.map((record) => ({ record, draft: compositeRows[record.id] })).filter((item) => item.draft));
const compositePageCount = computed(() => Math.max(1, Math.ceil(selectedRecords.value.length / pageSize)));
const pagedCompositeRows = computed(() => selectedCompositeRows.value.slice((compositePage.value - 1) * pageSize, compositePage.value * pageSize));
const selectedAverageStats = computed(() => {
  const records = selectedRecords.value;
  const scoredRecords = records.filter((record) => normalizeScoreValue(record.fullScore) > 0);
  const totalScore = scoredRecords.reduce((sum, record) => sum + normalizeScoreValue(record.score), 0);
  const totalFullScore = scoredRecords.reduce((sum, record) => sum + normalizeScoreValue(record.fullScore), 0);
  const durations = records
    .map((record) => normalizeDurationMinutes(record.durationMinutes))
    .filter((value) => value !== "");
  const avgScore = scoredRecords.length ? totalScore / scoredRecords.length : 0;
  const avgFullScore = scoredRecords.length ? totalFullScore / scoredRecords.length : 0;
  const avgRate = totalFullScore > 0 ? Math.round((totalScore / totalFullScore) * 100) : 0;
  const avgDuration = durations.length ? Math.round(durations.reduce((sum, value) => sum + Number(value), 0) / durations.length) : "";
  const subjectName = selectedSubjectCount.value === 1 && records.length ? store.subjectName(records[0].subjectId) : "多科目";
  return {
    avgScore,
    avgFullScore,
    avgRate,
    avgDuration,
    count: records.length,
    scoredCount: scoredRecords.length,
    subjectName,
    isReady: records.length > 0 && selectedSubjectCount.value === 1 && scoredRecords.length > 0
  };
});
const compositeSummary = computed(() => {
  const score = selectedCompositeRows.value.reduce((sum, item) => sum + normalizeScoreValue(item.draft.score), 0);
  const fullScore = selectedCompositeRows.value.reduce((sum, item) => sum + normalizeScoreValue(item.draft.fullScore), 0);
  const durations = selectedCompositeRows.value.map((item) => normalizeDurationMinutes(item.draft.durationMinutes));
  const durationMinutes = durations.every((value) => value !== "") ? durations.reduce((sum, value) => sum + Number(value), 0) : "";
  return { score, fullScore, durationMinutes };
});
const latestSelectedDate = computed(() =>
  selectedRecords.value.reduce((latest, record) => record.date > latest ? record.date : latest, "") ||
  new Date().toISOString().slice(0, 10)
);
const defaultCompositeName = computed(() => {
  const year = commonYearLabel(selectedRecords.value);
  return year ? `${year} 合成成绩` : "合成成绩";
});
const dashboardStats = computed(() => {
  const records = filteredRecords.value;
  const scoredRecords = records.filter((record) => normalizeScoreValue(record.fullScore) > 0);
  const totalScore = scoredRecords.reduce((sum, record) => sum + normalizeScoreValue(record.score), 0);
  const totalFullScore = scoredRecords.reduce((sum, record) => sum + normalizeScoreValue(record.fullScore), 0);
  const scoreRate = totalFullScore > 0 ? Math.round((totalScore / totalFullScore) * 100) : 0;
  const timedDurations = records
    .map((record) => normalizeDurationMinutes(record.durationMinutes))
    .filter((value) => value !== "");
  const timedCount = timedDurations.length;
  const avgDuration = timedCount ? Math.round(timedDurations.reduce((sum, value) => sum + Number(value), 0) / timedCount) : "";
  const syncedCount = records.filter((record) => !record.pendingSync).length;
  const latestDate = records.map((record) => record.date).filter(Boolean).sort().at(-1) || "—";
  return {
    totalRecords: records.length,
    scoreRate,
    totalScore,
    totalFullScore,
    timedCount,
    avgDuration,
    syncedCount,
    latestDate
  };
});
const selectionProgress = computed(() => {
  const total = selectedRecords.value.length;
  return total >= 2 ? Math.min(100, Math.round((total / 4) * 100)) : total ? 25 : 0;
});
// 面板只在 isRestorePanelOpen 为真时显示。
//
// 以前这里写的是 `isRestorePanelOpen.value || store.deletedRecords.length > 0`，
// 于是只要最近删除里还剩一条，面板就**永远展开** —— 那个「最近删除 N」按钮
// 点下去毫无反应，用户只能看着一长串已删记录挂在成绩列表上方。
// 删除时会自动把它打开（见 deleteRecord 和批量删除），所以去掉这个兜底
// 不会丢掉「误删了怎么办」的提示。
const shouldShowRestorePanel = computed(() => isRestorePanelOpen.value);
const restorePageCount = computed(() => Math.max(1, Math.ceil(store.deletedRecords.length / pageSize)));
const pagedDeletedRecords = computed(() => store.deletedRecords.slice((restorePage.value - 1) * pageSize, restorePage.value * pageSize));
const rawHealthIssues = computed(() => buildHealthIssues());
const ignoredHealthIssues = computed(() => rawHealthIssues.value.filter((issue) => ignoredHealthIssueIds.value.includes(issue.id)));
const healthIssues = computed(() => rawHealthIssues.value.filter((issue) => !ignoredHealthIssueIds.value.includes(issue.id)));
const healthIssueCount = computed(() => healthIssues.value.reduce((sum, issue) => sum + issue.count, 0));
const ignoredHealthIssueCount = computed(() => ignoredHealthIssues.value.length);
const healthStatusText = computed(() => {
  if (healthIssueCount.value) return `${healthIssueCount.value} 个待整理点`;
  if (ignoredHealthIssueCount.value) return `已忽略 ${ignoredHealthIssueCount.value} 项`;
  return "数据状态良好";
});

watch(() => [filters.keyword, filters.subjectId, filters.paperVariant], () => {
  page.value = 1;
  if (!selectedRecordIds.value.length) return;
  const validIds = new Set(selectableFilteredRecords.value.map((record) => record.id));
  selectedRecordIds.value = selectedRecordIds.value.filter((id) => validIds.has(id));
});

watch(
  () => draftFilters.subjectId,
  () => {
    if (draftFilters.subjectId !== "math1") {
      draftFilters.paperVariant = "all";
    }
  }
);

watch(pageCount, (count) => {
  page.value = Math.min(page.value, count);
});

watch(restorePageCount, (count) => {
  restorePage.value = Math.min(restorePage.value, count);
});

watch(compositePageCount, (count) => {
  compositePage.value = Math.min(compositePage.value, count);
});

watch(compositePage, () => {
  if (!isCompositeDialogOpen.value) return;
  compositeSourceListRef.value?.focus({ preventScroll: true });
  compositeSourceListRef.value?.scrollIntoView({ block: "start" });
}, { flush: "post" });

watch(selectedRecords, (records) => {
  if (records.length !== selectedRecordIds.value.length) {
    selectedRecordIds.value = records.map((record) => record.id);
  }
  for (const id of Object.keys(compositeRows)) {
    if (!selectedIds.value.has(id)) delete compositeRows[id];
  }
  if (!records.length) isCompositeDialogOpen.value = false;
  if (!batchSubjectId.value && selectedRecords.value[0]?.subjectId) {
    batchSubjectId.value = selectedRecords.value[0].subjectId;
  }
});

function syncFiltersFromDraft() {
  filters.keyword = draftFilters.keyword;
  filters.subjectId = draftFilters.subjectId;
  filters.paperVariant = draftFilters.subjectId === "math1" ? draftFilters.paperVariant : "all";
  page.value = 1;
}

/**
 * 应用筛选。注意它顺带会**收起录入面板**（表单被 v-if 销毁，内容一起没），
 * 所以调用方要先确认过 —— 见 clearFilters / selectHealthIssue。
 */
function applyFilters() {
  syncFiltersFromDraft();
  showForm.value = false;
  editingRecordId.value = "";
}

// 筛选即时生效：下拉一改就应用；关键词输入做 260ms 防抖，避免每敲一个字都重算整张表。
// 这里只同步筛选条件，不顺手收起录入面板 —— 否则正在填的表单会被打断。
let filterTimer = null;
watch(
  () => ({ ...draftFilters }),
  (value) => {
    if (filterTimer) window.clearTimeout(filterTimer);
    if (value.keyword === filters.keyword) {
      syncFiltersFromDraft();
      return;
    }
    filterTimer = window.setTimeout(syncFiltersFromDraft, 260);
  },
  { deep: true }
);

onBeforeUnmount(() => {
  if (filterTimer) window.clearTimeout(filterTimer);
});

async function clearFilters() {
  // 先问再动 draftFilters：取消的话要「什么都没发生」，而不是筛选清了、表单还开着。
  if (showForm.value && !(await confirmDiscardChanges())) return;
  draftFilters.keyword = "";
  draftFilters.subjectId = "";
  draftFilters.paperVariant = "all";
  applyFilters();
}

/**
 * 排序比较函数。
 *
 * 每一支的最后都必须落到 byId() 上。原因：比较函数返回 0 时 Array.sort 保持
 * **输入顺序**，而输入顺序来自 IndexedDB 的读取顺序，那个顺序在不同次打开之间
 * 并不稳定。同一天考的两套卷子、同一天录入的多条成绩都会撞上这一点 ——
 * 表现是「刷新一下顺序就换了」，而且不会报错。
 * 详见 utils/sorting.js。
 */
function compareRecords(a, b) {
  if (sortBy.value === "year-desc" || sortBy.value === "year-asc") {
    const yearDiff = recordYear(a) - recordYear(b);
    return (sortBy.value === "year-desc" ? -yearDiff : yearDiff) || String(b.date || "").localeCompare(String(a.date || "")) || byId(a, b);
  }
  if (sortBy.value === "date-asc") {
    return String(a.date || "").localeCompare(String(b.date || "")) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || byId(a, b);
  }
  if (sortBy.value === "rate-desc" || sortBy.value === "rate-asc") {
    const rateDiff = scorePercent(a) - scorePercent(b);
    return (sortBy.value === "rate-desc" ? -rateDiff : rateDiff) || String(b.date || "").localeCompare(String(a.date || "")) || byId(a, b);
  }
  if (sortBy.value === "score-desc") {
    const scoreDiff = normalizeScoreValue(a.score) - normalizeScoreValue(b.score);
    return -scoreDiff || String(b.date || "").localeCompare(String(a.date || "")) || byId(a, b);
  }
  return String(b.date || "").localeCompare(String(a.date || "")) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || byId(a, b);
}

function chooseSort(value) {
  sortBy.value = value;
  page.value = 1;
  isSortMenuOpen.value = false;
}

function openExportDialog() {
  if (!store.records.length) {
    store.notify("暂无成绩可以导出。", "info");
    return;
  }
  isExportDialogOpen.value = true;
}

function startCreate() {
  editingRecordId.value = "";
  showForm.value = true;
  revealRecordForm();
}

function startEdit(record) {
  if (!record?.id || isRecordActionWorking(record, "delete")) return;
  editingRecordId.value = record.id;
  showForm.value = true;
  revealRecordForm();
}

/**
 * 关闭录入面板。以前直接关，填过的内容静默丢弃。
 */
async function closeForm() {
  if (!(await confirmDiscardChanges())) return;
  showForm.value = false;
  editingRecordId.value = "";
}

/**
 * 保存成功 —— 直接收起，**不再问**。
 *
 * 以前这里走的是 closeForm()，而 closeForm 会 confirmDiscardChanges()。
 * 当时的设想是「表单已经 resetDirty() 过了，会立刻放行」，但实测不成立：
 * 在成绩页保存一条成绩，那一刻脏标记还没被清掉，于是弹出
 * 「放弃未保存的内容？」—— 用户看到的是「明明已经存好了，还问我放不放弃」，
 * 关掉之后成绩又确实在，纯粹是惊吓。
 *
 * 首页（showRecordForm = false）、错题页、错题详情、成绩详情四个入口
 * 本来就是直接关、不经过确认，所以只有成绩页会弹。
 * 保存成功这个动作本身已经表达了「不要这些内容了」，没有问的必要。
 */
function onFormSaved() {
  showForm.value = false;
  editingRecordId.value = "";
}

function createMistakeFromRecord(record) {
  if (!record?.id || isRecordActionWorking(record, "delete")) return;
  router.push({ path: "/mistakes", query: { recordId: record.id } });
}

async function revealRecordForm() {
  await nextTick();
  formPanelRef.value?.scrollIntoView({ behavior: "instant", block: "start" });
}

async function deleteRecord(record) {
  if (!record?.id) return;
  const ok = await confirm({
    title: "删除这条成绩？",
    message: `「${recordTitle(record)}」会移入最近删除，24 小时内可以恢复。`,
    confirmText: "删除"
  });
  if (!ok) return;
  await withRecordAction(record, "delete", async () => {
    await store.removeRecord(record.id);
    selectedRecordIds.value = selectedRecordIds.value.filter((id) => id !== record.id);
    delete compositeRows[record.id];
    revealRestorePanel();
  });
}

async function withRecordAction(record, action, runner) {
  const key = recordActionKey(record, action);
  if (workingRecordActions.has(key)) return;
  workingRecordActions.add(key);
  try {
    await runner();
  } catch (error) {
    store.notify(error.message || "成绩操作失败，请稍后重试。", "error", 6000);
  } finally {
    workingRecordActions.delete(key);
  }
}

function recordActionKey(record, action) {
  return `${record?.id || "unknown"}:${action}`;
}

function isRecordActionWorking(record, action) {
  return workingRecordActions.has(recordActionKey(record, action));
}

function toggleSelect(record) {
  if (record.recordType === "composite") return;
  selectedRecordIds.value = isSelected(record.id)
    ? selectedRecordIds.value.filter((id) => id !== record.id)
    : [...selectedRecordIds.value, record.id];
}

function isSelected(id) {
  return selectedIds.value.has(id);
}

/**
 * 行选择框的可访问名称。
 *
 * 原来只有一个 title「选择为合成来源」，每一行念出来一模一样 ——
 * 读屏用户根本不知道勾的是哪条成绩。title 也不是可靠的可访问名称来源。
 */
function selectLabel(record) {
  const title = recordTitle(record);
  if (record.recordType === "composite") return `${title} 是合成成绩，不能再次作为来源`;
  return `选择 ${title} 作为合成来源`;
}

/** 英语阅读的分篇结果，没填过返回空串（不渲染标签） */
function readingLabel(record) {
  const parts = store.readingPartsForRecord(record);
  return parts ? `阅读 ${formatReadingParts(parts)}` : "";
}

function clearSelection() {
  selectedRecordIds.value = [];
  compositePage.value = 1;
  Object.keys(compositeRows).forEach((id) => delete compositeRows[id]);
  compositeForm.paperName = "";
  compositeForm.note = "";
  compositeForm.date = "";
  isCompositeDialogOpen.value = false;
}

function selectAllFilteredRecords() {
  selectedRecordIds.value = allFilteredRecordsSelected.value
    ? []
    : selectableFilteredRecords.value.map((record) => record.id);
}

function closeCompositeDialog() {
  isCompositeDialogOpen.value = false;
}

/* ------------------------------------------------------------------ *
 * 合成弹窗的键盘可达性
 * 手写弹窗只挂 role="dialog" 并不会真的限制焦点 —— Escape 关不掉、
 * Tab 能跳到被遮住的页面按钮上。导出面板在组件内部自己处理同一件事。
 * ------------------------------------------------------------------ */

const compositeDialogRef = ref(null);

useDialogA11y(isCompositeDialogOpen, compositeDialogRef, { onClose: closeCompositeDialog });

/* ------------------------------------------------------------------ *
 * 两个浮层：排序菜单、「已忽略」面板
 * 之前只能靠再点一次触发按钮来关，点别处会一直挂在那儿挡住列表。
 * ref 包住的是「触发按钮 + 浮层」整体，不能只包浮层（见 useDismissable 注释）。
 * ------------------------------------------------------------------ */

const sortMenuRef = ref(null);
const healthPanelRef = ref(null);

useDismissable(isSortMenuOpen, sortMenuRef, { onClose: () => (isSortMenuOpen.value = false) });
useDismissable(isIgnoredHealthOpen, healthPanelRef, { onClose: () => (isIgnoredHealthOpen.value = false) });

function openCompositeDialog() {
  if (selectedRecords.value.length) {
    syncCompositeRows();
    compositeForm.date = latestSelectedDate.value;
    if (!compositeForm.paperName) compositeForm.paperName = defaultCompositeName.value;
    isCompositeDialogOpen.value = true;
  }
}

function removeCompositeSource(id) {
  selectedRecordIds.value = selectedRecordIds.value.filter((selectedId) => selectedId !== id);
  delete compositeRows[id];
  if (!selectedRecordIds.value.length) {
    clearSelection();
  }
}

function syncCompositeRows(force = false) {
  selectedRecords.value.forEach((record) => {
    if (!compositeRows[record.id] || force) {
      const duration = normalizeDurationMinutes(record.durationMinutes);
      compositeRows[record.id] = {
        score: String(record.score ?? ""),
        fullScore: String(record.fullScore ?? ""),
        durationMinutes: String(duration)
      };
    }
  });
}

function resetCompositeValues() {
  if (!selectedRecords.value.length) return;
  syncCompositeRows(true);
  compositeForm.paperName = defaultCompositeName.value;
}

async function restoreDeletedRecord(entry) {
  await withRecordAction(entry, "restore", async () => {
    await store.restoreDeletedRecord(entry.id);
    if (!store.deletedRecords.length) isRestorePanelOpen.value = false;
  });
}

function toggleRestorePanel() {
  isRestorePanelOpen.value = !isRestorePanelOpen.value;
}

function revealRestorePanel() {
  restorePage.value = 1;
  isRestorePanelOpen.value = true;
}

async function batchMoveSelectedRecords() {
  if (isBatchWorking.value || !selectedRecords.value.length || !batchSubjectId.value) return;
  isBatchWorking.value = true;
  try {
    const count = await store.moveRecordsToSubject(selectedRecords.value.map((record) => record.id), batchSubjectId.value);
    if (count) store.notify(`已批量调整 ${count} 条成绩的科目。`, "success");
    else store.notify("所选成绩已在目标科目中。", "info");
  } catch (error) {
    store.notify(error.message || "批量改科目失败。", "error", 6000);
  } finally {
    isBatchWorking.value = false;
  }
}

async function batchDeleteSelectedRecords() {
  if (isBatchWorking.value || !selectedRecords.value.length) return;
  const ids = selectedRecords.value.map((record) => record.id);
  const count = ids.length;
  const ok = await confirm({
    title: `删除选中的 ${count} 条成绩？`,
    message: "这些成绩会移入最近删除，24 小时内可以逐条恢复。",
    confirmText: `删除 ${count} 条`
  });
  if (!ok) return;
  isBatchWorking.value = true;
  try {
    const removed = await store.removeRecords(ids);
    clearSelection();
    if (removed) {
      revealRestorePanel();
      store.notify(`${removed} 条成绩已移入最近删除。`, "success", 5200);
    }
  } catch (error) {
    store.notify(error.message || "批量删除失败。", "error", 6000);
  } finally {
    isBatchWorking.value = false;
  }
}

async function selectHealthIssue(issue) {
  // 「选中处理」也会收起录入面板 —— 正在填的表单要拦一下。
  if (showForm.value && !(await confirmDiscardChanges())) return;
  draftFilters.keyword = "";
  draftFilters.subjectId = "";
  draftFilters.paperVariant = "all";
  filters.keyword = "";
  filters.subjectId = "";
  filters.paperVariant = "all";
  page.value = 1;
  showForm.value = false;
  editingRecordId.value = "";
  selectedRecordIds.value = issue.records.filter((record) => record.recordType !== "composite").map((record) => record.id);
}

function ignoreHealthIssue(issue) {
  if (!issue?.id || ignoredHealthIssueIds.value.includes(issue.id)) return;
  saveIgnoredHealthIssues([...ignoredHealthIssueIds.value, issue.id]);
  store.notify(`已忽略「${issue.title}」，之后不再显示。`, "success");
}

function restoreIgnoredHealthIssue(id) {
  saveIgnoredHealthIssues(ignoredHealthIssueIds.value.filter((item) => item !== id));
}

function clearIgnoredHealthIssues() {
  saveIgnoredHealthIssues([]);
}

function readIgnoredHealthIssues() {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(HEALTH_IGNORE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function saveIgnoredHealthIssues(ids) {
  ignoredHealthIssueIds.value = [...new Set(ids)];
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(HEALTH_IGNORE_KEY, JSON.stringify(ignoredHealthIssueIds.value));
  }
}

async function createCompositeRecord() {
  if (!canCreateComposite.value || isCompositeSaving.value) return;
  // 原生表单只校验当前页的输入框，提交前同时检查其他页的草稿。
  const invalidIndex = selectedCompositeRows.value.findIndex(({ draft }) =>
    !isValidCompositeNumber(draft.score, 0.5) ||
    !isValidCompositeNumber(draft.fullScore, 0.5) ||
    !isValidCompositeNumber(draft.durationMinutes, 1)
  );
  if (invalidIndex >= 0) {
    compositePage.value = Math.floor(invalidIndex / pageSize) + 1;
    store.notify("请检查该页的分数和用时。分数以 0.5 为单位，用时为整分钟。", "error", 6000);
    return;
  }
  isCompositeSaving.value = true;
  try {
    await store.addCompositeRecord(selectedRecordIds.value, {
      paperName: compositeForm.paperName || defaultCompositeName.value,
      score: compositeSummary.value.score,
      fullScore: compositeSummary.value.fullScore,
      durationMinutes: compositeSummary.value.durationMinutes,
      date: compositeForm.date || latestSelectedDate.value,
      note: compositeForm.note,
      sources: selectedCompositeRows.value.map(({ record, draft }) => ({
        id: record.id,
        score: draft.score,
        fullScore: draft.fullScore,
        durationMinutes: draft.durationMinutes
      }))
    });
    clearSelection();
  } catch (error) {
    store.notify(error.message || "合成成绩创建失败。", "error", 6000);
  } finally {
    isCompositeSaving.value = false;
  }
}

function isValidCompositeNumber(value, step) {
  const number = Number(value);
  return number >= 0 && number % step === 0;
}

function matchesPaperVariantFilter(record) {
  if (filters.subjectId !== "math1" || filters.paperVariant === "all") return true;
  return record.subjectId === "math1" && (record.recordType || "paper") === "paper" && normalizePaperVariant(record) === filters.paperVariant;
}

function buildHealthIssues() {
  const records = store.records.filter((record) => record.recordType !== "composite");
  const issues = [];
  const untimed = records.filter((record) => normalizeDurationMinutes(record.durationMinutes) === "");
  const invalidScore = records.filter((record) => {
    const score = Number(record.score);
    const fullScore = Number(record.fullScore);
    return !Number.isFinite(score) || !Number.isFinite(fullScore) || score < 0 || fullScore <= 0 || score > fullScore;
  });
  const pendingSync = records.filter((record) => record.pendingSync);
  const exactDuplicates = duplicateGroups(records, exactRecordKey).flatMap((group) => group);
  const sameNameRecords = duplicateGroups(records, nameRecordKey)
    .filter((group) => new Set(group.map((record) => `${record.date}|${record.score}|${record.fullScore}`)).size > 1)
    .flatMap((group) => group);

  if (untimed.length) {
    // 把占比写出来：「有几条没记用时」是个数字，但「占了多少」才是能判断
    // 要不要管的依据。少了这一句，用户没法区分「偶有遗漏」和「一半都没记」。
    const untimedRate = records.length ? Math.round((untimed.length / records.length) * 100) : 0;
    issues.push({
      id: "untimed",
      title: "未记录用时",
      description: `这些成绩没有计时，会影响平均用时和节奏复盘（占全部成绩的 ${untimedRate}%）。`,
      count: untimed.length,
      tone: "blue",
      records: untimed
    });
  }
  if (invalidScore.length) {
    issues.push({
      id: "invalid-score",
      title: "分数异常",
      description: "包含得分超过满分、满分为空或负数等问题。",
      count: invalidScore.length,
      tone: "red",
      records: invalidScore
    });
  }
  if (exactDuplicates.length) {
    issues.push({
      id: "duplicates",
      title: "疑似重复",
      description: "科目、名称、日期和分数完全一致，可能是重复录入。",
      count: exactDuplicates.length,
      tone: "orange",
      records: exactDuplicates
    });
  }
  if (sameNameRecords.length) {
    issues.push({
      id: "same-name",
      title: "同名记录",
      description: "同一科目下存在同名成绩，适合检查是否需要重命名。",
      count: sameNameRecords.length,
      tone: "purple",
      records: sameNameRecords
    });
  }
  if (pendingSync.length) {
    issues.push({
      id: "pending-sync",
      title: "待同步",
      description: "这些记录还没有确认写入云端，建议稍后手动同步。",
      count: pendingSync.length,
      tone: "blue",
      records: pendingSync
    });
  }
  return issues;
}

function duplicateGroups(records, keyBuilder) {
  const groups = new Map();
  records.forEach((record) => {
    const key = keyBuilder(record);
    if (!key) return;
    groups.set(key, [...(groups.get(key) || []), record]);
  });
  return [...groups.values()].filter((group) => group.length > 1);
}

function exactRecordKey(record) {
  return [record.subjectId, record.recordType || "paper", normalizePaperVariant(record), normalizeSearch(recordTitle(record)), record.date, record.score, record.fullScore].join("|");
}

function nameRecordKey(record) {
  return [record.subjectId, record.recordType || "paper", normalizePaperVariant(record), normalizeSearch(recordTitle(record))].join("|");
}

function commonYearLabel(records) {
  const years = [...new Set(records.map((record) => String(record.paperName || "").match(/\d{2,4}/)?.[0]).filter(Boolean))];
  if (years.length !== 1) return "";
  return years[0].length === 2 ? `20${years[0]}` : years[0];
}

function subjectAccentStyle(record) {
  return { "--subject-color": store.subjectColor(record.subjectId) };
}

function scorePercent(record) {
  const fullScore = normalizeScoreValue(record.fullScore);
  if (!fullScore) return 0;
  const rate = Math.round((normalizeScoreValue(record.score) / fullScore) * 100);
  return Math.max(0, Math.min(100, rate));
}

function scoreBarStyle(record) {
  const percent = scorePercent(record);
  const subjectColor = store.subjectColor(record.subjectId);
  const performanceColor = percent >= 90 ? "#22c55e" : percent >= 60 ? "#38bdf8" : "#f97316";
  const color = `linear-gradient(90deg, ${subjectColor} 0%, ${performanceColor} 100%)`;
  return { width: `${percent}%`, background: color };
}

</script>

<template>
  <div class="page-stack">
    <DsPageHeader title="成绩工作台">
      <template #actions>
        <button class="secondary-button" type="button" @click="openExportDialog">
          <FileSpreadsheet :size="16" />
          导出 Excel
        </button>
        <button class="primary-button" type="button" @click="startCreate">
          <Plus :size="17" />
          新增成绩
        </button>
        <button v-if="hasActiveFilters" class="secondary-button" type="button" @click="clearFilters">
          <Search :size="16" />
          重置筛选
        </button>
      </template>
    </DsPageHeader>

    <section v-if="showForm" ref="formPanelRef" class="panel">
      <div class="section-head">
        <h2>{{ editingRecord ? "编辑成绩" : "新增成绩" }}</h2>
        <button class="secondary-button compact" type="button" @click="closeForm">
          <X :size="15" />
          关闭
        </button>
      </div>
      <RecordForm :key="editingRecordId || 'new-record'" :record="editingRecord" @saved="onFormSaved" />
    </section>

    <section class="ds-stats">
      <DsStatCard
        label="得分率"
        :value="dashboardStats.scoreRate"
        unit="%"
        :hint="`${dashboardStats.totalScore} / ${dashboardStats.totalFullScore} 分`"
        :icon="Target"
      />
      <DsStatCard
        label="用时记录"
        :value="dashboardStats.timedCount"
        unit="条"
        :hint="dashboardStats.avgDuration ? `${formatDuration(dashboardStats.avgDuration)} 平均` : '暂无计时'"
        :icon="Clock3"
      />
      <DsStatCard
        label="当前结果"
        :value="dashboardStats.totalRecords"
        unit="条"
        :hint="`${dashboardStats.latestDate} · ${dashboardStats.syncedCount} 条已同步`"
        :icon="BarChart3"
      />
      <DsStatCard
        label="选择分析"
        :value="selectedRecords.length"
        unit="条"
        :hint="
          selectedAverageStats.isReady
            ? `${selectedAverageStats.subjectName} 均分 ${formatScoreValue(selectedAverageStats.avgScore)}`
            : `${selectionProgress}% 进入合成准备`
        "
        :icon="TrendingUp"
      />
    </section>

    <section class="panel">
      <div class="section-head">
        <div>
          <h2>成绩筛选</h2>
          <span class="section-meta">改完立即生效 · 当前 {{ filteredRecords.length }} 条结果</span>
        </div>
        <div class="topbar-tools">
          <button class="secondary-button compact" type="button" :disabled="!selectableFilteredRecords.length" @click="selectAllFilteredRecords">
            {{ allFilteredRecordsSelected ? "取消全选" : `全选结果 ${selectableFilteredRecords.length}` }}
          </button>
          <button class="secondary-button compact" type="button" @click="startCreate">
            <Plus :size="15" />
            新增成绩
          </button>
        </div>
      </div>
      <form class="filter-bar with-actions" @submit.prevent="syncFiltersFromDraft">
        <input v-model="draftFilters.keyword" type="search" placeholder="搜索试卷名称、备注或科目" aria-label="搜索成绩" />
        <select v-model="draftFilters.subjectId" aria-label="选择科目">
          <option value="">全部科目</option>
          <option v-for="subject in store.visibleSubjects" :key="subject.id" :value="subject.id">{{ subject.name }}</option>
        </select>
        <div v-if="isMathDraftFilter" class="paper-kind-tabs compact">
          <button
            v-for="option in paperVariantOptions"
            :key="option.value"
            type="button"
            :class="{ active: draftFilters.paperVariant === option.value }"
            @click="draftFilters.paperVariant = option.value"
          >
            {{ option.label }}
          </button>
        </div>
        <button v-if="filters.keyword || filters.subjectId || filters.paperVariant !== 'all'" class="secondary-button" type="button" @click="clearFilters">
          <X :size="16" />
          清空筛选
        </button>
      </form>
      <div class="records-query-status">
        <div class="records-query-count">
          <strong>{{ filteredRecords.length }}</strong>
          <span>条成绩匹配当前查询</span>
        </div>
        <div ref="sortMenuRef" class="records-sort-menu">
          <button class="records-sort-trigger" type="button" :aria-expanded="isSortMenuOpen" aria-haspopup="menu" @click="isSortMenuOpen = !isSortMenuOpen">
            <ArrowDownUp :size="14" />
            <span>{{ currentSortOption.shortLabel }}</span>
          </button>
          <div v-if="isSortMenuOpen" class="records-sort-popover" role="menu">
            <button
              v-for="option in sortOptions"
              :key="option.value"
              type="button"
              role="menuitem"
              :class="{ active: sortBy === option.value }"
              @click="chooseSort(option.value)"
            >
              <span>{{ option.label }}</span>
              <Check v-if="sortBy === option.value" :size="14" />
            </button>
          </div>
        </div>
        <div class="records-query-chips">
          <span v-if="filters.keyword" class="query-chip">关键词：{{ filters.keyword }}</span>
          <span v-if="filters.subjectId" class="query-chip">{{ store.subjectName(filters.subjectId) }}</span>
          <span v-if="filters.paperVariant !== 'all'" class="query-chip">{{ recordVariantLabel({ subjectId: 'math1', recordType: 'paper', paperVariant: filters.paperVariant }) }}</span>
          <span v-if="!hasActiveFilters" class="query-chip neutral">显示全部成绩</span>
          <button v-if="hasActiveFilters" class="query-clear-button" type="button" @click="clearFilters">
            <X :size="13" />
            清除筛选
          </button>
        </div>
      </div>
    </section>

    <ExportDialog
      v-model="isExportDialogOpen"
      :filtered-records="filteredRecords"
      :selected-records="selectedRecords"
      :has-active-filters="hasActiveFilters"
    />

    <div v-if="isCompositeDialogOpen && selectedRecords.length" class="composite-dialog-backdrop" @mousedown.self="closeCompositeDialog">
      <section ref="compositeDialogRef" class="composite-dialog" role="dialog" aria-modal="true" aria-labelledby="composite-dialog-title">
        <div class="composite-dialog-head">
          <div>
            <p class="eyebrow">合成工具</p>
            <h2 id="composite-dialog-title">合成成绩</h2>
            <span class="section-meta">已选择 {{ selectedRecords.length }} 条分项记录</span>
          </div>
          <div class="composite-dialog-actions">
            <button class="secondary-button compact" type="button" @click="resetCompositeValues">
              <RefreshCw :size="15" />
              恢复原始值
            </button>
            <button class="secondary-button compact" type="button" @click="closeCompositeDialog">
              继续选择
            </button>
          </div>
        </div>

        <div v-if="selectedRecords.length < 2" class="inline-alert">再选择至少一条同科目记录后即可生成合成成绩。</div>
        <div v-else-if="selectedSubjectCount > 1" class="inline-alert danger">请选择同一科目的记录进行合成。</div>

        <div class="composite-total-bar">
          <article>
            <span>当前合计</span>
            <strong>{{ compositeSummary.score }} / {{ compositeSummary.fullScore }}</strong>
          </article>
          <article>
            <span>当前用时</span>
            <strong>{{ formatDuration(compositeSummary.durationMinutes) }}</strong>
          </article>
        </div>

        <form class="composite-dialog-body" @submit.prevent="createCompositeRecord">
          <div class="form-row two">
            <label>
              合成名称
              <input v-model.trim="compositeForm.paperName" :placeholder="defaultCompositeName" />
            </label>
            <label>
              日期
              <input v-model="compositeForm.date" type="date" required />
            </label>
          </div>

          <nav v-if="compositePageCount > 1" class="pager composite-source-pager" aria-label="合成来源分页">
            <button type="button" :disabled="compositePage === 1" @click="compositePage -= 1"><ChevronLeft :size="16" />上一页</button>
            <span role="status">第 {{ compositePage }} / {{ compositePageCount }} 页</span>
            <button type="button" :disabled="compositePage === compositePageCount" @click="compositePage += 1">下一页<ChevronRight :size="16" /></button>
          </nav>
          <div ref="compositeSourceListRef" class="composite-source-editor-list" role="region" aria-label="合成来源" tabindex="-1">
            <article v-for="{ record, draft } in pagedCompositeRows" :key="record.id" class="composite-source-editor">
              <div class="composite-source-title">
                <strong>{{ record.paperName }}</strong>
                <span>{{ store.subjectName(record.subjectId) }} · 原始 {{ record.score }}/{{ record.fullScore }} · {{ formatDuration(record.durationMinutes) }}</span>
              </div>
              <div class="composite-source-fields">
                <label>
                  计入得分
                  <input v-model="draft.score" type="number" min="0" step="0.5" />
                </label>
                <label>
                  计入满分
                  <input v-model="draft.fullScore" type="number" min="0" step="0.5" />
                </label>
                <label>
                  计入用时
                  <input v-model="draft.durationMinutes" type="number" min="0" step="1" />
                </label>
              </div>
              <button class="icon-button danger" type="button" title="移除此来源" @click="removeCompositeSource(record.id)">
                <X :size="15" />
              </button>
            </article>
          </div>
          <label>
            备注
            <textarea v-model.trim="compositeForm.note" rows="2"></textarea>
          </label>

          <div class="composite-dialog-footer">
            <button class="secondary-button" type="button" @click="clearSelection">取消合成</button>
            <button class="primary-button" type="submit" :disabled="!canCreateComposite || isCompositeSaving">
              <Plus :size="17" />
              {{ isCompositeSaving ? "合成中..." : "生成合成成绩" }}
            </button>
          </div>
        </form>
      </section>
    </div>

    <section class="content-grid records-content-grid">
      <div v-if="!hasActiveFilters && !showForm" class="panel record-create-hint">
        <div class="section-head">
          <h2>快速录入</h2>
        </div>
        <button class="primary-button" type="button" @click="startCreate">
          <Plus :size="17" />
          新增成绩
        </button>
      </div>
      <div class="panel panel-wide" :class="{ 'full-span': hasActiveFilters || showForm }">
        <div class="section-head">
          <h2>成绩列表</h2>
          <div class="topbar-tools">
            <span v-if="selectedRecords.length" class="selection-count">已选择 {{ selectedRecords.length }} 条</span>
            <button class="secondary-button compact" type="button" @click="toggleRestorePanel">
              <Trash2 :size="15" />
              最近删除 {{ store.deletedRecords.length }}
            </button>
            <button class="secondary-button compact" type="button" :aria-pressed="allFilteredRecordsSelected" :disabled="!selectableFilteredRecords.length" @click="selectAllFilteredRecords">
              {{ allFilteredRecordsSelected ? "取消全选" : "全选当前结果" }}
            </button>
          </div>
        </div>
        <div v-if="shouldShowRestorePanel" class="record-restore-panel">
          <div class="record-restore-head">
            <div>
              <strong>最近删除</strong>
              <span>24 小时内可以恢复，适合处理误删。</span>
            </div>
            <span>{{ store.deletedRecords.length }} 条</span>
          </div>
          <template v-if="store.deletedRecords.length">
            <div class="record-restore-list">
              <article v-for="entry in pagedDeletedRecords" :key="entry.id">
                <div>
                  <strong>{{ recordTitle(entry.record) }}</strong>
                  <span>{{ store.subjectName(entry.record.subjectId) }} · {{ entry.record.score }}/{{ entry.record.fullScore }} · 还剩约 {{ store.deletedRecordRemainingHours(entry) }} 小时</span>
                </div>
                <button class="secondary-button compact" type="button" :disabled="isRecordActionWorking(entry, 'restore')" @click="restoreDeletedRecord(entry)">恢复</button>
              </article>
            </div>
            <nav v-if="restorePageCount > 1" class="pager" aria-label="最近删除分页">
              <button type="button" :disabled="restorePage === 1" @click="restorePage -= 1"><ChevronLeft :size="16" />上一页</button>
              <span role="status">第 {{ restorePage }} / {{ restorePageCount }} 页</span>
              <button type="button" :disabled="restorePage === restorePageCount" @click="restorePage += 1">下一页<ChevronRight :size="16" /></button>
            </nav>
          </template>
          <div v-else class="record-restore-empty">
            暂无可恢复成绩。删除成绩后，这里会保留 24 小时。
          </div>
        </div>
        <div ref="healthPanelRef" class="health-check-panel">
          <div class="health-check-head">
            <div>
              <strong><ShieldCheck :size="16" />数据健康检查</strong>
              <span>{{ healthStatusText }} · 点击问题可自动选中相关成绩</span>
            </div>
            <div class="health-check-actions">
              <button v-if="ignoredHealthIssueCount" class="secondary-button compact" type="button" @click="isIgnoredHealthOpen = !isIgnoredHealthOpen">
                <EyeOff :size="15" />
                已忽略 {{ ignoredHealthIssueCount }}
              </button>
              <button v-if="healthIssueCount && isHealthPanelExpanded" class="secondary-button compact" type="button" @click="isHealthPanelExpanded = false">收起检查</button>
              <span :class="{ good: !healthIssueCount }">{{ healthIssueCount ? "需要整理" : "状态良好" }}</span>
            </div>
          </div>
          <div v-if="healthIssueCount && !isHealthPanelExpanded" class="health-check-compact">
            <span>待整理项已收起，不影响新增和编辑成绩。</span>
            <button class="secondary-button compact" type="button" @click="isHealthPanelExpanded = true">展开检查</button>
          </div>
          <div v-if="healthIssues.length && isHealthPanelExpanded" class="health-issue-grid">
            <article v-for="issue in healthIssues" :key="issue.id" class="health-issue-card" :class="`tone-${issue.tone}`">
              <div>
                <AlertTriangle v-if="issue.tone === 'red' || issue.tone === 'orange'" :size="16" />
                <CheckCircle2 v-else :size="16" />
                <strong>{{ issue.title }}</strong>
                <b>{{ issue.count }}</b>
              </div>
              <p>{{ issue.description }}</p>
              <div class="health-issue-actions">
                <button class="secondary-button compact" type="button" @click="selectHealthIssue(issue)">选中处理</button>
                <button class="secondary-button compact" type="button" @click="ignoreHealthIssue(issue)">
                  <EyeOff :size="14" />
                  忽略
                </button>
              </div>
            </article>
          </div>
          <div v-else-if="!healthIssues.length" class="health-check-empty">
            当前没有发现明显异常。保持这个状态，很漂亮。
          </div>
          <div v-if="isIgnoredHealthOpen" class="ignored-health-panel">
            <div class="ignored-health-head">
              <strong>已忽略项目</strong>
              <button class="secondary-button compact" type="button" @click="clearIgnoredHealthIssues">
                <RotateCcw :size="14" />
                恢复全部
              </button>
            </div>
            <div v-if="ignoredHealthIssues.length" class="ignored-health-list">
              <article v-for="issue in ignoredHealthIssues" :key="issue.id">
                <div>
                  <strong>{{ issue.title }}</strong>
                  <span>当前仍匹配 {{ issue.count }} 条，已隐藏。</span>
                </div>
                <button class="secondary-button compact" type="button" @click="restoreIgnoredHealthIssue(issue.id)">恢复显示</button>
              </article>
            </div>
            <div v-else class="health-check-empty">暂无仍然匹配的已忽略项目。</div>
          </div>
        </div>
        <div v-if="selectedRecords.length" class="batch-management-panel">
          <div class="batch-management-copy">
            <strong>批量管理</strong>
            <span role="status">{{ isBatchWorking ? "正在写入本地记录…" : `已选 ${selectedRecords.length} 条，可统一改科目或移入最近删除。` }}</span>
          </div>
          <select v-model="batchSubjectId" aria-label="目标科目" :disabled="isBatchWorking">
            <option value="">选择目标科目</option>
            <option v-for="subject in store.visibleSubjects" :key="subject.id" :value="subject.id">{{ subject.name }}</option>
          </select>
          <button class="secondary-button compact" type="button" :disabled="isBatchWorking || !batchSubjectId" @click="batchMoveSelectedRecords">
            <MoveRight :size="15" />
            批量改科目
          </button>
          <button class="secondary-button compact danger-text" type="button" :disabled="isBatchWorking" @click="batchDeleteSelectedRecords">
            <Trash2 :size="15" />
            批量删除
          </button>
        </div>
        <div v-if="selectedRecords.length" class="composite-selection-bar">
          <div class="composite-selection-info">
            <strong>选择分析</strong>
            <span v-if="selectedSubjectCount === 1">{{ store.subjectName(selectedRecords[0].subjectId) }} · {{ selectedRecords.length }} 条记录 · 实时计算不保存</span>
            <span v-else class="danger-text">包含多个科目，请保留同一科目来计算均分</span>
            <span v-if="selectedRecords.length > previewSelection.length">
              展示前 {{ previewSelection.length }} 条，另有 {{ selectedRecords.length - previewSelection.length }} 条已选
            </span>
          </div>
          <div class="selection-average-card" :class="{ muted: !selectedAverageStats.isReady }">
            <div class="selection-average-head">
              <span><Calculator :size="15" />实时均分</span>
              <small>{{ selectedAverageStats.subjectName }}</small>
            </div>
            <strong v-if="selectedAverageStats.isReady">
              {{ formatScoreValue(selectedAverageStats.avgScore) }} / {{ formatScoreValue(selectedAverageStats.avgFullScore) }}
            </strong>
            <strong v-else>--</strong>
            <div class="selection-average-meta">
              <span>{{ selectedAverageStats.isReady ? `${selectedAverageStats.avgRate}% 得分率` : "选择同一科目后显示" }}</span>
              <span>{{ selectedAverageStats.avgDuration ? `${formatDuration(selectedAverageStats.avgDuration)} 平均用时` : "暂无计时均值" }}</span>
            </div>
            <div class="records-progress"><i :style="{ width: `${selectedAverageStats.isReady ? selectedAverageStats.avgRate : 0}%` }"></i></div>
          </div>
          <div class="composite-selection-list">
            <button
              v-for="record in previewSelection"
              :key="record.id"
              class="selected-record-chip"
              type="button"
              title="移除此条来源"
              @click="removeCompositeSource(record.id)"
            >
              <span>{{ recordTitle(record) }}</span>
              <small>{{ formatScoreValue(record.score) }}/{{ formatScoreValue(record.fullScore) }}</small>
              <X :size="14" />
            </button>
          </div>
          <div class="composite-selection-actions">
            <button class="secondary-button compact" type="button" @click="clearSelection">清空</button>
            <button class="primary-button compact" type="button" @click="openCompositeDialog">
              <Plus :size="15" />
              进入合成
            </button>
          </div>
        </div>
        <div class="table-wrap desktop-record-table">
          <table>
            <thead>
              <tr>
                <th class="select-column">选择</th>
                <th>记录</th>
                <th>科目</th>
                <th>类型</th>
                <th>得分</th>
                <th>用时</th>
                <th>日期</th>
                <th>状态</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="record in pagedRecords"
                :key="record.id"
                class="subject-record-row"
                :class="{ 'is-selected': isSelected(record.id) }"
                :style="subjectAccentStyle(record)"
              >
                <td class="select-column">
                  <!-- 用 label 包起来：一来点单元格空白也能勾上，二来 16px 的
                       复选框本身达不到 24px 的最小点击目标。 -->
                  <label class="select-column-check">
                    <input
                      type="checkbox"
                      :checked="isSelected(record.id)"
                      :disabled="record.recordType === 'composite'"
                      :aria-label="selectLabel(record)"
                      :title="record.recordType === 'composite' ? '合成成绩不能再次作为来源' : '选择为合成来源'"
                      @change="toggleSelect(record)"
                    />
                  </label>
                </td>
                <td>
                  <RouterLink :to="`/records/${record.id}`">{{ recordTitle(record) }}</RouterLink>
                  <span v-if="recordVariantLabel(record)" class="record-variant-pill">{{ recordVariantLabel(record) }}</span>
                  <span v-if="readingLabel(record)" class="record-variant-pill reading-pill">{{ readingLabel(record) }}</span>
                </td>
                <td>
                  <span class="subject-chip">
                    <span class="subject-dot"></span>
                    {{ store.subjectName(record.subjectId) }}
                  </span>
                </td>
                <td>{{ recordTypeLabel(record) }}</td>
                <td>
                  <div class="score-cell subject-score-cell">
                    <strong>{{ record.score }} / {{ record.fullScore }}</strong>
                    <div class="progress micro"><i :style="scoreBarStyle(record)"></i></div>
                    <span>{{ scorePercent(record) }}%</span>
                  </div>
                </td>
                <td>{{ formatDuration(record.durationMinutes) }}</td>
                <td>{{ record.date }}</td>
                <td>{{ record.pendingSync ? "待同步" : "已同步" }}</td>
                <td class="table-actions">
                  <button class="icon-button" type="button" title="编辑成绩" aria-label="编辑成绩" :disabled="isRecordActionWorking(record, 'delete')" @click="startEdit(record)">
                    <Edit3 :size="15" />
                  </button>
                  <button class="icon-button" type="button" title="基于本成绩新增错题" aria-label="基于本成绩新增错题" :disabled="isRecordActionWorking(record, 'delete')" @click="createMistakeFromRecord(record)">
                    <BookOpenCheck :size="15" />
                  </button>
                  <button class="icon-button danger" type="button" title="删除成绩" aria-label="删除成绩" :disabled="isRecordActionWorking(record, 'delete')" @click="deleteRecord(record)">
                    <Trash2 :size="15" />
                  </button>
                </td>
              </tr>
              <!-- 首次读取本地库时先占位，避免表格先空一帧再填内容 -->
              <tr v-if="!store.isReady">
                <td colspan="9" class="empty-cell">
                  <DsLoadingState :rows="3" label="正在读取成绩记录…" />
                </td>
              </tr>
              <tr v-else-if="!pagedRecords.length">
                <td colspan="9" class="empty-cell">
                  <template v-if="filters.keyword || filters.subjectId || filters.paperVariant !== 'all'">
                    没有符合当前筛选的成绩。
                    <button class="text-link" type="button" @click="clearFilters">清空筛选</button>
                    可以看全部记录。
                  </template>
                  <template v-else>还没有成绩记录，点上方「新增成绩」开始第一条。</template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="mobile-record-list">
          <article
            v-for="record in pagedRecords"
            :key="record.id"
            class="record-card"
            :class="{ 'is-selected': isSelected(record.id) }"
            :style="subjectAccentStyle(record)"
          >
            <div class="record-card-top">
              <label class="record-card-check">
                <input
                  type="checkbox"
                  :checked="isSelected(record.id)"
                  :disabled="record.recordType === 'composite'"
                  :aria-label="selectLabel(record)"
                  :title="record.recordType === 'composite' ? '合成成绩不能再次作为来源' : '选择为合成来源'"
                  @change="toggleSelect(record)"
                />
              </label>
              <div class="record-card-main">
                <div class="record-card-title-row">
                  <RouterLink :to="`/records/${record.id}`">{{ recordTitle(record) }}</RouterLink>
                  <span class="record-type-pill">{{ recordTypeLabel(record) }}</span>
                  <span v-if="recordVariantLabel(record)" class="record-variant-pill">{{ recordVariantLabel(record) }}</span>
                  <span v-if="readingLabel(record)" class="record-variant-pill reading-pill">{{ readingLabel(record) }}</span>
                </div>
                <div class="record-card-meta-line">
                  <span class="subject-chip compact">
                    <span class="subject-dot"></span>
                    {{ store.subjectName(record.subjectId) }}
                  </span>
                  <span>{{ record.date }}</span>
                  <span>{{ record.pendingSync ? "待同步" : "已同步" }}</span>
                </div>
              </div>
              <div class="record-card-score subject-score-badge">
                <strong>{{ record.score }} / {{ record.fullScore }}</strong>
                <span>{{ scorePercent(record) }}%</span>
              </div>
            </div>
            <div class="record-card-progress">
              <div class="progress micro"><i :style="scoreBarStyle(record)"></i></div>
              <span>{{ formatDuration(record.durationMinutes) }}</span>
            </div>
            <div class="record-card-actions">
              <button class="icon-button" type="button" title="编辑成绩" aria-label="编辑成绩" :disabled="isRecordActionWorking(record, 'delete')" @click="startEdit(record)">
                <Edit3 :size="15" />
              </button>
              <button class="icon-button" type="button" title="基于本成绩新增错题" aria-label="基于本成绩新增错题" :disabled="isRecordActionWorking(record, 'delete')" @click="createMistakeFromRecord(record)">
                <BookOpenCheck :size="15" />
              </button>
              <button class="icon-button danger" type="button" title="删除成绩" aria-label="删除成绩" :disabled="isRecordActionWorking(record, 'delete')" @click="deleteRecord(record)">
                <Trash2 :size="15" />
              </button>
            </div>
          </article>
          <DsLoadingState v-if="!store.isReady" variant="cards" :rows="3" label="正在读取成绩记录…" />
          <div v-else-if="!pagedRecords.length" class="mobile-empty-state">
            <template v-if="filters.keyword || filters.subjectId || filters.paperVariant !== 'all'">
              没有符合当前筛选的成绩。
              <button class="text-link" type="button" @click="clearFilters">清空筛选</button>
            </template>
            <template v-else>还没有成绩记录，点上方「新增成绩」开始第一条。</template>
          </div>
        </div>
        <nav v-if="store.isReady && pageCount > 1" class="pager" aria-label="成绩列表分页">
          <button type="button" :disabled="page === 1" @click="page -= 1"><ChevronLeft :size="16" />上一页</button>
          <span role="status">第 {{ page }} / {{ pageCount }} 页</span>
          <button type="button" :disabled="page === pageCount" @click="page += 1">下一页<ChevronRight :size="16" /></button>
        </nav>
      </div>
    </section>
  </div>
</template>

<style scoped>
.composite-source-pager {
  position: sticky;
  top: 0;
  z-index: 1;
  margin: 0;
  padding-block: 0.375rem;
  background: var(--surface);
}

.composite-source-editor-list {
  scroll-margin-block-start: 3.5rem;
}
</style>
