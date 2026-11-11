<script setup>
/**
 * 分数图表：趋势折线 + 对比柱状。
 *
 * 相比旧版：
 * - 支持时间范围筛选（rangeDays，0 表示全部），趋势图不再一股脑画完所有记录。
 * - 颜色统一从设计 token 里读，不再散落硬编码色值。
 * - 没有数据时给空状态，而不是渲染一张空白坐标系。
 * - 两个面板各自独立初始化：某个面板没数据被 v-if 掉时，另一个照常渲染。
 * - 面板尺寸变化（侧栏在 rail / 抽屉之间切换）时用 ResizeObserver 重新适配。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ChartLine } from "@lucide/vue";
import DsEmptyState from "./ds/DsEmptyState.vue";
import { useTrackerStore } from "../stores/tracker";
import { isInDateRange } from "../utils/dateRange";

const props = defineProps({
  subjectId: { type: String, default: "" },
  paperVariant: { type: String, default: "all" },
  /** 只看最近 N 天；0 = 全部 */
  rangeDays: { type: Number, default: 90 }
});

const store = useTrackerStore();
const rootRef = ref(null);
const trendRef = ref(null);
const comparisonRef = ref(null);
const chartState = ref("idle");

let echarts = null;
let trendChart = null;
let comparisonChart = null;
let observer = null;
let resizeObserver = null;
let themeObserver = null;
let isActive = false;
let isUnmounted = false;
let compactLayout = null;
let resizeFrame = 0;

function normalizePaperVariant(record) {
  const raw = String(record?.paperVariant || "").trim().toLowerCase();
  if (raw === "true" || raw === "mock") return raw;
  const name = String(record?.paperName || "").trim().toLowerCase();
  if (/mock|模拟|模考/.test(name)) return "mock";
  if (/真题|历年|历届/.test(name)) return "true";
  return "";
}

/** 当前筛选条件下的成绩，按日期升序 */
const scopedRecords = computed(() => {
  let list = store.records;
  if (props.subjectId) list = list.filter((record) => record.subjectId === props.subjectId);
  if (props.subjectId === "math1" && props.paperVariant !== "all") {
    list = list.filter((record) => (record.recordType || "paper") === "paper" && normalizePaperVariant(record) === props.paperVariant);
  }
  list = list.filter((record) => isInDateRange(record.date, props.rangeDays));
  return [...list].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || String(a.id).localeCompare(String(b.id)));
});

const hasTrendData = computed(() => scopedRecords.value.length > 0);
const useRate = computed(() => new Set(scopedRecords.value.map((record) => Number(record.fullScore))).size > 1);
function chartValue(record) {
  if (!useRate.value) return Number(record.score) || 0;
  return Number(record.fullScore) > 0 ? Math.round(Number(record.score) / Number(record.fullScore) * 1000) / 10 : null;
}
const trendValues = computed(() => scopedRecords.value.map(chartValue));

/** 柱状图：选了科目就看该科目最近几次，没选就横向比各科最新一次 */
const comparison = computed(() => {
  if (props.subjectId) {
    const subject = store.visibleSubjects.find((item) => item.id === props.subjectId);
    return scopedRecords.value.slice(-6).map((record) => ({
      label: record.date.slice(5),
      title: record.paperName,
      detail: `${record.score}/${record.fullScore}`,
      value: chartValue(record),
      color: subject?.color || ""
    }));
  }

  const latestBySubject = new Map();
  for (const record of scopedRecords.value) {
    const previous = latestBySubject.get(record.subjectId);
    if (!previous || previous.date !== record.date || previous.createdAt !== record.createdAt) {
      latestBySubject.set(record.subjectId, record);
    }
  }
  return store.visibleSubjects
    .map((subject) => {
      const latest = latestBySubject.get(subject.id);
      if (!latest) return null;
      return {
        label: subject.name,
        title: latest.paperName,
        detail: `${latest.score}/${latest.fullScore}`,
        value: chartValue(latest),
        color: subject.color || ""
      };
    })
    .filter(Boolean);
});

const hasComparisonData = computed(() => comparison.value.length > 0);

/** 从设计 token 取色，取不到就退回默认值 */
function token(name, fallback) {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function colorWithAlpha(color, alpha) {
  const value = String(color).trim();
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const int = parseInt(hex[1], 16);
    return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
  }
  return value;
}

function isDarkMode() {
  if (typeof window === "undefined") return false;
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark") return true;
  if (explicit === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function isCompact() {
  if (typeof window === "undefined") return false;
  return window.innerWidth < 720;
}

function getChartTheme() {
  const isDark = isDarkMode();
  return {
    axis: isDark ? "rgba(244, 247, 251, 0.36)" : token("--line-strong", "rgba(73, 88, 108, 0.35)"),
    grid: isDark ? "rgba(244, 247, 251, 0.09)" : token("--line", "rgba(73, 88, 108, 0.12)"),
    muted: token("--muted", isDark ? "#a7b0bd" : "#64748b"),
    text: token("--ink", isDark ? "#f4f7fb" : "#1f2329"),
    blue: token("--blue", "#2f6fed"),
    green: token("--green", "#16a34a"),
    surface: token("--surface", isDark ? "#182029" : "#ffffff"),
    area: colorWithAlpha(token("--blue", "#2f6fed"), isDark ? 0.18 : 0.1),
    tooltipBg: isDark ? "rgba(24, 31, 41, 0.96)" : "rgba(255, 255, 255, 0.98)"
  };
}

function axisLayout(theme) {
  const compact = isCompact();
  return {
    compact,
    grid: { left: compact ? 34 : 44, right: 16, top: 24, bottom: compact ? 48 : 38 },
    axisLine: { lineStyle: { color: theme.axis } },
    axisLabel: { color: theme.muted, rotate: compact ? 40 : 0, hideOverlap: true, fontSize: compact ? 10 : 11 }
  };
}

function drawTrend(theme) {
  if (!trendRef.value || !hasTrendData.value) return;
  trendChart ||= echarts.init(trendRef.value);
  const records = scopedRecords.value;
  const { compact, grid, axisLine, axisLabel } = axisLayout(theme);

  trendChart.setOption(
    {
      backgroundColor: "transparent",
      grid,
      tooltip: {
        trigger: "axis",
        backgroundColor: theme.tooltipBg,
        borderColor: theme.grid,
        textStyle: { color: theme.text },
        extraCssText: "border-radius: 10px; box-shadow: 0 12px 28px rgba(0, 0, 0, 0.14);",
        formatter(params) {
          const record = records[params[0]?.dataIndex];
          if (!record) return "";
          const rate = record.fullScore ? Math.round((Number(record.score) / Number(record.fullScore)) * 100) : 0;
          return `${echarts.format.encodeHTML(record.paperName || "")}<br/>${echarts.format.encodeHTML(store.subjectName(record.subjectId))} · ${echarts.format.encodeHTML(record.date)}<br/>得分 ${Number(record.score)}/${Number(record.fullScore)}（${rate}%）`;
        }
      },
      xAxis: { type: "category", data: records.map((item) => item.date), axisLine, axisTick: { show: false }, axisLabel },
      yAxis: {
        type: "value",
        axisLabel: { color: theme.muted, fontSize: 11, formatter: useRate.value ? '{value}%' : '{value}' },
        splitLine: { lineStyle: { color: theme.grid } }
      },
      series: [
        {
          name: useRate.value ? "得分率" : "得分",
          type: "line",
          smooth: true,
          showSymbol: records.length <= 120,
          symbolSize: compact ? 6 : 8,
          lineStyle: { width: 2.5, color: theme.blue },
          itemStyle: { color: theme.blue, borderColor: theme.surface, borderWidth: 2 },
          areaStyle: { color: theme.area },
          data: trendValues.value
        }
      ]
    },
    true
  );
}

function drawComparison(theme) {
  if (!comparisonRef.value || !hasComparisonData.value) return;
  comparisonChart ||= echarts.init(comparisonRef.value);
  const bars = comparison.value;
  const { grid, axisLine, axisLabel } = axisLayout(theme);

  comparisonChart.setOption(
    {
      backgroundColor: "transparent",
      grid,
      tooltip: {
        trigger: "axis",
        backgroundColor: theme.tooltipBg,
        borderColor: theme.grid,
        textStyle: { color: theme.text },
        extraCssText: "border-radius: 10px; box-shadow: 0 12px 28px rgba(0, 0, 0, 0.14);",
        formatter(params) {
          const item = bars[params[0]?.dataIndex];
          if (!item) return "";
          return `${echarts.format.encodeHTML(item.title || "")}<br/>得分 ${echarts.format.encodeHTML(item.detail)}`;
        }
      },
      xAxis: { type: "category", data: bars.map((item) => item.label), axisLine, axisTick: { show: false }, axisLabel },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: theme.grid } },
        axisLabel: { color: theme.muted, fontSize: 11, formatter: useRate.value ? '{value}%' : '{value}' }
      },
      series: [
        {
          name: useRate.value ? "得分率" : "得分",
          type: "bar",
          barMaxWidth: 34,
          data: bars.map((item) => ({
            value: item.value,
            itemStyle: { color: item.color || theme.green, borderRadius: [6, 6, 0, 0] }
          }))
        }
      ]
    },
    true
  );
}

function draw() {
  if (!echarts || isUnmounted) return;
  compactLayout = isCompact();
  const theme = getChartTheme();
  drawTrend(theme);
  drawComparison(theme);
}

async function updateCharts() {
  if (!isActive || isUnmounted || (!trendRef.value && !comparisonRef.value)) return;
  if (chartState.value === "ready") {
    draw();
    return;
  }
  if (chartState.value !== "idle") return;
  chartState.value = "loading";
  try {
    echarts = await import("../services/scoreChartRuntime");
    if (isUnmounted) return;
    draw();
    chartState.value = "ready";
  } catch {
    if (!isUnmounted) chartState.value = "error";
  }
}

function resize() {
  resizeFrame = 0;
  trendChart?.resize();
  comparisonChart?.resize();
  if (chartState.value === "ready" && compactLayout !== isCompact()) draw();
}

function scheduleResize() {
  if (chartState.value !== "ready" || resizeFrame) return;
  resizeFrame = requestAnimationFrame(resize);
}

onMounted(() => {
  if ("IntersectionObserver" in window && rootRef.value) {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer?.disconnect();
          observer = null;
          isActive = true;
          updateCharts();
        }
      },
      { rootMargin: "180px" }
    );
    observer.observe(rootRef.value);
  } else {
    isActive = true;
    updateCharts();
  }

  if ("ResizeObserver" in window && rootRef.value) {
    resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(rootRef.value);
  }
  window.addEventListener("resize", scheduleResize);

  themeObserver = new MutationObserver(() => {
    if (chartState.value === "ready") draw();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
});

/**
 * 容器被 v-if 掉之后，echarts 实例还指着已经脱离文档的元素。
 * 数据回来时拿到的是新元素，必须先把旧实例销毁，否则会画在空气里。
 */
function disposeOrphanCharts() {
  if (!hasTrendData.value && trendChart) {
    trendChart.dispose();
    trendChart = null;
  }
  if (!hasComparisonData.value && comparisonChart) {
    comparisonChart.dispose();
    comparisonChart = null;
  }
}

watch(
  [scopedRecords, trendValues, comparison],
  () => {
    disposeOrphanCharts();
    updateCharts();
  },
  { flush: "post" }
);

onBeforeUnmount(() => {
  isUnmounted = true;
  window.removeEventListener("resize", scheduleResize);
  cancelAnimationFrame(resizeFrame);
  observer?.disconnect();
  resizeObserver?.disconnect();
  themeObserver?.disconnect();
  trendChart?.dispose();
  comparisonChart?.dispose();
  trendChart = null;
  comparisonChart = null;
});
</script>

<template>
  <div ref="rootRef" class="chart-grid">
    <section class="ds-section">
      <div class="ds-section-head">
        <div>
          <h2>分数趋势</h2>
          <span class="ds-section-meta">
            {{ rangeDays ? `最近 ${rangeDays} 天` : "全部记录" }} · {{ scopedRecords.length }} 次成绩
            <span v-if="useRate"> · 按得分率对比</span>
          </span>
        </div>
      </div>
      <div v-if="hasTrendData" class="chart-stage">
        <div ref="trendRef" class="chart-box" />
        <div v-if="chartState !== 'ready'" class="chart-status" role="status">
          {{ chartState === "error" ? "趋势图加载失败，请刷新后重试。" : "正在准备趋势图…" }}
        </div>
      </div>
      <DsEmptyState
        v-else
        :icon="ChartLine"
        title="这个范围内还没有成绩"
        description="换个时间范围，或者先记录一次练习。"
      />
    </section>

    <section class="ds-section">
      <div class="ds-section-head">
        <div>
          <h2>{{ subjectId ? "该科目最近成绩" : "各科最近成绩" }}</h2>
          <span class="ds-section-meta">{{ subjectId ? "范围内最近 6 次" : "范围内各科最新一次" }} · {{ useRate ? '得分率 %' : '得分' }}</span>
        </div>
      </div>
      <div v-if="hasComparisonData" class="chart-stage">
        <div ref="comparisonRef" class="chart-box" />
        <div v-if="chartState !== 'ready'" class="chart-status" role="status">
          {{ chartState === "error" ? "对比图加载失败，请刷新后重试。" : "正在准备对比图…" }}
        </div>
      </div>
      <DsEmptyState
        v-else
        :icon="ChartLine"
        title="还没有可对比的成绩"
        description="至少记录一次成绩后，这里会显示各科对比。"
      />
    </section>
  </div>
</template>

<style scoped>
.chart-stage {
  position: relative;
}

.chart-status {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--muted);
  font-size: 0.875rem;
}
</style>
