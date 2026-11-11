<script setup>
import { computed, nextTick, reactive, ref } from "vue";
import { BookOpenCheck, ClipboardList, Eye, Layers, GripVertical, Palette, Plus, Save, Trash2 } from "@lucide/vue";
import { defaultSubjects, isDefaultSubject } from "../services/storage";
import { useConfirm } from "../composables/useConfirm";
import { useTrackerStore } from "../stores/tracker";
import DsEmptyState from "../components/ds/DsEmptyState.vue";
import DsPageHeader from "../components/ds/DsPageHeader.vue";
import DsSection from "../components/ds/DsSection.vue";
import DsStatCard from "../components/ds/DsStatCard.vue";

const store = useTrackerStore();
const { confirm } = useConfirm();
const message = ref("");
const error = ref("");
const dragId = ref("");
const dropTargetId = ref("");
let dragPointerId = null;

const form = reactive({ name: "", fullScore: 100, color: "#177ddc" });
const defaultIds = new Set(defaultSubjects.map((subject) => subject.id));

const rows = computed(() =>
  store.subjects.map((subject) => ({
    ...subject,
    locked: defaultIds.has(subject.id),
    recordCount: store.records.filter((record) => record.subjectId === subject.id).length,
    mistakeCount: store.mistakes.filter((mistake) => mistake.subjectId === subject.id).length
  }))
);
const visibleCount = computed(() => rows.value.filter((subject) => !subject.hidden).length);

/* ------------------------------------------------------------------ *
 * 掌握概览
 * 原先放在首页，但首页太长、又和「看成绩」的主线抢位置，所以整体搬到这里。
 * 口径：全部记录（本页没有时间范围筛选），按练习次数排序。
 * ------------------------------------------------------------------ */

// 错题状态沿用数据里的取值，不重新定义枚举
const MISTAKE_STATES = [
  { key: "已掌握", label: "已掌握", color: "var(--state-mastered)" },
  { key: "已整理", label: "已整理", color: "var(--state-organized)" },
  { key: "不熟", label: "不熟", color: "var(--state-fuzzy)" },
  { key: "不会", label: "不会", color: "var(--state-unknown)" },
  { key: "待复盘", label: "待复盘", color: "var(--state-todo)" }
];

function countStates(list) {
  const result = MISTAKE_STATES.map((state) => ({ ...state, count: 0 }));
  const index = new Map(result.map((state) => [state.key, state]));
  list.forEach((mistake) => {
    const key = mistake.status || "待复盘";
    (index.get(key) || index.get("待复盘")).count += 1;
  });
  return result;
}

const masteryStats = computed(() =>
  rows.value
    .map((subject) => {
      const records = store.records.filter((record) => record.subjectId === subject.id);
      const mistakes = store.mistakes.filter((mistake) => mistake.subjectId === subject.id);
      const score = records.reduce((sum, record) => sum + Number(record.score || 0), 0);
      const fullScore = records.reduce((sum, record) => sum + Number(record.fullScore || 0), 0);
      const latest = [...records].sort(
        (a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt))
      )[0];
      return {
        ...subject,
        recordCount: records.length,
        mistakeCount: mistakes.length,
        pending: mistakes.filter((mistake) => (mistake.status || "待复盘") !== "已掌握").length,
        rate: fullScore ? Math.round((score / fullScore) * 100) : 0,
        average: records.length ? Math.round((score / records.length) * 10) / 10 : 0,
        latest,
        states: countStates(mistakes),
        total: mistakes.length
      };
    })
    .sort((a, b) => b.recordCount - a.recordCount || a.name.localeCompare(b.name, "zh-Hans-CN"))
);

async function add() {
  error.value = "";
  message.value = "";
  if (!form.name.trim()) return;
  await store.addSubject({ ...form });
  message.value = "科目已新增。";
  form.name = "";
  form.fullScore = 100;
  form.color = "#177ddc";
}

async function save(subject) {
  error.value = "";
  message.value = "";
  await store.updateSubject(subject.id, {
    name: subject.name,
    fullScore: subject.fullScore,
    color: subject.color,
    hidden: subject.hidden
  });
  message.value = "科目已保存。";
}

async function moveSubject(fromId, toId) {
  if (!fromId || fromId === toId) return;
  const ids = rows.value.map((subject) => subject.id);
  const fromIndex = ids.indexOf(fromId);
  const toIndex = ids.indexOf(toId);
  if (fromIndex < 0 || toIndex < 0) return;
  const [item] = ids.splice(fromIndex, 1);
  ids.splice(toIndex, 0, item);
  await store.reorderSubjects(ids);
  message.value = "科目顺序已更新。";
}

/* ------------------------------------------------------------------ *
 * 拖拽排序
 *
 * 原来用的是 HTML5 拖放（article 上挂 draggable + dragstart/drop），有两个
 * 致命问题：
 *   1. **触摸设备上完全不触发。** iOS Safari / Android Chrome 不会从触摸手势里
 *      派发 dragstart，所以 iPad 上这个功能等于不存在 —— 而 iPad 正是目标设备。
 *   2. 整张卡片都是拖拽源，可卡片里全是 input，想选个文字都会变成拖拽。
 * 改成 Pointer Events：鼠标、触控笔、手指走同一条代码路径，只在手柄上起拖。
 * 手柄还要 touch-action: none，否则浏览器会把这个手势当成页面滚动。
 * ------------------------------------------------------------------ */
function onHandleDown(event, subject) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  dragId.value = subject.id;
  dropTargetId.value = "";
  dragPointerId = event.pointerId;
  // 指针捕获能保证手指滑出手柄后仍收得到 move/up。捕获失败不影响拖拽本身
  // （后面用坐标做命中测试，不依赖事件落在哪），所以吞掉异常继续。
  try {
    event.currentTarget.setPointerCapture?.(event.pointerId);
  } catch {
    /* 合成事件或指针已释放 —— 忽略 */
  }
  event.preventDefault();
}

/** 指针下面是哪一行的科目。按坐标做命中测试，不依赖拖拽源自身的事件。 */
function subjectIdAt(x, y) {
  const row = document.elementFromPoint(x, y)?.closest("[data-subject-id]");
  return row?.getAttribute("data-subject-id") || "";
}

function onHandleMove(event) {
  if (!dragId.value || event.pointerId !== dragPointerId) return;
  const overId = subjectIdAt(event.clientX, event.clientY);
  dropTargetId.value = overId && overId !== dragId.value ? overId : "";
}

async function onHandleUp(event) {
  if (!dragId.value || event.pointerId !== dragPointerId) return;
  const from = dragId.value;
  const to = dropTargetId.value;
  dragId.value = "";
  dropTargetId.value = "";
  dragPointerId = null;
  if (to) await moveSubject(from, to);
}

/**
 * 手柄上的方向键。拖拽不该是唯一的排序方式 —— 键盘和读屏用户够不到拖拽，
 * 24px 的手柄在触摸下也不好瞄准。方向键每次挪一格，挪完把焦点还回同一个
 * 科目的手柄，否则连按第二下就断了。
 */
async function onHandleKeydown(event, subject) {
  const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
  if (!delta) return;
  const ids = rows.value.map((row) => row.id);
  const neighbor = ids[ids.indexOf(subject.id) + delta];
  if (!neighbor) return;
  event.preventDefault();
  await moveSubject(subject.id, neighbor);
  await nextTick();
  document.querySelector(`[data-drag-handle="${subject.id}"]`)?.focus();
}

async function remove(subject) {
  error.value = "";
  message.value = "";
  if (isDefaultSubject(subject.id)) {
    error.value = "默认科目不能删除。";
    return;
  }
  const ok = await confirm({
    title: "删除这个科目？",
    message: `「${subject.name}」将从科目列表移除。已记录的成绩和错题会保留，但不再出现在筛选里。`,
    confirmText: "删除"
  });
  if (!ok) return;
  try {
    await store.removeSubject(subject.id);
    message.value = "科目已删除。";
  } catch (err) {
    error.value = err.message || "删除失败。";
  }
}
</script>

<template>
  <div class="page-stack">
    <DsPageHeader title="科目管理" description="默认科目按备考顺序排列，可拖拽、隐藏和编辑" />

    <!-- 掌握概览：原首页「科目掌握度」整块搬过来 -->
    <DsSection title="掌握概览" description="全部记录 · 按练习次数排序">
      <div v-if="masteryStats.length" class="ds-subject-grid">
        <article
          v-for="subject in masteryStats"
          :key="subject.id"
          class="ds-subject-card"
          :style="{ '--subject-color': subject.color || 'var(--blue)' }"
        >
          <div class="ds-subject-head">
            <p class="ds-subject-name"><i aria-hidden="true"></i>{{ subject.name }}</p>
            <span class="ds-subject-count">{{ subject.recordCount }} 次练习</span>
          </div>

          <div class="ds-meter">
            <div class="ds-meter-head">
              <strong>{{ subject.rate }}%</strong>
              <span>平均得分率</span>
            </div>
            <div class="ds-meter-track">
              <i :style="{ width: `${subject.rate}%`, background: subject.color || 'var(--blue)' }"></i>
            </div>
          </div>

          <div class="ds-subject-metrics">
            <div class="ds-subject-metric">
              <span>平均分</span>
              <strong>{{ subject.recordCount ? subject.average : "--" }}</strong>
            </div>
            <div class="ds-subject-metric">
              <span>最近一次</span>
              <strong>{{ subject.latest ? `${subject.latest.score}/${subject.latest.fullScore}` : "--" }}</strong>
            </div>
            <div class="ds-subject-metric">
              <span>错题</span>
              <strong>{{ subject.mistakeCount }}</strong>
            </div>
            <div class="ds-subject-metric">
              <span>待复盘</span>
              <strong>{{ subject.pending }}</strong>
            </div>
          </div>

          <div v-if="subject.total" class="ds-state-bar">
            <i
              v-for="state in subject.states"
              :key="state.key"
              :style="{ width: `${(state.count / subject.total) * 100}%`, background: state.color }"
              :title="`${state.label} ${state.count}`"
            ></i>
          </div>
          <div v-if="subject.total" class="ds-state-legend">
            <span v-for="state in subject.states" :key="state.key">
              <em :style="{ background: state.color }"></em>{{ state.label }} <b>{{ state.count }}</b>
            </span>
          </div>
          <p v-else class="ds-muted">还没有这个科目的错题记录。</p>
        </article>
      </div>

      <DsEmptyState
        v-else
        :icon="Layers"
        title="还没有可统计的科目"
        description="先在下面新增科目，成绩和错题才能归类统计。"
      />
    </DsSection>

    <section class="ds-stats">
      <DsStatCard label="总科目" :value="rows.length" unit="个" hint="当前全部配置" :icon="Layers" />
      <DsStatCard label="可见科目" :value="visibleCount" unit="个" hint="可用于新增与筛选" :icon="Eye" />
      <DsStatCard label="成绩关联" :value="store.records.length" unit="条" hint="历史成绩不会丢失" :icon="ClipboardList" />
      <DsStatCard label="错题关联" :value="store.mistakes.length" unit="条" hint="错题也会保留" :icon="BookOpenCheck" />
    </section>

    <section class="subjects-layout">
      <DsSection class="subject-create-panel" title="新增科目" description="支持自定义满分和颜色">
        <form class="subject-create-form" @submit.prevent="add">
          <label>
            科目名称
            <input v-model.trim="form.name" required />
          </label>
          <label>
            满分
            <input v-model="form.fullScore" type="number" min="1" step="1" required />
          </label>
          <label>
            颜色
            <span class="color-field">
              <input v-model="form.color" type="color" />
              <input v-model.trim="form.color" required />
            </span>
          </label>
          <button class="primary-button" type="submit">
            <Plus :size="17" />
            新增科目
          </button>
        </form>
      </DsSection>

      <DsSection
        class="panel-wide"
        title="科目列表"
        :description="`${visibleCount} / ${rows.length} 个可见 · 拖拽可调整顺序`"
      >
        <div v-if="message || error" class="inline-alert" :class="{ danger: error }">
          {{ error || message }}
        </div>
        <div class="subject-manager">
          <article
            v-for="subject in rows"
            :key="subject.id"
            class="subject-editor"
            :class="{ 'is-dragging': dragId === subject.id, 'is-drop-target': dropTargetId === subject.id }"
            :data-subject-id="subject.id"
          >
            <button
              class="drag-handle"
              type="button"
              :data-drag-handle="subject.id"
              :aria-label="`调整「${subject.name}」的顺序：可拖动，也可用方向键上下移动`"
              title="拖动排序（也可用方向键）"
              @pointerdown="onHandleDown($event, subject)"
              @pointermove="onHandleMove"
              @pointerup="onHandleUp"
              @pointercancel="onHandleUp"
              @keydown="onHandleKeydown($event, subject)"
            >
              <GripVertical :size="16" />
            </button>
            <span class="subject-swatch" :style="{ background: subject.color }"></span>
            <label>
              名称
              <input v-model.trim="subject.name" :disabled="subject.locked" />
            </label>
            <label>
              满分
              <input v-model="subject.fullScore" type="number" min="1" step="1" :disabled="subject.locked" />
            </label>
            <label>
              颜色
              <span class="color-field">
                <input v-model="subject.color" type="color" />
                <input v-model.trim="subject.color" />
              </span>
            </label>
            <div class="subject-editor-meta">
              <i>{{ subject.locked ? "默认" : "自定义" }}</i>
              <span>{{ subject.recordCount }} 条成绩 / {{ subject.mistakeCount }} 条错题</span>
            </div>
            <label class="switch-row">
              <input v-model="subject.hidden" type="checkbox" />
              隐藏
            </label>
            <div class="subject-editor-actions">
              <button class="secondary-button compact" type="button" @click="save(subject)">
                <Save :size="15" />
                保存
              </button>
              <button
                class="icon-button danger"
                type="button"
                :disabled="subject.locked || subject.recordCount + subject.mistakeCount > 0"
                :title="subject.locked ? '默认科目不能删除' : '删除科目'"
                @click="remove(subject)"
              >
                <Trash2 :size="15" />
              </button>
            </div>
          </article>
        </div>
        <p class="form-tip">
          <Palette :size="16" />
          拖动左侧手柄可以调整所有科目的显示顺序（也可以选中手柄后按 ↑ ↓）；
          隐藏只影响新增和筛选入口，不会删除历史记录。
        </p>
      </DsSection>
    </section>
  </div>
</template>
