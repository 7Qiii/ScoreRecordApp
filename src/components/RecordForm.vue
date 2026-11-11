<script setup>
import { computed, nextTick, reactive, ref, useId, watch } from "vue";
import { Save } from "@lucide/vue";
import {
  READING_PART_COUNT,
  READING_PART_FULL,
  composeDuration,
  normalizeDurationMinutes,
  normalizeReadingParts,
  readingCorrectTotal,
  readingFilledCount,
  splitDurationMinutes
} from "../utils/recordDisplay";
import { useUnsavedFields } from "../composables/useUnsavedChanges";
import { useTrackerStore } from "../stores/tracker";
import { parsePaperIdentity } from "../utils/paperIdentity";
import { localDateKey } from "../utils/dateRange";

const props = defineProps({
  record: { type: Object, default: null }
});
const emit = defineEmits(["saved"]);
const store = useTrackerStore();
const isSaving = ref(false);
const formError = ref("");
const recordFormRef = ref(null);
const paperNameInput = ref(null);
const variantManuallySelected = ref(Boolean(props.record));
const exerciseBooksId = useId();

const paperVariantOptions = [
  { value: "true", label: "真题" },
  { value: "mock", label: "模拟卷" }
];

const form = reactive({
  subjectId: "",
  recordType: "paper",
  paperVariant: "",
  paperName: "",
  exerciseBookName: "",
  exercisePage: "",
  exerciseQuestion: "",
  score: "",
  fullScore: "",
  durationMinutes: "",
  date: localDateKey(new Date()),
  note: "",
  // 英语阅读 4 篇的答对数，每格 "" 或 "0".."5"。空数组项 = 这篇还没做。
  readingParts: Array.from({ length: READING_PART_COUNT }, () => "")
});

/* ------------------------------------------------------------------ *
 * 「填了一半」保护
 *
 * 这个表单出现在三个地方（首页内联、成绩列表内联面板、成绩详情编辑），
 * 每一处都能在没保存的情况下被关掉 —— 点「收起录入」、点面板的关闭按钮、
 * 点「科目」换页。实测过三条路径都是**静默丢弃**，填过的内容一声不响就没了。
 *
 * 只列用户真正会输入的字段。科目、满分、卷型、日期都是自动填的
 * （科目取第一个可见科目、满分跟着科目、日期默认今天），算进去的话
 * 表单一打开就是「脏」的 —— 见 composables/useUnsavedChanges.js 里的说明。
 * ------------------------------------------------------------------ */
const { resetDirty } = useUnsavedFields(form, [
  "paperName",
  "exerciseBookName",
  "exercisePage",
  "exerciseQuestion",
  "score",
  "durationMinutes",
  "note",
  // 阅读分篇是数组，useUnsavedFields 比较时会把两边都 String() 成 "5,5,4,5"，
  // 但基线存的是**数组引用**。所以下面所有改法都必须整个换新数组
  // （form.readingParts = [...]），就地 form.readingParts[i] = x 会让基线
  // 跟着一起变，永远判不出「脏」。见 setReadingPart。
  "readingParts"
]);

/* ------------------------------------------------------------------ *
 * 用时：拆成「小时 + 分钟」
 *
 * 原来是一个「用时（分钟）」的数字框，但全站都把这个值显示成
 * 「1 小时 30 分钟」（仪表盘、记录详情、导出、热力图都是）。
 * 也就是同一件事在界面上有两套单位：看到的是小时，要填的是分钟。
 * 用户每录一条都得在脑子里换算一次；这个字段又是选填的，
 * 换算的麻烦就直接变成了「算了不填」。
 *
 * 拆成两个框之后不用换算了，而且进位是自动的：分钟填 90 会折成 1 小时 30 分。
 *
 * 存储格式没有变 —— 仍然是 form.durationMinutes 的整数分钟。
 * 所以 store、导出、统计口径、以及别处读这个字段的地方全都不用动。
 * 拆分/合成的规则放在 utils/recordDisplay.js，和显示用的 formatDuration 同一处，
 * 免得「输入怎么理解」和「显示怎么理解」哪天走岔。
 * ------------------------------------------------------------------ */

const durationPresets = [
  { minutes: 45, label: "45 分" },
  { minutes: 60, label: "1 时" },
  { minutes: 90, label: "1.5 时" },
  { minutes: 120, label: "2 时" },
  { minutes: 150, label: "2.5 时" },
  { minutes: 180, label: "3 时" }
];

const durationHours = computed({
  get: () => splitDurationMinutes(form.durationMinutes).hours,
  set: (value) => {
    form.durationMinutes = composeDuration(value, durationMinutesPart.value);
  }
});

const durationMinutesPart = computed({
  get: () => splitDurationMinutes(form.durationMinutes).minutes,
  set: (value) => {
    form.durationMinutes = composeDuration(durationHours.value, value);
  }
});

function isDurationPresetActive(minutes) {
  return normalizeDurationMinutes(form.durationMinutes) === minutes;
}

/** 再点一次已选中的预设就取消，避免选错了还得手动清空两个框。 */
function applyDurationPreset(minutes) {
  form.durationMinutes = isDurationPresetActive(minutes) ? "" : minutes;
}

/** 给「用时」这一组控件的标题用，避免同一页出现重复 id。 */
const durationLabelId = useId();

const selectedSubject = computed(() => store.visibleSubjects.find((subject) => subject.id === form.subjectId));
const isEditing = computed(() => Boolean(props.record));
const isComposite = computed(() => form.recordType === "composite");
const isMathSubject = computed(() => selectedSubject.value?.id === "math1");
const isMathPaper = computed(() => isMathSubject.value && form.recordType === "paper" && !isComposite.value);
function choosePaperVariant(value) {
  variantManuallySelected.value = true;
  form.paperVariant = value;
}

const exerciseBooks = computed(() => {
  const books = store.records
    .filter((record) => record.subjectId === "math1" && record.recordType === "exercise" && record.exerciseBookName)
    .map((record) => record.exerciseBookName.trim())
    .filter(Boolean);
  return [...new Set(books)].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
});

/* ------------------------------------------------------------------ *
 * 英语阅读：4 篇 × 每篇 5 题
 *
 * 用户原来把「5545」手打进复盘备注里 —— 那只是文字，不能统计、看不出
 * 哪一篇弱，也没法排序。这里拆成 4 个格子：连着敲 5 5 4 5 就行
 * （填完一格自动跳下一格），也能点某一格单独改。
 *
 * 只对英语显示。英一和英二都是 Part A 四篇、每篇 5 题，口径一致，
 * 所以按「id 是 english1 或名字里带英语/英一/英二」判断，
 * 这样自建的「英二」科目也能用上。
 * ------------------------------------------------------------------ */
const isEnglishSubject = computed(() => {
  const subject = selectedSubject.value;
  if (!subject) return false;
  return subject.id === "english1" || /英语|英[一二]/.test(subject.name || "");
});

const showReadingParts = computed(() => isEnglishSubject.value && !isComposite.value && form.recordType !== "exercise");

const readingInputs = ref([]);

const readingFilled = computed(() => readingFilledCount(form.readingParts));
const readingTotal = computed(() => readingCorrectTotal(form.readingParts));
const readingFullTotal = READING_PART_COUNT * READING_PART_FULL;
const readingAllFull = computed(() => form.readingParts.every((part) => part === String(READING_PART_FULL)));

const readingSummaryText = computed(() => {
  if (!readingFilled.value) return "";
  if (readingFilled.value < READING_PART_COUNT) return `已填 ${readingFilled.value}/${READING_PART_COUNT} 篇`;
  return `共 ${readingTotal.value}/${readingFullTotal} · 错 ${readingFullTotal - readingTotal.value} 题`;
});

/** 记录里的 4 个数 → 4 个输入框的值（没填的篇是 ""） */
function toReadingBoxes(parts) {
  const list = normalizeReadingParts(parts);
  return Array.from({ length: READING_PART_COUNT }, (_, index) => {
    const value = list?.[index];
    return value === null || value === undefined ? "" : String(value);
  });
}

function focusReadingPart(index) {
  nextTick(() => readingInputs.value[index]?.focus());
}

/**
 * 写一格。**必须整个换新数组** —— 判脏的基线存的是数组引用（见上面
 * useUnsavedFields 那段注释），就地改下标会让基线跟着一起变，永远不脏。
 *
 * 只取最后一位数字：格子里已有值时接着敲，应该替换而不是拼接。
 * 超出 0-5 的当没填 —— 宁可留空，也不要把 9 悄悄存成 5。
 */
function setReadingPart(index, raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  const next = [...form.readingParts];
  if (!digits) {
    next[index] = "";
  } else {
    const last = digits.slice(-1);
    next[index] = Number(last) <= READING_PART_FULL ? last : "";
  }
  form.readingParts = next;
  return next[index];
}

function onReadingInput(event, index) {
  const value = setReadingPart(index, event.target.value);
  // 输入框里可能还留着被我们丢掉的字符（比如打了 9），显式同步回去，
  // 否则要等下一次渲染，中间会闪一下。
  event.target.value = value;
  if (value && index < READING_PART_COUNT - 1) focusReadingPart(index + 1);
}

/** 空格子按退格 = 删掉上一篇并退回去，和逐格删除的手感一致 */
function onReadingKeydown(event, index) {
  if (event.key !== "Backspace" || form.readingParts[index] || index === 0) return;
  event.preventDefault();
  const next = [...form.readingParts];
  next[index - 1] = "";
  form.readingParts = next;
  focusReadingPart(index - 1);
}

/** 整串粘贴「5545」时，从当前格往后铺开 */
function onReadingPaste(event, index) {
  const digits = String(event.clipboardData?.getData("text") || "").replace(/\D/g, "").slice(0, READING_PART_COUNT);
  if (!digits) return;
  event.preventDefault();
  const next = [...form.readingParts];
  [...digits].forEach((digit, offset) => {
    const target = index + offset;
    if (target < READING_PART_COUNT) next[target] = Number(digit) <= READING_PART_FULL ? digit : "";
  });
  form.readingParts = next;
  focusReadingPart(Math.min(index + digits.length, READING_PART_COUNT - 1));
}

/** 「全对」一键填 5；已经是全对时再点一次清空 */
function fillAllReading() {
  const value = readingAllFull.value ? "" : String(READING_PART_FULL);
  form.readingParts = Array.from({ length: READING_PART_COUNT }, () => value);
}

/** 已经灌进表单的「源」。只有它变了才重新灌，见下面。 */
let appliedSourceKey = null;

watch(
  () => [store.visibleSubjects, props.record],
  () => {
    const sourceKey = props.record?.id || "new";
    if (sourceKey === appliedSourceKey) {
      // 源没变就一个字段都不动。
      //
      // 以前这里是无条件重灌：科目表被重新赋值时（store.visibleSubjects 每次重算
      // 都是个新数组，同步拉回科目就会重算）编辑态的表单会被整个覆盖一遍 ——
      // 实测改过的卷名和备注直接变回原值。只补一个「还没填上」的默认科目。
      if (!form.subjectId && store.visibleSubjects.length) form.subjectId = store.visibleSubjects[0].id;
      return;
    }
    appliedSourceKey = sourceKey;

    if (props.record) {
      form.subjectId = props.record.subjectId || "";
      form.recordType = props.record.recordType || "paper";
      form.paperVariant = normalizePaperVariant(props.record.paperVariant, props.record.paperName);
      form.paperName = props.record.paperName || "";
      form.exerciseBookName = props.record.exerciseBookName || "";
      form.exercisePage = props.record.exercisePage || "";
      form.exerciseQuestion = props.record.exerciseQuestion || "";
      form.score = props.record.score ?? "";
      form.fullScore = props.record.fullScore ?? "";
      form.durationMinutes = props.record.durationMinutes ?? "";
      form.date = props.record.date || localDateKey(new Date());
      form.note = store.displayRecordNote(props.record) || "";
      form.readingParts = toReadingBoxes(store.readingPartsForRecord(props.record));
      ensurePaperVariant();
    } else {
      if ((!form.subjectId || !selectedSubject.value) && store.visibleSubjects.length) {
        form.subjectId = store.visibleSubjects[0].id;
      }
      ensurePaperVariant();
    }
    // 源换了 → 表单现在就是源的样子，**无条件**重记基线。
    // 这里不能省：换了一条成绩之后如果不重记，表单会一直显示「有未保存内容」，
    // 关的时候白问一句。
    resetDirty();
  },
  { immediate: true }
);

watch(
  () => form.subjectId,
  () => {
    variantManuallySelected.value = Boolean(props.record);
    if (selectedSubject.value && !props.record) {
      form.fullScore = selectedSubject.value.fullScore;
    }
    if (!isMathSubject.value && form.recordType === "exercise") {
      form.recordType = "paper";
      form.exerciseBookName = "";
      form.exercisePage = "";
      form.exerciseQuestion = "";
    }
    // 从英语切到别的科目时，别把阅读分篇带过去 ——
    // 不然数学成绩的备注里也会挂一份 5545。
    if (!showReadingParts.value) {
      form.readingParts = Array.from({ length: READING_PART_COUNT }, () => "");
    }
    ensurePaperVariant();
  },
  { immediate: true }
);

watch(
  () => form.recordType,
  () => {
    if (form.recordType !== "exercise") {
      form.exerciseBookName = "";
      form.exercisePage = "";
      form.exerciseQuestion = "";
    }
    ensurePaperVariant();
  }
);

async function submit(continueAdding = false) {
  if (isSaving.value) return;
  if (continueAdding && !recordFormRef.value?.reportValidity()) return;
  formError.value = "";
  /* ------------------------------------------------------------------ *
   * 校验口径：留空的字段一律当「没填」，不打扰用户。
   *
   * 以前这里有 `required`（浏览器原生气泡「请填写此字段」）和一条
   * 「习题册名称必填」的硬拦。用户的实际感受是：只想随手记一条，
   * 却被弹框拦住，关掉之后照样能存 —— 纯粹是摩擦。
   *
   * 现在只留两条**说不通**的数据检查，而且都必须「两个字段都真填了」才判：
   * 满分留空时 Number("") 是 0，以前会直接把「得分 120 > 满分 0」判成越界，
   * 于是留空反而弹提示 —— 正是要去掉的那种打扰。
   *
   * 习题册名称不再拦：store 的 buildExerciseRecordName 本来就会兜底成
   * 「数一习题」，没必要为了一个标题挡住保存。
   * ------------------------------------------------------------------ */
  const score = form.score === "" ? null : Number(form.score);
  const fullScore = form.fullScore === "" ? null : Number(form.fullScore);
  if (score !== null && (!Number.isFinite(score) || score < 0)) {
    formError.value = "得分需要是大于或等于 0 的数字。";
    return;
  }
  if (fullScore !== null && (!Number.isFinite(fullScore) || fullScore <= 0)) {
    formError.value = "满分需要大于 0。";
    return;
  }
  if (score !== null && fullScore !== null && fullScore > 0 && score > fullScore) {
    formError.value = "得分不能高于满分。";
    return;
  }
  if (form.durationMinutes !== "" && Number(form.durationMinutes) < 0) {
    formError.value = "用时不能小于 0 分钟。";
    return;
  }
  ensurePaperVariant();
  // 非英语科目不带阅读分篇：从英语切到别的科目时表单里还留着旧值，
  // 不显式清掉的话会跟着存进数学成绩。
  const payload = {
    ...form,
    readingParts: showReadingParts.value ? form.readingParts : []
  };
  isSaving.value = true;
  try {
    if (props.record) {
      await store.updateRecord(props.record.id, {
        ...payload,
        compositeSourceIds: props.record.compositeSourceIds || [],
        compositeSources: props.record.compositeSources || []
      });
    } else {
      await store.addRecord(payload);
      if (!continueAdding) {
        resetDirty();
        emit("saved");
        return;
      }
      form.recordType = isMathSubject.value ? form.recordType : "paper";
      form.paperName = "";
      form.exercisePage = "";
      form.exerciseQuestion = "";
      form.score = "";
      form.durationMinutes = "";
      form.note = "";
      form.readingParts = toReadingBoxes(null);
      ensurePaperVariant();
    }
    // 存完了就不算「未保存」了。父组件接下来会同步地把表单关掉并问一句
    // confirmDiscardChanges()，所以必须在 emit 之前重置（见 useUnsavedForm 里
    // flush: "sync" 那段说明）。
    resetDirty();
    if (continueAdding && !isEditing.value) {
      await nextTick();
      paperNameInput.value?.focus({ preventScroll: true });
    } else {
      emit("saved");
    }
  } catch (error) {
    store.notify(error.message || "成绩保存失败。", "error", 6000);
  } finally {
    isSaving.value = false;
  }
}

function ensurePaperVariant() {
  if (isMathPaper.value) {
    const inferred = !isEditing.value && !variantManuallySelected.value ? parsePaperIdentity(form.paperName).variant : "";
    form.paperVariant = inferred || normalizePaperVariant(form.paperVariant, form.paperName) || "true";
  } else {
    form.paperVariant = "";
  }
}

function normalizePaperVariant(value, paperName = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "true" || raw === "mock") return raw;
  const name = String(paperName || "").trim().toLowerCase();
  if (/mock|模拟|模考/.test(name)) return "mock";
  if (/真题|历年|历届/.test(name)) return "true";
  return "";
}
</script>

<template>
  <form ref="recordFormRef" class="form-grid record-form" @submit.prevent="submit(false)" :aria-busy="isSaving">
    <div v-if="formError" class="inline-alert danger" role="alert">{{ formError }}</div>
    <fieldset class="record-fields" :disabled="isSaving" aria-label="成绩信息">
      <div class="form-row two">
        <label>科目
          <select v-model="form.subjectId">
            <option v-for="subject in store.visibleSubjects" :key="subject.id" :value="subject.id">{{ subject.name }}</option>
          </select>
        </label>
        <label>日期<input v-model="form.date" type="date" /></label>
      </div>
      <div v-if="isMathSubject && !isComposite" class="record-kind-row">
        <div class="segmented" role="group" aria-label="记录类型">
          <button type="button" :class="{ active: form.recordType === 'paper' }" :aria-pressed="form.recordType === 'paper'" @click="form.recordType = 'paper'">试卷</button>
          <button type="button" :class="{ active: form.recordType === 'exercise' }" :aria-pressed="form.recordType === 'exercise'" @click="form.recordType = 'exercise'">习题</button>
        </div>
        <div v-if="isMathPaper" class="segmented paper-kind-segmented" role="group" aria-label="卷型">
          <button v-for="option in paperVariantOptions" :key="option.value" type="button"
            :class="{ active: form.paperVariant === option.value }" :aria-pressed="form.paperVariant === option.value"
            @click="choosePaperVariant(option.value)">{{ option.label }}</button>
        </div>
      </div>
      <label v-if="form.recordType !== 'exercise'">
        {{ isComposite ? "合成成绩名称" : "试卷名称" }}
        <input ref="paperNameInput" v-model.trim="form.paperName" placeholder="例如：27张八1" autocomplete="off" @change="ensurePaperVariant" />
      </label>
      <template v-else>
        <label>习题册名称
          <input ref="paperNameInput" v-model.trim="form.exerciseBookName" :list="exerciseBooksId" />
          <datalist :id="exerciseBooksId"><option v-for="book in exerciseBooks" :key="book" :value="book" /></datalist>
        </label>
        <div class="form-row two">
          <label>页码<input v-model.trim="form.exercisePage" inputmode="numeric" /></label>
          <label>题号<input v-model.trim="form.exerciseQuestion" /></label>
        </div>
      </template>
      <div class="record-score-time">
        <div class="form-row two record-score-row">
          <label>得分<input v-model="form.score" type="number" step="any" inputmode="decimal" placeholder="本次得分" /></label>
          <label>满分<input v-model="form.fullScore" type="number" step="any" inputmode="decimal" /></label>
        </div>
        <div class="ds-field duration-field">
          <span :id="durationLabelId" class="ds-field-label">用时</span>
          <div class="duration-inputs" role="group" :aria-labelledby="durationLabelId">
            <span class="duration-part">
              <input v-model="durationHours" type="number" inputmode="numeric" placeholder="0" aria-label="用时（小时）" />
              <span class="duration-unit">小时</span>
            </span>
            <span class="duration-part">
              <input v-model="durationMinutesPart" type="number" inputmode="numeric" placeholder="0" aria-label="用时（分钟）" />
              <span class="duration-unit">分钟</span>
            </span>
          </div>
          <div class="segmented duration-presets" role="group" :aria-labelledby="durationLabelId">
            <button
              v-for="preset in durationPresets"
              :key="preset.minutes"
              type="button"
              :class="{ active: isDurationPresetActive(preset.minutes) }"
              :aria-pressed="isDurationPresetActive(preset.minutes)"
              @click="applyDurationPreset(preset.minutes)"
            >
              {{ preset.label }}
            </button>
          </div>
        </div>
      </div>
      <div v-if="showReadingParts" class="ds-field reading-field">
        <div class="reading-head">
          <span class="ds-field-label">英语阅读（4 篇）</span>
          <button type="button" class="text-link reading-fill-all" @click="fillAllReading">
            {{ readingAllFull ? "清空" : "全对" }}
          </button>
        </div>
        <div class="reading-parts" role="group" aria-label="英语阅读每篇答对数">
          <label v-for="(part, index) in form.readingParts" :key="index" class="reading-part">
            <span>第 {{ index + 1 }} 篇</span>
            <input
              :ref="(el) => (readingInputs[index] = el)"
              :value="part"
              type="text"
              inputmode="numeric"
              maxlength="1"
              autocomplete="off"
              :aria-label="`阅读第 ${index + 1} 篇答对数（0-${READING_PART_FULL}）`"
              @input="onReadingInput($event, index)"
              @keydown="onReadingKeydown($event, index)"
              @paste="onReadingPaste($event, index)"
            />
          </label>
        </div>
        <p v-if="readingFilled" class="reading-summary">{{ readingSummaryText }}</p>
      </div>
      <label>备注<textarea v-model.trim="form.note" rows="2" placeholder="选填"></textarea></label>
    </fieldset>
    <div class="record-form-footer">
      <button v-if="!isEditing" class="secondary-button" type="button" :disabled="isSaving" @click="submit(true)">保存并继续</button>
      <button class="primary-button" type="submit" :disabled="isSaving">
        <Save :size="17" />{{ isSaving ? "保存中..." : isEditing ? "保存修改" : "保存成绩" }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.record-form { gap: 14px; padding: 0; }
.record-form::before { display: none; }
.record-fields { display: grid; gap: 14px; min-width: 0; padding: 0; margin: 0; border: 0; }
.record-fields .form-row.two { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; }
.record-kind-row, .record-score-time { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.record-kind-row .segmented { width: 100%; }
.record-kind-row button { flex: 1; min-height: 36px; }
.record-form-footer { display: flex; justify-content: flex-end; gap: 10px; }
.record-form-footer button { min-height: 40px; }
.record-form input, .record-form select, .record-form textarea { transition: none; }
@media (max-width: 600px) {
  .record-score-time { grid-template-columns: minmax(0, 1fr); }
  .record-form-footer > button { flex: 1; justify-content: center; }
}
</style>
