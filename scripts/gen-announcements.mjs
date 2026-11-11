/**
 * 从 docs/REDESIGN.md 生成应用里的「系统公告」时间线。
 *
 * 为什么要有这个脚本：
 *   公告以前是**硬编码在组件里的第二个副本**，最后一条停在 2026-08-13。
 *   同一份「最近改了什么」存了两处，必然有一处会馊 —— 而用户看到的偏偏是
 *   会馊的那一处。现在把更新日志本身当唯一来源：我每轮写完 docs/REDESIGN.md，
 *   公告就自己出来了，不需要再手抄一份。
 *
 * 数据从哪来：
 *   - 标题行：`## 第N轮：<文档标题>（YYYY-MM-DD）`
 *   - 公告行：紧跟在标题后的 `> 公告｜<类型>｜<公告标题>｜<摘要>`
 *   日期必须写在标题里，不去问 git —— Vercel 构建环境里 git 历史不保证可用，
 *   而公告缺日期只是小事，构建挂掉是大事。
 *
 * 漏写会怎样：
 *   某一轮没有公告行时，用文档标题兜底，并打印醒目警告；`--check` 直接失败。
 *   故意不让构建挂掉：公告少一条是内容问题，不该拦下一个正常部署。
 *
 * 用法：
 *   node scripts/gen-announcements.mjs           # 写 src/data/announcements.js
 *   node scripts/gen-announcements.mjs --check   # 只校验，过期就退出码 1
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SOURCE = join(ROOT, "docs/REDESIGN.md");
const TARGET = join(ROOT, "src/data/announcements.js");
const checkOnly = process.argv.includes("--check");

/** 中文数字 → 阿拉伯数字。用来给同一天的多轮排序。 */
const DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function roundNumber(text) {
  if (text === "十") return 10;
  if (text.startsWith("十")) return 10 + (DIGITS[text[1]] ?? 0);
  if (text.endsWith("十")) return (DIGITS[text[0]] ?? 0) * 10;
  if (text.includes("十")) {
    const [tens, ones] = text.split("十");
    return (DIGITS[tens] ?? 0) * 10 + (DIGITS[ones] ?? 0);
  }
  return DIGITS[text] ?? 0;
}

/** 文档里的类型词 → 组件用的样式类。修复单独一色，和优化区分开。 */
const TYPE_CLASS = { 功能: "feature", 优化: "polish", 修复: "fix" };

const HEADING = /^## (第([一二三四五六七八九十]+)轮)：(.*?)（(\d{4}-\d{2}-\d{2})）\s*$/;
const ANNOUNCE = /^> 公告｜(功能|优化|修复)｜(.+?)(?:｜(.+))?\s*$/;

const source = readFileSync(SOURCE, "utf8");
const lines = source.split("\n");

const rounds = [];
const missing = [];

for (let i = 0; i < lines.length; i += 1) {
  const heading = lines[i].match(HEADING);
  if (!heading) continue;

  const [, , numeral, docTitle, date] = heading;
  const number = roundNumber(numeral);

  // 公告行必须紧跟在标题之后（中间只允许空行）
  let announcement = null;
  for (let j = i + 1; j < lines.length && j <= i + 3; j += 1) {
    if (!lines[j].trim()) continue;
    announcement = lines[j].match(ANNOUNCE);
    break;
  }

  if (!announcement) {
    missing.push(`第${numeral}轮：${docTitle}`);
    rounds.push({
      id: `round-${number}`,
      type: "feature",
      title: docTitle,
      summary: "",
      date,
      number
    });
    continue;
  }

  const [, type, title, summary = ""] = announcement;
  rounds.push({
    id: `round-${number}`,
    type: TYPE_CLASS[type] ?? "feature",
    title: title.trim(),
    summary: summary.trim(),
    date,
    number
  });
}

// 新的在前；同一天按轮次倒序
rounds.sort((a, b) => (a.date === b.date ? b.number - a.number : a.date < b.date ? 1 : -1));

const body = rounds
  .map((round) =>
    [
      "  {",
      `    id: ${JSON.stringify(round.id)},`,
      `    type: ${JSON.stringify(round.type)},`,
      `    title: ${JSON.stringify(round.title)},`,
      `    summary: ${JSON.stringify(round.summary)},`,
      `    time: ${JSON.stringify(round.date)}`,
      "  }"
    ].join("\n")
  )
  .join(",\n");

const output = `/**
 * 系统公告时间线。
 *
 * 这个文件是 scripts/gen-announcements.mjs 从 docs/REDESIGN.md 生成的，不要手改 ——
 * 改了会在 npm run check 里被判定为过期。要改内容请改更新日志里的
 * \`> 公告｜类型｜标题｜摘要\` 那一行，然后重新生成。
 *
 * 共 ${rounds.length} 条，最新一条 ${rounds[0]?.date ?? "—"}。
 */
export const announcements = [
${body}
];
`;

if (checkOnly) {
  const current = existsSync(TARGET) ? readFileSync(TARGET, "utf8") : "";
  const stale = current !== output;
  if (missing.length) {
    console.error("✗ 更新日志里有轮次没写公告行（> 公告｜类型｜标题｜摘要）：");
    missing.forEach((item) => console.error(`    · ${item}`));
  }
  if (stale) {
    console.error("✗ src/data/announcements.js 和更新日志不一致，跑一下 node scripts/gen-announcements.mjs");
  }
  if (missing.length || stale) process.exit(1);
  console.log(`✓ 系统公告与更新日志一致（${rounds.length} 条，最新 ${rounds[0]?.date ?? "—"}）`);
} else {
  writeFileSync(TARGET, output, "utf8");
  console.log(`已生成 src/data/announcements.js：${rounds.length} 条，最新 ${rounds[0]?.date ?? "—"}`);
  if (missing.length) {
    console.warn("\n⚠ 下面这些轮次没有写公告行，暂时用文档标题兜底：");
    missing.forEach((item) => console.warn(`    · ${item}`));
    console.warn("  补一行 `> 公告｜类型｜标题｜摘要`（类型：功能 / 优化 / 修复）即可。");
  }
}
