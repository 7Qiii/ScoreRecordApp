/**
 * 用时处理的回归测试。
 *
 * 这个文件盯的是一类很容易出、又很难发现的 bug：**同一个用时值被理解成两样**。
 *
 * 背景：录入端是「小时 + 分钟」两个框，存储端是一个整数分钟，展示端是
 * 「1 小时 30 分钟」。三处只要有一处理解不一致，用户就会遇到
 * 「我明明填了 1 小时 30 分，怎么变成 90 小时」或者
 * 「打开编辑框什么都没改，保存后用时没了」这种事，而且不会报错。
 *
 * 最要紧的一条不变量是 split → compose 的往返：
 *   拆成两个输入框、再合回去，必须还是原来的数。
 * 不成立的话，用户打开编辑弹窗、直接点保存，数据就悄悄变了。
 *
 * 跑法：node scripts/test-duration.mjs
 */
import {
  composeDuration,
  formatDuration,
  normalizeDurationMinutes,
  splitDurationMinutes
} from "../src/utils/recordDisplay.js";

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

// ---------------------------------------------------------------------------
section("归一：空值不能变成 0");
// ---------------------------------------------------------------------------

check("空串 → 空", normalizeDurationMinutes(""), "");
check("null → 空", normalizeDurationMinutes(null), "");
check("undefined → 空", normalizeDurationMinutes(undefined), "");
check("非数字 → 空", normalizeDurationMinutes("abc"), "");
check("负数 → 空（不是 0）", normalizeDurationMinutes(-5), "");
check("NaN → 空", normalizeDurationMinutes(NaN), "");
check("Infinity → 空", normalizeDurationMinutes(Infinity), "");
check("0 是合法值", normalizeDurationMinutes(0), 0);
check("数字字符串", normalizeDurationMinutes("90"), 90);
check("小数四舍五入", normalizeDurationMinutes(89.6), 90);
check("小数向下", normalizeDurationMinutes(89.4), 89);

// 「空」和「0」必须区分开：store 里 hasDuration() 是按 !== "" 判定的，
// 空值落成 0 会让「未记录用时」的健康检查漏报。
check("空与 0 不是一回事", normalizeDurationMinutes("") === normalizeDurationMinutes(0), false);

// ---------------------------------------------------------------------------
section("拆解：整数分钟 → 两个输入框");
// ---------------------------------------------------------------------------

check("空值拆成两个空框", JSON.stringify(splitDurationMinutes("")), JSON.stringify({ hours: "", minutes: "" }));
check("30 分钟 → 0 小时 30 分", JSON.stringify(splitDurationMinutes(30)), JSON.stringify({ hours: "0", minutes: "30" }));
check("60 分钟 → 1 小时 0 分", JSON.stringify(splitDurationMinutes(60)), JSON.stringify({ hours: "1", minutes: "0" }));
check("90 分钟 → 1 小时 30 分", JSON.stringify(splitDurationMinutes(90)), JSON.stringify({ hours: "1", minutes: "30" }));
check("180 分钟 → 3 小时 0 分", JSON.stringify(splitDurationMinutes(180)), JSON.stringify({ hours: "3", minutes: "0" }));
check("0 分钟 → 0 小时 0 分（不能是空）", JSON.stringify(splitDurationMinutes(0)), JSON.stringify({ hours: "0", minutes: "0" }));

// ---------------------------------------------------------------------------
section("合成：两个输入框 → 整数分钟");
// ---------------------------------------------------------------------------

check("两个都空 → 空（不是 0）", composeDuration("", ""), "");
check("两个都 undefined → 空", composeDuration(undefined, undefined), "");
check("只有小时", composeDuration("1", ""), 60);
check("只有分钟", composeDuration("", "30"), 30);
check("1 小时 30 分", composeDuration("1", "30"), 90);
check("3 小时", composeDuration("3", ""), 180);
check("0 小时 0 分 → 0（用户明确填了 0）", composeDuration("0", "0"), 0);
check("分钟超过 59 自动进位", composeDuration("0", "90"), 90);
check("分钟 150 进位成 2 小时 30 分", composeDuration("0", "150"), 150);
check("负数被夹到 0", composeDuration("-1", "-30"), 0);
check("小时小数向下取整（1.5 → 1 小时）", composeDuration("1.5", ""), 60);
check("非数字当 0", composeDuration("abc", "30"), 30);

// ---------------------------------------------------------------------------
section("往返：拆了再合必须还原");
// ---------------------------------------------------------------------------

// 这是最关键的一条。不成立就意味着「打开编辑框、不改任何东西、保存」会改数据。
const roundTripCases = ["", 0, 1, 30, 45, 59, 60, 61, 90, 120, 150, 180, 240, 359, 600, 89.6, "90"];
let roundTripFailed = 0;
for (const value of roundTripCases) {
  const normalized = normalizeDurationMinutes(value);
  const { hours, minutes } = splitDurationMinutes(value);
  const recomposed = composeDuration(hours, minutes);
  if (!Object.is(recomposed, normalized)) {
    roundTripFailed += 1;
    console.log(`FAIL  往返 ${JSON.stringify(value)} → 拆成 ${hours}/${minutes} → 合回 ${JSON.stringify(recomposed)}，应为 ${JSON.stringify(normalized)}`);
  }
}
check(`往返 ${roundTripCases.length} 个取值全部还原`, roundTripFailed, 0);

// ---------------------------------------------------------------------------
section("显示：分钟数 → 人话");
// ---------------------------------------------------------------------------

check("空 → 未记录", formatDuration(""), "未记录");
check("null → 未记录", formatDuration(null), "未记录");
check("0 → 未记录", formatDuration(0), "未记录");
check("负数 → 未记录", formatDuration(-10), "未记录");
check("自定义空态文案", formatDuration(0, { emptyLabel: "未记录用时" }), "未记录用时");
check("45 → 45 分钟", formatDuration(45), "45 分钟");
check("59 → 59 分钟", formatDuration(59), "59 分钟");
check("60 → 1 小时", formatDuration(60), "1 小时");
check("90 → 1 小时 30 分钟", formatDuration(90), "1 小时 30 分钟");
check("120 → 2 小时", formatDuration(120), "2 小时");
check("180 → 3 小时", formatDuration(180), "3 小时");
check("数字字符串也能格式化", formatDuration("90"), "1 小时 30 分钟");

// 输入框里看到的「1 小时 30 分」和列表里显示的「1 小时 30 分钟」必须是同一个数
check(
  "输入和显示对同一个值理解一致",
  composeDuration(...Object.values(splitDurationMinutes(90))) === 90 && formatDuration(90) === "1 小时 30 分钟",
  true
);

// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
