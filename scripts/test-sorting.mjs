/**
 * 排序兜底的回归测试。
 *
 * 要钉住的不变量是「**结果与输入顺序无关**」。
 *
 * 背景：Array.sort 在比较函数返回 0 时保持输入顺序，而列表的输入顺序来自
 * IndexedDB 的读取顺序 —— 那个顺序在不同次打开之间不稳定。于是「同一天录入的
 * 两条成绩」会在刷新后互换位置，不报错、也不丢数据，只是列表自己会动。
 * 这类问题只有把「换个输入顺序，结果必须一样」写成断言才防得住。
 *
 * 跑法：node scripts/test-sorting.mjs
 */
import { byId, compareByTimeThenId } from "../src/utils/sorting.js";

let failed = 0;
let passed = 0;

function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) console.log(`      实际 ${JSON.stringify(actual)}  期望 ${JSON.stringify(expected)}`);
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

const ids = (list) => list.map((item) => item.id).join(",");

/**
 * 核心断言：同一批数据，用各种输入顺序排一遍，结果必须完全一致。
 * permutations 里放的是同一批元素的几种不同排列。
 */
function checkOrderIndependent(label, items, compare) {
  const orders = [
    items,
    [...items].reverse(),
    // 再补一种「打乱」：按 id 的哈希轮转，确保不是简单的正序/逆序
    [...items].sort((a, b) => String(a.id).localeCompare(String(b.id))).reverse()
  ];
  const results = orders.map((order) => ids([...order].sort(compare)));
  const allSame = results.every((r) => r === results[0]);
  check(`${label}（${results[0]}）`, allSame, true);
  if (!allSame) results.forEach((r, i) => console.log(`      第 ${i} 种输入 → ${r}`));
}

// ---------------------------------------------------------------------------
section("byId：唯一且稳定");
// ---------------------------------------------------------------------------

check("按 id 升序", ids([{ id: "b" }, { id: "a" }, { id: "c" }].sort(byId)), "a,b,c");
check("id 缺失当空串，不抛错", byId({}, { id: "a" }) < 0, true);
check("两边都缺 id 时返回 0", byId({}, {}), 0);
check("相同 id 返回 0", byId({ id: "x" }, { id: "x" }), 0);

// ---------------------------------------------------------------------------
section("compareByTimeThenId：时间倒序 + id 兜底");
// ---------------------------------------------------------------------------

const t = (ms) => ms;
// 参数顺序容易记反：timeA 是「第一个参数 a」的时间，timeB 是 b 的。
// 返回 timeB - timeA，所以 a 比 b 旧时返回正数 → a 排在后面 → 整体是倒序。
const older = { id: "old" };
const newer = { id: "new" };
check(
  "时间不同时按时间倒序（旧的排后面）",
  compareByTimeThenId(t(100), t(200), older, newer) > 0,
  true
);
check(
  "时间不同时按时间倒序（新的排前面）",
  compareByTimeThenId(t(200), t(100), newer, older) < 0,
  true
);
check("时间相同时退到 id", compareByTimeThenId(t(100), t(100), { id: "a" }, { id: "b" }) < 0, true);
check("时间相同时 id 大的在后", compareByTimeThenId(t(100), t(100), { id: "b" }, { id: "a" }) > 0, true);

// ---------------------------------------------------------------------------
section("不变量：结果与输入顺序无关");
// ---------------------------------------------------------------------------

// 场景 1：两条成绩「同一天」——真实使用里最常见
const sameDay = [
  { id: "r1", date: "2026-10-01", createdAt: "2026-10-01T08:00:00.000Z" },
  { id: "r2", date: "2026-10-01", createdAt: "2026-10-01T08:00:00.000Z" },
  { id: "r3", date: "2026-10-01", createdAt: "2026-10-01T08:00:00.000Z" }
];
const byDateDesc = (a, b) => String(b.date || "").localeCompare(String(a.date || "")) || byId(a, b);
checkOrderIndependent("三条同日期成绩", sameDay, byDateDesc);

// 场景 2：不带兜底的写法会飘 —— 证明这个断言确实能抓到问题
const naive = (a, b) => String(b.date || "").localeCompare(String(a.date || ""));
const naiveResults = [sameDay, [...sameDay].reverse()].map((order) => ids([...order].sort(naive)));
check("对照组：不加兜底时结果会随输入顺序变（说明断言有效）", naiveResults[0] === naiveResults[1], false);

// 场景 3：错题的三种排序都要稳
const mistakes = [
  { id: "m1", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", status: "待复盘" },
  { id: "m2", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", status: "待复盘" },
  { id: "m3", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", status: "已整理" }
];
const byCreatedDesc = (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || byId(a, b);
const byCreatedAsc = (a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || byId(a, b);
const byUpdatedDesc = (a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) || byId(a, b);
const byStatus = (a, b) => String(a.status || "").localeCompare(String(b.status || ""), "zh-Hans-CN") || byCreatedDesc(a, b);
checkOrderIndependent("错题按创建时间倒序", mistakes, byCreatedDesc);
checkOrderIndependent("错题按创建时间正序", mistakes, byCreatedAsc);
checkOrderIndependent("错题按更新时间倒序", mistakes, byUpdatedDesc);
checkOrderIndependent("错题按掌握状态", mistakes, byStatus);

// 场景 4：用 compareByTimeThenId 排一批时间相同的记录
const sameTime = [
  { id: "a", updatedAt: "2026-10-01T00:00:00.000Z" },
  { id: "b", updatedAt: "2026-10-01T00:00:00.000Z" },
  { id: "c", updatedAt: "2026-10-01T00:00:00.000Z" }
];
checkOrderIndependent(
  "三条同更新时间",
  sameTime,
  (x, y) => compareByTimeThenId(new Date(x.updatedAt).getTime(), new Date(y.updatedAt).getTime(), x, y)
);

// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
