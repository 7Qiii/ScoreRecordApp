<script setup>
/**
 * 学习热力图。
 *
 * 相比旧版：
 * - 每天的浮层不再用原生 title，改成自绘 tooltip（桌面） + 常驻读数行（触屏），
 *   因为 title 在触屏上根本弹不出来，而且样式不可控。
 * - 统计口径只用真实数据：成绩条数、错题条数、成绩里记录的用时（没记就是 0）。
 * - 移动端横向滚动，并在挂载后自动滚到最右侧（最近的日子），不用用户自己拖。
 */
import { computed, onMounted, ref } from "vue";
import { formatDuration } from "../utils/recordDisplay";
import { localDateKey as dateKey } from "../utils/dateRange";

const props = defineProps({
  records: { type: Array, default: () => [] },
  mistakes: { type: Array, default: () => [] },
  days: { type: Number, default: 90 }
});

const wrapRef = ref(null);
const scrollRef = ref(null);
const active = ref(null);
const tipPos = ref({ x: 0, y: 0 });

const today = new Date();
today.setHours(0, 0, 0, 0);

const todayKey = dateKey(today);

// 每天的原始统计，后面算等级和浮层文案都用它
const dailyStats = computed(() => {
  const map = new Map();
  const ensure = (key) => {
    if (!map.has(key)) map.set(key, { records: 0, mistakes: 0, minutes: 0, subjects: new Set() });
    return map.get(key);
  };

  props.records.forEach((item) => {
    const key = dateKey(item.date);
    if (!key) return;
    const entry = ensure(key);
    entry.records += 1;
    entry.minutes += Number(item.durationMinutes) || 0;
    if (item.subjectId) entry.subjects.add(item.subjectId);
  });

  props.mistakes.forEach((item) => {
    const key = dateKey(item.createdAt);
    if (!key) return;
    ensure(key).mistakes += 1;
  });

  return map;
});

function totalOf(entry) {
  return entry ? entry.records + entry.mistakes : 0;
}

function levelOf(count) {
  if (count === 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count <= 4) return 3;
  return 4;
}

const cells = computed(() => {
  const end = new Date(today);
  const start = new Date(today);
  start.setDate(start.getDate() - props.days + 1);
  // 对齐到周一，保证每列都是完整的 7 天
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));

  const list = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const key = dateKey(cursor);
    const entry = dailyStats.value.get(key);
    list.push({
      key,
      date: new Date(cursor),
      count: totalOf(entry),
      records: entry?.records || 0,
      mistakes: entry?.mistakes || 0,
      minutes: entry?.minutes || 0,
      subjectCount: entry?.subjects.size || 0,
      level: levelOf(totalOf(entry))
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return list;
});

const columns = computed(() => {
  const result = [];
  cells.value.forEach((cell, index) => {
    const column = Math.floor(index / 7);
    if (!result[column]) result[column] = [];
    result[column].push(cell);
  });
  return result;
});

const monthLabels = computed(() => {
  const labels = [];
  columns.value.forEach((column) => {
    const first = column[0];
    if (!first) return;
    const month = first.date.getMonth() + 1;
    const last = labels[labels.length - 1];
    if (last && last.month === month) {
      last.span += 1;
      return;
    }
    labels.push({ month, label: `${month}月`, span: 1 });
  });
  return labels;
});

const activeDays = computed(() => cells.value.filter((cell) => cell.count > 0).length);

const streak = computed(() => {
  let count = 0;
  const cursor = new Date(today);
  // 今天还没学不算断档，从昨天继续往回数
  if (!dailyStats.value.has(todayKey)) cursor.setDate(cursor.getDate() - 1);
  while (dailyStats.value.has(dateKey(cursor))) {
    count += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
});

const totalMinutes = computed(() =>
  cells.value.reduce((sum, cell) => sum + cell.minutes, 0)
);

function formatDate(date) {
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 热力图里的空态文案是「未记录用时」，和仪表盘保持一致。 */
function formatMinutes(minutes) {
  return formatDuration(minutes, { emptyLabel: "未记录用时" });
}

function cellLabel(cell) {
  if (!cell.count) return `${formatDate(cell.date)} 没有学习记录`;
  return `${formatDate(cell.date)}：${cell.records} 条成绩、${cell.mistakes} 道错题`;
}

function activate(cell, event) {
  active.value = cell;
  const wrap = wrapRef.value;
  const target = event?.currentTarget;
  if (!wrap || !target) return;
  const wrapRect = wrap.getBoundingClientRect();
  const cellRect = target.getBoundingClientRect();
  const rawX = cellRect.left - wrapRect.left + cellRect.width / 2;
  tipPos.value = {
    // 夹住左右边界，避免浮层被面板裁掉
    x: Math.min(Math.max(rawX, 64), Math.max(wrapRect.width - 64, 64)),
    y: cellRect.top - wrapRect.top
  };
}

function deactivate() {
  active.value = null;
}

onMounted(() => {
  // 最近的日子在右边，默认滚过去，省得用户手动拖
  const scroller = scrollRef.value;
  if (scroller) scroller.scrollLeft = scroller.scrollWidth;
});
</script>

<template>
  <section class="ds-section contribution-panel">
    <div class="ds-section-head">
      <div>
        <h2>学习贡献</h2>
        <span class="ds-section-meta">
          最近 {{ days }} 天 · 累计 {{ activeDays }} 个活跃日 · 记录用时 {{ formatMinutes(totalMinutes) }}
        </span>
      </div>
      <div class="ds-section-tools contribution-summary">
        <span><strong>{{ activeDays }}</strong> 活跃日</span>
        <span><strong>{{ streak }}</strong> 连续日</span>
      </div>
    </div>

    <div ref="wrapRef" class="ds-heatmap-wrap" @mouseleave="deactivate">
      <div class="heatmap-months" aria-hidden="true">
        <span class="heatmap-months-gutter"></span>
        <span
          v-for="(item, index) in monthLabels"
          :key="`${item.label}-${index}`"
          class="heatmap-month"
          :style="{ gridColumn: `span ${item.span}` }"
        >
          {{ item.label }}
        </span>
      </div>

      <div ref="scrollRef" class="heatmap-scroll">
        <div class="heatmap">
          <div class="heatmap-weekdays" aria-hidden="true">
            <span>一</span>
            <span></span>
            <span>三</span>
            <span></span>
            <span>五</span>
            <span></span>
            <span>日</span>
          </div>
          <div class="heatmap-columns">
            <div v-for="(column, index) in columns" :key="index" class="heatmap-column">
              <button
                v-for="cell in column"
                :key="cell.key"
                class="heatmap-cell"
                :class="[`level-${cell.level}`, { 'is-active': active?.key === cell.key, 'is-today': cell.key === todayKey }]"
                type="button"
                :aria-label="cellLabel(cell)"
                @mouseenter="activate(cell, $event)"
                @focus="activate(cell, $event)"
                @click="activate(cell, $event)"
                @blur="deactivate"
              />
            </div>
          </div>
        </div>
      </div>

      <div v-if="active" class="ds-tip heatmap-tip" :style="{ left: `${tipPos.x}px`, top: `${tipPos.y}px` }">
        <strong>{{ formatDate(active.date) }}</strong>
        <span v-if="active.count">成绩 {{ active.records }} 条 · 错题 {{ active.mistakes }} 道</span>
        <span v-else>没有学习记录</span>
        <span v-if="active.count">{{ formatMinutes(active.minutes) }}</span>
      </div>

      <p class="heatmap-readout" aria-live="polite">
        <template v-if="active">
          <strong>{{ formatDate(active.date) }}</strong>
          <span v-if="active.count">成绩 {{ active.records }} 条 · 错题 {{ active.mistakes }} 道 · {{ formatMinutes(active.minutes) }}</span>
          <span v-else>没有学习记录</span>
        </template>
        <template v-else>点按任意方格查看当天记录</template>
      </p>
    </div>

    <div class="heatmap-legend">
      <span>少</span>
      <i class="heatmap-cell level-0"></i>
      <i class="heatmap-cell level-1"></i>
      <i class="heatmap-cell level-2"></i>
      <i class="heatmap-cell level-3"></i>
      <i class="heatmap-cell level-4"></i>
      <span>多</span>
    </div>
  </section>
</template>
