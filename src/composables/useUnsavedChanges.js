/**
 * 「填了一半」的表单保护。
 *
 * 为什么需要：录入表单是可折叠的（首页「记录成绩」）或弹窗里的，
 * 填到一半点「收起」、点关闭、或者顺手点一下侧栏换页，内容会**静默消失**。
 * 实测过三条路径全是这样。录入一条成绩要填科目、卷名、分数、用时、备注，
 * 错题还要传图片和跑 AI 解析 —— 丢掉一次的成本很高。
 *
 * 上一轮给弹窗加了「返回手势关闭」之后，误关的概率还变高了：
 * 手机上从边缘滑一下原本是「返回」，现在变成了「关掉表单」。
 *
 * 为什么做成全局的而不是每个页面各写一遍：
 * 表单出现在 5 个地方（首页内联、成绩详情、成绩列表弹窗、错题详情内联、
 * 错题列表弹窗），逐个写必然漏，而且「换页时保护」这件事本身就只有
 * 路由层能统一兜住。
 *
 * 两个入口：
 *   - useUnsavedForm(isDirty)      —— 表单侧：把「我脏了」登记进来
 *   - confirmDiscardChanges()      —— 关闭侧：问一句再放行
 * 换页由 router/index.js 的全局守卫统一拦截，页面不用管。
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useConfirm } from "./useConfirm";

/**
 * 当前处于「改过但没保存」状态的表单。
 *
 * 用 token 集合而不是一个布尔值：同一时刻可能不止一个表单挂着
 * （比如成绩列表的弹窗开着、背后的详情页表单也还在），
 * 用一个布尔值的话先关掉的那个会把标记清成 false，另一个就漏保护了。
 */
const dirtyTokens = ref(new Set());

export const hasUnsavedChanges = computed(() => dirtyTokens.value.size > 0);

function setDirty(token, value) {
  const next = new Set(dirtyTokens.value);
  if (value) next.add(token);
  else next.delete(token);
  dirtyTokens.value = next;
}

/**
 * 表单侧调用：把 isDirty 这个 ref / computed 登记为「未保存内容」。
 * 必须在 setup 里调用（用了 onBeforeUnmount）。
 */
export function useUnsavedForm(isDirty) {
  const token = {};
  // flush: "sync" 不能省。保存成功后表单会立刻 resetDirty() 再 emit("saved")，
  // 父组件同步地把表单关掉、顺手问一句 confirmDiscardChanges()。默认的 pre
  // 刷新是异步的，那一刻 dirtyTokens 里还留着这个 token —— 结果就是「刚存完
  // 反而弹一个放弃确认」。同步刷新让注销发生在 resetDirty() 返回之前。
  watch(isDirty, (value) => setDirty(token, value), { immediate: true, flush: "sync" });
  // 表单被销毁（关闭、保存成功、换页）时要注销，否则标记会一直挂着，
  // 之后每次换页都弹一个没有意义的确认框。
  onBeforeUnmount(() => setDirty(token, false));
}

function normalizeFieldValue(value) {
  return String(value ?? "").trim();
}

/**
 * 表单侧的「一把梭」用法：给出**用户真正会输入**的字段名，自动算出 isDirty
 * 并登记到全局，同时暴露两个基线维护方法。
 *
 * 为什么不能简单地看「字段非不非空」：表单里有一堆字段是**自动填**的
 * （科目取第一个可见科目、满分跟着科目走、卷型跟着科目/卷名推、日期默认今天），
 * 而且科目表是**异步**来的（store.load()）。所以「挂载那一刻快照基线」是错的
 * —— 快照到的是空值，等自动填充一跑，表单一打开就是「脏」的。
 *
 * 为什么也不能只看「有没有触发过 input 事件」：错题的 AI 解析是**代码写进去的**
 * （analyzeWithAi 直接改 form.title / questionText / analysis），一个事件都没有；
 * 上传的图片同理。而这些恰恰是花了一次 AI 调用换来的、最不该丢的内容。
 *
 * 所以反过来做：让表单在**自动填充结束**的时候调 resetDirty() 记下当时的字段值
 * 当基线，之后只要用户动了其中任何一个字段就算脏。编辑态也一样 —— 自动填充把
 * 记录的值灌进来时顺手记成基线，不用再单独跟 record 逐字段比（还能避开
 * paperVariant 这类「落库前会被规范化」的字段造成的假脏）。
 *
 * 注意 resetDirty() 是**无条件**重记基线的，所以调用它的时机很关键：
 * 只能用在「表单内容确实刚刚被整体设成某个已知状态」的时候（自动填充结束、保存成功）。
 * 反过来，自动填充本身必须**只在源变了的时候**才跑 —— 判脏只管得住
 * 「有没有未保存内容」这个标记，管不住内容本身会不会被覆盖。
 *
 * @param {object} form      reactive 表单对象
 * @param {string[]} fields  用户会真正输入的字段名
 * @param {{ extraDirty?: () => boolean }} [options] 额外的判脏条件（比如「已经选了图片」）
 */
export function useUnsavedFields(form, fields, { extraDirty } = {}) {
  /** 自动填充刚结束时各字段的样子；null = 还没填过 */
  const prefill = ref(null);

  const isDirty = computed(() => {
    if (extraDirty?.()) return true;
    const base = prefill.value;
    if (!base) return false;
    return fields.some((field) => normalizeFieldValue(form[field]) !== normalizeFieldValue(base[field]));
  });

  /**
   * 把当前内容认作基线，表单回到「没改过」。
   * 两处会调：保存成功之后、以及自动填充灌完一轮之后。
   */
  function resetDirty() {
    prefill.value = Object.fromEntries(fields.map((field) => [field, form[field]]));
  }

  useUnsavedForm(isDirty);

  return { isDirty, resetDirty };
}

/**
 * 关闭侧调用：现在能不能关 / 能不能走。
 * 没有未保存内容直接放行；有的话问一句。
 * @returns {Promise<boolean>} true = 可以继续（关闭或离开）
 */
export async function confirmDiscardChanges() {
  if (!hasUnsavedChanges.value) return true;
  const { confirm } = useConfirm();
  return confirm({
    title: "放弃未保存的内容？",
    message: "表单里还有没保存的内容，离开后就会丢失。",
    confirmText: "放弃",
    cancelText: "继续编辑",
    tone: "danger",
    // 这个确认框有可能是**路由守卫**弹的，而守卫正卡在一次导航中间。
    // 此时压/弹历史记录会打乱 vue-router「导航被中止就退回原地址」的那次 go(-1)：
    // 实测到两种坏结果 —— 点了「放弃」却没换页；按返回取消后地址栏和画面不一致。
    noHistory: true
  });
}
