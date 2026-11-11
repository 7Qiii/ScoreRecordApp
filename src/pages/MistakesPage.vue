<script setup>
/**
 * 错题库：按「连续复习」的思路重排。
 *
 * 和旧版的差别：
 * - 筛选即时生效，不再需要点「搜索」按钮；筛选条件写进 URL query，刷新后还在。
 * - 顶部是带数量的状态 chip，一眼看出还剩多少没掌握，点一下就是筛选。
 * - 每行可以直接切掌握状态，不用进详情页；主按钮是「复习」而不是「详情」。
 * - 排序默认按创建时间，符合「一题一题往下过」的习惯。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { BookOpenCheck, ChevronLeft, ChevronRight, Image, Inbox, Plus, Trash2 } from "@lucide/vue";
import ImageSyncQueue from "../components/ImageSyncQueue.vue";
import MistakeForm from "../components/MistakeForm.vue";
import DsEmptyState from "../components/ds/DsEmptyState.vue";
import DsFilterBar from "../components/ds/DsFilterBar.vue";
import DsLoadingState from "../components/ds/DsLoadingState.vue";
import DsPageHeader from "../components/ds/DsPageHeader.vue";
import DsSection from "../components/ds/DsSection.vue";
import { useConfirm } from "../composables/useConfirm";
import { confirmDiscardChanges } from "../composables/useUnsavedChanges";
import { useTrackerStore } from "../stores/tracker";
import {
  MISTAKE_DIFFICULTY_OPTIONS,
  MISTAKE_SORT_OPTIONS,
  MISTAKE_STATUS_OPTIONS,
  filterAndSortMistakes,
  hasActiveMistakeFilters,
  readMistakeFilters,
  readMistakePage,
  toMistakeQuery
} from "../utils/mistakeQueue";

const store = useTrackerStore();
const route = useRoute();
const router = useRouter();
const { confirm } = useConfirm();

const STATUS_OPTIONS = MISTAKE_STATUS_OPTIONS;
const DIFFICULTY_OPTIONS = MISTAKE_DIFFICULTY_OPTIONS;
const SORT_OPTIONS = MISTAKE_SORT_OPTIONS;

const filters = computed((previous) => {
  const next = readMistakeFilters(route.query);
  // 翻页只改 page，沿用现有筛选以复用已排序的结果。
  return previous && Object.keys(next).every((key) => previous[key] === next[key]) ? previous : next;
});
const showForm = ref(false);
const savingId = ref("");

/**
 * 分页。
 *
 * 以前这里把筛选结果整份渲染出来，没有上限 —— 实测 500 条错题是 12,251 个 DOM
 * 节点 / 148ms，1000 条是 24,251 个 / 278ms（还只是桌面端，手机上要再乘几倍）。
 * 成绩页一直是 8 条一页，这里对齐它。
 */
const pageSize = 8;
const resultsRef = ref(null);

/**
 * 收起 / 展开新增错题表单。收起时表单会被 v-if 拆掉，填过（甚至跑过 AI 解析）
 * 的内容一起没 —— 以前是静默丢弃。只有正在关的时候才拦。
 */
async function toggleForm() {
  if (showForm.value && !(await confirmDiscardChanges())) return;
  showForm.value = !showForm.value;
}

/**
 * 从成绩页点「基于本成绩新增错题」过来时会带上 ?recordId=xxx。
 *
 * 必须**顺手把表单打开** —— 以前只是带着 query 落到列表上，表单不开、筛选也没变，
 * 看上去就像那个按钮没反应（实测过）。要再点一次「新增错题」才看得到预填的标题。
 *
 * 读到之后立刻把它从地址里摘掉：这个页面一改筛选就会 replace 掉整个 query，
 * 顺手把 recordId 冲走；而 MistakeForm 的填充 watcher 依赖它，一冲就会重灌一遍
 * 表单，把已经填好的标题清空。摘掉之后改用 prop 传给它，就与地址无关了。
 */
const sourceRecordId = ref("");
watch(
  () => typeof route.query.recordId === "string" ? route.query.recordId : "",
  (id) => {
    if (!id) return;
    sourceRecordId.value = id;
    showForm.value = true;
    const { recordId, ...rest } = route.query;
    router.replace({ path: "/mistakes", query: rest });
  },
  { immediate: true }
);

function onMistakeSaved() {
  showForm.value = false;
  // 用掉就清掉，免得下次点「新增错题」又带出上一条成绩的标题
  sourceRecordId.value = "";
}

/** 知识点在现有数据里承担「章节」的角色，直接从已有错题里归纳 */
const knowledgePoints = computed(() => {
  const seen = new Map();
  store.mistakes.forEach((item) => {
    const value = String(item.knowledgePoint || "").trim();
    if (!value) return;
    seen.set(value, (seen.get(value) || 0) + 1);
  });
  return [...seen.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "zh-Hans-CN"));
});

const statusCounts = computed(() => {
  const counts = new Map(STATUS_OPTIONS.map((status) => [status, 0]));
  store.mistakes.forEach((item) => {
    const key = item.status || "待复盘";
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
});

const filteredMistakes = computed(() => filterAndSortMistakes(store.mistakes, filters.value, store.subjectName));
const pageCount = computed(() => Math.max(1, Math.ceil(filteredMistakes.value.length / pageSize)));
const page = computed(() => Math.min(readMistakePage(route.query), pageCount.value));
const pagedMistakes = computed(() => filteredMistakes.value.slice((page.value - 1) * pageSize, page.value * pageSize));
const imageCounts = computed(() => {
  const counts = new Map();
  for (const image of store.images) {
    if (image.ownerType !== "mistake") continue;
    counts.set(image.ownerId, (counts.get(image.ownerId) || 0) + 1);
  }
  return counts;
});

const activeFilterCount = computed(() => {
  const { keyword, subjectId, knowledgePoint, status, difficulty } = filters.value;
  return [keyword, subjectId, knowledgePoint, status, difficulty].filter(Boolean).length;
});

/**
 * 搜索框做 260ms 防抖（和成绩页同一套做法）。
 *
 * 以前是 `v-model` 直连 `filters.keyword`：每敲一个字就重算一遍全量筛选，
 * 再把所有卡片重渲染一次 —— 500 条错题实测 148ms/键，手机上会明显卡。
 * 现在输入框绑草稿，停手 260ms 之后才写进 filters。
 */
const keywordDraft = ref(filters.value.keyword);
const hasFilter = computed(() => hasActiveMistakeFilters(filters.value) || Boolean(keywordDraft.value));
let keywordTimer = null;
watch(keywordDraft, (value) => {
  window.clearTimeout(keywordTimer);
  if (value === filters.value.keyword) return;
  keywordTimer = window.setTimeout(() => {
    applyFilters({ keyword: value });
  }, 260);
});

// 外部改 filters.keyword 时（清空筛选、前进后退恢复）要把草稿跟上，
// 否则输入框显示的和实际生效的筛选会不一致。
watch(
  () => filters.value.keyword,
  (value) => {
    window.clearTimeout(keywordTimer);
    keywordDraft.value = value;
  }
);

onBeforeUnmount(() => window.clearTimeout(keywordTimer));

function applyFilters(patch) {
  window.clearTimeout(keywordTimer);
  return router.replace({
    name: "mistakes",
    query: toMistakeQuery({ ...filters.value, keyword: keywordDraft.value, ...patch })
  });
}

function applySearch(event) {
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (keywordDraft.value !== filters.value.keyword) applyFilters({ keyword: keywordDraft.value });
}

async function goToPage(nextPage) {
  const failure = await router.replace({ name: "mistakes", query: toMistakeQuery(filters.value, nextPage) });
  if (failure) return;
  await nextTick();
  resultsRef.value?.focus({ preventScroll: true });
  resultsRef.value?.scrollIntoView({ block: "start" });
}

/** 详情页带着同一套筛选条件打开，上一题/下一题才不会跑出当前队列 */
function reviewLink(id) {
  return { path: `/mistakes/${id}`, query: toMistakeQuery(filters.value, page.value) };
}

function clearFilters() {
  window.clearTimeout(keywordTimer);
  keywordDraft.value = "";
  router.replace({ name: "mistakes" });
}

function toggleStatus(status) {
  applyFilters({ status: filters.value.status === status ? "" : status });
}

async function setStatus(item, status) {
  const current = item.status || "待复盘";
  if (current === status || savingId.value) return;
  savingId.value = item.id;
  try {
    await store.updateMistake(item.id, { status, reviewedAt: new Date().toISOString() });
    if (status === "已掌握") recordReview(item.id, status);
    store.notify(`已标记为「${status}」`, "success");
  } finally {
    savingId.value = "";
  }
}

/** 复习日志只存在本地，不改动 IndexedDB 里的错题结构 */
function recordReview(id, status) {
  try {
    const key = `exam-tracker-review-log-${id}`;
    const log = JSON.parse(localStorage.getItem(key) || "[]");
    log.unshift({ at: new Date().toISOString(), status });
    localStorage.setItem(key, JSON.stringify(log.slice(0, 50)));
  } catch {
    /* 存不进去也不影响主流程 */
  }
}

async function removeMistake(item) {
  const ok = await confirm({
    title: "删除这道错题？",
    message: `「${item.title}」及其图片会一起删除，此操作不可恢复。`,
    confirmText: "删除"
  });
  if (!ok) return;
  await store.removeMistake(item.id);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
</script>

<template>
  <div class="page-stack">
    <DsPageHeader title="错题库" :description="`共 ${store.mistakes.length} 道 · 点状态直接筛选，点「复习」进入连续复习`">
      <template #actions>
        <button class="secondary-button" type="button" @click="toggleForm">
          <Plus :size="16" />
          {{ showForm ? "收起表单" : "新增错题" }}
        </button>
      </template>
    </DsPageHeader>

    <!-- 状态 chip：一眼看出还剩多少没掌握，点一下就是筛选 -->
    <DsSection title="掌握状态" description="点一下按状态筛选">
      <div class="review-status-chips">
        <button type="button" :class="{ active: !filters.status }" :aria-pressed="!filters.status" @click="applyFilters({ status: '' })">
          全部 <b>{{ store.mistakes.length }}</b>
        </button>
        <button
          v-for="status in STATUS_OPTIONS"
          :key="status"
          type="button"
          :class="{ active: filters.status === status }"
          :aria-pressed="filters.status === status"
          @click="toggleStatus(status)"
        >
          {{ status }} <b>{{ statusCounts.get(status) || 0 }}</b>
        </button>
      </div>
    </DsSection>

    <!-- 筛选栏：改完立即生效 -->
    <DsFilterBar :min-field-width="140">
      <label class="ds-field">
        <span class="ds-field-label">搜索</span>
        <input v-model.trim="keywordDraft" type="search" placeholder="题目、知识点或解析" @keydown.enter="applySearch" />
      </label>
      <label class="ds-field">
        <span class="ds-field-label">科目</span>
        <select :value="filters.subjectId" @change="applyFilters({ subjectId: $event.target.value })">
          <option value="">全部科目</option>
          <option v-for="subject in store.visibleSubjects" :key="subject.id" :value="subject.id">{{ subject.name }}</option>
        </select>
      </label>
      <label class="ds-field">
        <span class="ds-field-label">章节 / 知识点</span>
        <select :value="filters.knowledgePoint" @change="applyFilters({ knowledgePoint: $event.target.value })">
          <option value="">全部章节</option>
          <option v-for="item in knowledgePoints" :key="item.value" :value="item.value">{{ item.value }}（{{ item.count }}）</option>
        </select>
      </label>
      <label class="ds-field">
        <span class="ds-field-label">难度</span>
        <select :value="filters.difficulty" @change="applyFilters({ difficulty: $event.target.value })">
          <option value="">全部难度</option>
          <option v-for="item in DIFFICULTY_OPTIONS" :key="item" :value="item">{{ item }}</option>
        </select>
      </label>
      <label class="ds-field">
        <span class="ds-field-label">排序</span>
        <select :value="filters.sort" @change="applyFilters({ sort: $event.target.value })">
          <option v-for="item in SORT_OPTIONS" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
      </label>

      <template #actions>
        <button v-if="hasFilter" class="secondary-button" type="button" @click="clearFilters">清空筛选</button>
      </template>

      <template #meta>
        <span v-if="!store.isReady">正在读取…</span>
        <span v-else role="status">{{ filteredMistakes.length }} 条结果{{ activeFilterCount ? ` · 已应用 ${activeFilterCount} 个筛选` : "" }}</span>
        <span>{{ store.imageStorageStats.count }} 张图 / {{ store.imageStorageStats.label }}</span>
      </template>
    </DsFilterBar>

    <ImageSyncQueue />

    <DsSection v-if="showForm" title="新增错题" description="支持图片上传与 AI 解析">
      <MistakeForm :source-record-id="sourceRecordId" @saved="onMistakeSaved" />
    </DsSection>

    <!-- 复习列表 -->
    <!-- 数据来自本地 IndexedDB，通常是瞬时读完，但首次打开仍可能有一帧空白，
         这里用骨架屏顶上，避免先闪一下「错题库还是空的」再跳出内容。 -->
    <DsLoadingState v-if="!store.isReady" variant="cards" :rows="4" label="正在读取错题库…" />
    <template v-else-if="filteredMistakes.length">
      <div ref="resultsRef" class="ds-card-list mistake-results" role="region" aria-label="错题列表" tabindex="-1">
        <article v-for="item in pagedMistakes" :key="item.id" class="review-card">
          <RouterLink class="review-card-main" :to="reviewLink(item.id)">
            <span class="review-card-title">{{ item.title }}</span>
            <span class="review-card-meta">
              <span>{{ store.subjectName(item.subjectId) }}</span>
              <span>{{ item.knowledgePoint || "未分类知识点" }}</span>
              <span>{{ item.difficulty || "难度未填" }}</span>
              <span>{{ formatDate(item.createdAt) }} 创建</span>
              <span v-if="imageCounts.has(item.id)"><Image :size="13" /> {{ imageCounts.get(item.id) }} 张图</span>
              <span v-if="item.analysis">已写解析</span>
              <span v-else>待补解析</span>
            </span>
          </RouterLink>

          <div class="review-card-side">
            <div class="review-status-switch" role="group" aria-label="掌握状态">
              <button
                v-for="status in STATUS_OPTIONS"
                :key="status"
                type="button"
                :class="{ active: (item.status || '待复盘') === status }"
                :aria-pressed="(item.status || '待复盘') === status"
                :disabled="Boolean(savingId)"
                @click="setStatus(item, status)"
              >
                {{ status }}
              </button>
            </div>
            <RouterLink class="secondary-button compact" :to="reviewLink(item.id)">复习</RouterLink>
            <button class="icon-button danger" type="button" title="删除错题" aria-label="删除错题" @click="removeMistake(item)">
              <Trash2 :size="15" />
            </button>
          </div>
        </article>
      </div>

      <!-- 分页：和成绩页共用同一套 .pager 样式 -->
      <nav v-if="pageCount > 1" class="pager" aria-label="错题列表分页">
        <button type="button" :disabled="page === 1" @click="goToPage(page - 1)"><ChevronLeft :size="16" />上一页</button>
        <span role="status">第 {{ page }} / {{ pageCount }} 页</span>
        <button type="button" :disabled="page === pageCount" @click="goToPage(page + 1)">下一页<ChevronRight :size="16" /></button>
      </nav>
    </template>

    <DsEmptyState
      v-else
      :icon="store.mistakes.length ? Inbox : BookOpenCheck"
      :title="store.mistakes.length ? '没有符合条件的错题' : '错题库还是空的'"
      :description="
        store.mistakes.length ? '换个状态或清空筛选看看。' : '记录错题后，可以在这里按科目和章节连续复习。'
      "
    >
      <template #action>
        <button v-if="store.mistakes.length" class="secondary-button" type="button" @click="clearFilters">清空筛选</button>
        <button v-else class="primary-button" type="button" @click="showForm = true"><Plus :size="16" />新增错题</button>
      </template>
    </DsEmptyState>
  </div>
</template>

<style scoped>
.mistake-results {
  scroll-margin-block-start: 1rem;
}
</style>
