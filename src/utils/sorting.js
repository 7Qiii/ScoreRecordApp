/**
 * 列表排序的兜底比较。
 *
 * 为什么需要单独一个文件：`Array.prototype.sort` 在比较函数返回 0 时会保持
 * **输入顺序**，而输入顺序通常来自 IndexedDB 的读取顺序 —— 那个顺序在不同次
 * 打开之间并不稳定。表现就是「刷新一下，两条同日期的成绩换了位置」，
 * 而且完全不报错，很难往排序上想。
 *
 * 所以每条排序链的最后一环都必须是**唯一且稳定**的字段，id 正好是。
 *
 * 一个反例，值得记住：种子数据里两条错题的 createdAt 完全相同，靠 id 兜底后
 * 同一次会话内确实稳定了，但每次全新打开都会用新生成的 uuid 重新播种，
 * 于是「谁在前」每次都不一样。也就是说 —— id 兜底只能消除「同一次数据内的
 * 不稳定」，消除不了「数据本身每次都不同」。后者的解法是让被比较的字段本身
 * 有区分度（给种子数据不同的创建时间），而不是继续往比较函数里加兜底。
 */

/** 按 id 升序。id 缺失时按空串处理，保证不抛错且仍然确定。 */
export function byId(a, b) {
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

/**
 * 时间戳倒序，相同则按 id。
 * timeA / timeB 是毫秒数（调用方负责把各种时间表示统一成毫秒）。
 */
export function compareByTimeThenId(timeA, timeB, a, b) {
  const diff = timeB - timeA;
  if (diff) return diff;
  return byId(a, b);
}
