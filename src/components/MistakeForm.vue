<script setup>
import { computed, reactive, ref, watch } from "vue";
import { BookOpenCheck, Save, Sparkles, Trash2, X } from "@lucide/vue";
import ImageUploader from "./ImageUploader.vue";
import { useUnsavedFields } from "../composables/useUnsavedChanges";
import { useTrackerStore } from "../stores/tracker";
import { analyzeMistakeImage, analyzeMistakeImageUrl } from "../services/aiReview";
import { MISTAKE_DIFFICULTY_OPTIONS } from "../utils/mistakeQueue";

const props = defineProps({
  mistake: { type: Object, default: null },
  /**
   * 「基于某条成绩新增错题」时传进来的成绩 id，用来预填标题和科目。
   *
   * 做成 prop 而不是自己去读 route.query：地址栏里的 query 随时会被别的东西
   * 冲掉（这个页面一改筛选就会 replace 掉整个 query），而它一变下面那个
   * 填充 watcher 就会重跑一遍，把已经填好的内容清空。让页面「读到就摘掉」
   * 反而更稳 —— 见 MistakesPage。
   */
  sourceRecordId: { type: String, default: "" }
});

const emit = defineEmits(["saved"]);
const store = useTrackerStore();
const files = ref([]);
const uploaderResetKey = ref(0);
const isSaving = ref(false);
const isAnalyzing = ref(false);
const aiMessage = ref("");
const formError = ref("");
const focusedField = ref("");
const hiddenHistory = ref(readHiddenHistory());

const form = reactive({
  subjectId: "",
  title: "",
  knowledgePoint: "",
  reason: "concept",
  status: "待复盘",
  difficulty: "中等",
  sourceRecordId: "",
  questionText: "",
  analysis: "",
  nextReviewAt: ""
});

/* ------------------------------------------------------------------ *
 * 「填了一半」保护
 *
 * 错题表单比成绩表单更容易被误关，因为它的成本更高：要传图、要跑一次
 * AI 解析。而 AI 解析是**代码写进去的**（analyzeWithAi 直接改
 * form.title / questionText / analysis），一个 input 事件都没有 ——
 * 所以判脏只能比字段值，不能看事件。
 *
 * 只列用户真正会输入 / 会由 AI 填进来的字段。科目、理由、状态、难度、
 * 关联成绩都是自动填的（见下面那个 watcher），算进去会让表单一打开就是脏的。
 * 图片单独算一路：它是「已选但未保存」的文件，不在 form 里。
 * ------------------------------------------------------------------ */
const { isDirty, resetDirty } = useUnsavedFields(
  form,
  ["title", "knowledgePoint", "questionText", "analysis", "nextReviewAt"],
  { extraDirty: () => files.value.length > 0 }
);

const relatedImages = computed(() => (props.mistake ? store.images.filter((image) => image.ownerType === "mistake" && image.ownerId === props.mistake.id) : []));
const aiAvailable = computed(() => Boolean(files.value.length || relatedImages.value.some((image) => image.url || image.blob)));
const sourceRecord = computed(() => {
  const id = props.mistake?.sourceRecordId || props.sourceRecordId || form.sourceRecordId;
  return store.records.find((record) => record.id === id) || null;
});
const titleHistory = computed(() => visibleHistory("title", store.mistakes.map((mistake) => mistake.title)));
const knowledgeHistory = computed(() => visibleHistory("knowledgePoint", store.mistakes.map((mistake) => mistake.knowledgePoint)));
const analysisHistory = computed(() => visibleHistory("analysis", store.mistakes.map((mistake) => mistake.analysis), 5));

function setFiles(nextFiles) {
  files.value = nextFiles;
}

function uniqueHistory(values, limit = 8) {
  const seen = new Set();
  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function visibleHistory(field, values, limit = 8) {
  const hidden = new Set(hiddenHistory.value[field] || []);
  return uniqueHistory(values, 50).filter((value) => !hidden.has(value)).slice(0, limit);
}

function setSuggestion(field, value) {
  form[field] = value;
  focusedField.value = "";
}

function closeSuggestionsSoon() {
  window.setTimeout(() => {
    focusedField.value = "";
  }, 120);
}

function removeHistoryItem(field, value) {
  const next = {
    ...hiddenHistory.value,
    [field]: [...new Set([...(hiddenHistory.value[field] || []), value])]
  };
  hiddenHistory.value = next;
  writeHiddenHistory(next);
}

function clearHistory(field, values) {
  const next = {
    ...hiddenHistory.value,
    [field]: [...new Set([...(hiddenHistory.value[field] || []), ...values])]
  };
  hiddenHistory.value = next;
  focusedField.value = "";
  writeHiddenHistory(next);
}

function readHiddenHistory() {
  if (typeof localStorage === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem("exam-tracker-hidden-mistake-history") || "{}");
  } catch {
    return {};
  }
}

function writeHiddenHistory(value) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem("exam-tracker-hidden-mistake-history", JSON.stringify(value));
}

async function analyzeWithAi() {
  const source = getAiImageSource();
  if (!source) {
    aiMessage.value = "请先上传一张错题图片。";
    return;
  }
  isAnalyzing.value = true;
  aiMessage.value = "";
  try {
    const context = {
      subjectName: store.subjectName(form.subjectId),
      currentTitle: form.title,
      currentKnowledgePoint: form.knowledgePoint,
      currentAnalysis: form.analysis
    };
    const result = source.type === "url" ? await analyzeMistakeImageUrl(source.value, context) : await analyzeMistakeImage(source.value, context);
    form.title = result.title || form.title;
    form.knowledgePoint = result.knowledgePoint || form.knowledgePoint;
    form.questionText = result.questionText || form.questionText;
    form.analysis = result.analysis || form.analysis;
    aiMessage.value = "AI 解析已填入表单，请检查后保存。";
  } catch (error) {
    aiMessage.value = readableAiError(error);
  } finally {
    isAnalyzing.value = false;
  }
}

function getAiImageSource() {
  if (files.value[0]) return { type: "file", value: files.value[0] };
  const existing = relatedImages.value.find((image) => image.url || image.blob);
  if (!existing) return null;
  if (existing.url) return { type: "url", value: existing.url };
  return { type: "file", value: existing.blob };
}

function readableAiError(error) {
  const message = String(error?.message || "");
  const parsed = parseErrorMessage(message);
  if (parsed) return `AI 解析失败：${parsed}`;
  if (/OPENAI_API_KEY/i.test(message)) return "AI 服务还没有配置 API Key。";
  if (/Missing auth token|Invalid auth token|401/i.test(message)) return "请先登录后使用 AI 解析。";
  if (/too large/i.test(message)) return "图片过大，请裁剪后再试。";
  return "AI 解析失败，请稍后再试。";
}

function parseErrorMessage(message) {
  try {
    const parsed = JSON.parse(message);
    if (typeof parsed.error === "string") return parsed.error;
    return parsed.error?.message || parsed.message || "";
  } catch {
    return "";
  }
}

/** 已经灌进表单的「源」。只有它变了才重新灌，见下面。 */
let appliedSourceKey = null;

watch(
  () => [store.visibleSubjects, props.mistake, props.sourceRecordId, store.records.length],
  () => {
    const source = props.mistake || {};
    const queryRecord = !props.mistake && props.sourceRecordId ? store.records.find((record) => record.id === props.sourceRecordId) : null;

    const sourceKey = `${props.mistake?.id || "new"}|${props.sourceRecordId || ""}`;
    // 源没变、但源里的东西还没到位：直接打开 /mistakes?recordId=xxx 时成绩表可能还没加载完。
    // 这种情况只在**表单还没脏**的时候重试一次，否则会把用户已经输入的内容冲掉。
    const waitingForSource = !props.mistake && Boolean(props.sourceRecordId) && !queryRecord && !isDirty.value;

    if (sourceKey === appliedSourceKey && !waitingForSource) {
      // 源没变就一个字段都不动。
      //
      // 以前这里是无条件重灌：后台同步拉回一条成绩（records.length 变了）、
      // 或者科目表被重新赋值（visibleSubjects 重算），都会把用户正在输入的内容
      // 冲掉 —— 实测标题会直接变回空。只补一个「还没填上」的默认科目。
      if (!form.subjectId) form.subjectId = source.subjectId || store.visibleSubjects[0]?.id || "";
      return;
    }
    appliedSourceKey = sourceKey;

    form.subjectId = source.subjectId || store.visibleSubjects[0]?.id || "";
    form.title = source.title || "";
    form.knowledgePoint = source.knowledgePoint || "";
    form.reason = source.reason || "concept";
    form.status = source.status || "待复盘";
    form.difficulty = source.difficulty || "中等";
    form.sourceRecordId = source.sourceRecordId || queryRecord?.id || "";
    form.questionText = source.questionText || "";
    form.analysis = source.analysis || "";
    form.nextReviewAt = source.nextReviewAt || "";
    if (queryRecord) {
      form.subjectId = queryRecord.subjectId;
      form.title = queryRecord.paperName ? `${queryRecord.paperName} 错题` : form.title;
    }
    // 源换了 → 表单现在就是源的样子，**无条件**重记基线。
    // 一来从成绩页点「基于本成绩新增错题」过来时标题是自动填的（`xxx 错题`），
    // 二来换了一道题之后如果不重记，表单会一直显示「有未保存内容」。
    resetDirty();
  },
  { immediate: true, deep: true }
);

async function submit() {
  formError.value = "";
  if (!form.title.trim()) {
    formError.value = "请先填写错题标题。";
    return;
  }
  isSaving.value = true;
  try {
    if (props.mistake) {
      await store.updateMistake(props.mistake.id, { ...form }, files.value);
    } else {
      await store.addMistake({ ...form }, files.value);
      form.title = "";
      form.knowledgePoint = "";
      form.questionText = "";
      form.analysis = "";
      form.nextReviewAt = "";
    }
    files.value = [];
    uploaderResetKey.value += 1;
    // 存完了就不算「未保存」了。父组件接下来会同步地关掉表单并问一句
    // confirmDiscardChanges()，所以必须在 emit 之前重置（见 useUnsavedForm 里
    // flush: "sync" 那段说明）。
    resetDirty();
    emit("saved");
  } catch (error) {
    store.notify(error.message || "错题保存失败。", "error", 6000);
  } finally {
    isSaving.value = false;
  }
}
</script>

<template>
  <form class="form-grid" @submit.prevent="submit">
    <div v-if="formError" class="inline-alert danger">{{ formError }}</div>
    <div class="form-row two">
      <label>
        科目
        <select v-model="form.subjectId" required>
          <option v-for="subject in store.visibleSubjects" :key="subject.id" :value="subject.id">{{ subject.name }}</option>
        </select>
      </label>
      <label>
        知识点
        <input v-model.trim="form.knowledgePoint" @focus="focusedField = 'knowledgePoint'" @blur="closeSuggestionsSoon" />
        <div v-if="focusedField === 'knowledgePoint' && knowledgeHistory.length" class="field-suggestions">
          <div class="field-suggestions-head">
            <span>历史记录</span>
            <button type="button" @mousedown.prevent="clearHistory('knowledgePoint', knowledgeHistory)">
              <Trash2 :size="13" />
              清空
            </button>
          </div>
          <div v-for="item in knowledgeHistory" :key="item" class="field-suggestion-row">
            <button type="button" @mousedown.prevent="setSuggestion('knowledgePoint', item)">{{ item }}</button>
            <button type="button" title="删除此条历史" @mousedown.prevent="removeHistoryItem('knowledgePoint', item)">
              <X :size="14" />
            </button>
          </div>
        </div>
      </label>
      <label>
        难度
        <!-- 取值来自 utils/mistakeQueue.js 的常量：筛选下拉用的是同一份，
             手写一份的话改了这边忘了那边，筛选就会选不出东西。 -->
        <select v-model="form.difficulty">
          <option v-for="level in MISTAKE_DIFFICULTY_OPTIONS" :key="level" :value="level">{{ level }}</option>
        </select>
      </label>
    </div>

    <div class="form-row two">
      <label>
        掌握状态
        <select v-model="form.status">
          <option value="待复盘">待复盘</option>
          <option value="不熟">不熟</option>
          <option value="不会">不会</option>
          <option value="已整理">已整理</option>
          <option value="已掌握">已掌握</option>
        </select>
      </label>
      <label>
        下次复习
        <input v-model="form.nextReviewAt" type="date" />
      </label>
    </div>

    <label>
      错题标题
      <input v-model.trim="form.title" required @focus="focusedField = 'title'" @blur="closeSuggestionsSoon" />
      <div v-if="focusedField === 'title' && titleHistory.length" class="field-suggestions">
        <div class="field-suggestions-head">
          <span>历史记录</span>
          <button type="button" @mousedown.prevent="clearHistory('title', titleHistory)">
            <Trash2 :size="13" />
            清空
          </button>
        </div>
        <div v-for="item in titleHistory" :key="item" class="field-suggestion-row">
          <button type="button" @mousedown.prevent="setSuggestion('title', item)">{{ item }}</button>
          <button type="button" title="删除此条历史" @mousedown.prevent="removeHistoryItem('title', item)">
            <X :size="14" />
          </button>
        </div>
      </div>
    </label>

    <p v-if="sourceRecord" class="form-tip">
      <BookOpenCheck :size="16" />
      关联成绩：{{ sourceRecord.paperName }} · {{ sourceRecord.score }} / {{ sourceRecord.fullScore }}
    </p>

    <label>
      解析与复盘
      <textarea v-model.trim="form.analysis" rows="4" @focus="focusedField = 'analysis'" @blur="closeSuggestionsSoon"></textarea>
      <div v-if="focusedField === 'analysis' && analysisHistory.length" class="field-suggestions">
        <div class="field-suggestions-head">
          <span>历史记录</span>
          <button type="button" @mousedown.prevent="clearHistory('analysis', analysisHistory)">
            <Trash2 :size="13" />
            清空
          </button>
        </div>
        <div v-for="item in analysisHistory" :key="item" class="field-suggestion-row">
          <button type="button" @mousedown.prevent="setSuggestion('analysis', item)">{{ item }}</button>
          <button type="button" title="删除此条历史" @mousedown.prevent="removeHistoryItem('analysis', item)">
            <X :size="14" />
          </button>
        </div>
      </div>
    </label>

    <ImageUploader
      :images="relatedImages"
      :reset-key="uploaderResetKey"
      @files="setFiles"
      @remove="store.removeImage"
    />

    <div class="ai-action-row">
      <button class="secondary-button" type="button" :disabled="isAnalyzing || !aiAvailable" @click="analyzeWithAi">
        <Sparkles :size="17" :class="{ spinning: isAnalyzing }" />
        {{ isAnalyzing ? "解析中..." : "AI 解析图片" }}
      </button>
      <span v-if="aiMessage" class="ai-status">{{ aiMessage }}</span>
    </div>

    <button class="primary-button" type="submit" :disabled="isSaving">
      <Save :size="17" />
      {{ isSaving ? "保存中..." : props.mistake ? "保存错题" : "新增错题" }}
    </button>
    <p class="form-tip">
      <BookOpenCheck :size="16" />
      {{ store.user ? "图片会压缩后上传到 Cloudflare R2，并在本地保留索引缓存。" : "未登录时图片只会离线保存到当前设备。" }}
    </p>
  </form>
</template>
