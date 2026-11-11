/**
 * 找出「CSS 里定义了、但源码里没有任何引用」的类名（候选清单，不自动删）。
 *
 * 为什么不能只靠「搜字符串」：
 * 这个项目里有两类类名不是以字面量出现的，直接搜会全部误报成死类 ——
 *   1. 模板字符串拼出来的：`tone-${issue.tone}`、`level-${cell.level}`、
 *      `matrix-field-${fieldId}`、`preview-cell-${fieldId}`
 *   2. 数据里带的裸类名：`:class="item.type"`（通知的 info/error/success、
 *      公告的 feature/polish）
 * 这两类都必须在扫描时排除，否则会删掉正在用的样式。
 * （scripts/prune-css.mjs 的注释里也提过同一个坑。）
 *
 * 输出是**候选**，不是结论 —— 删除前要按 REDESIGN 里的流程做截图比对。
 *
 * 用法：node scripts/find-dead-css.mjs
 */
import fs from "node:fs";
import path from "node:path";

const CSS_FILES = [
  "src/styles/main.css",
  "src/styles/tablet.css",
  "src/styles/mistakes-refresh.css",
  "src/styles/design-system.css"
];

/** 模板字符串拼出来的类名前缀（见文件头说明，改代码时若新增拼接要同步加到这里） */
const DYNAMIC_PREFIXES = ["level-", "matrix-field-", "preview-cell-", "tone-"];

/** 由数据直接提供的裸类名 */
const DATA_CLASSES = new Set(["info", "error", "success", "feature", "polish"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 抽 CSS 类名，跳过注释 */
function classesInCss(source) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  const found = new Set();
  for (const match of clean.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) found.add(match[1]);
  return found;
}

const cssClasses = new Set();
const classFiles = new Map();
for (const file of CSS_FILES) {
  if (!fs.existsSync(file)) continue;
  for (const name of classesInCss(fs.readFileSync(file, "utf8"))) {
    cssClasses.add(name);
    if (!classFiles.has(name)) classFiles.set(name, []);
    classFiles.get(name).push(path.basename(file));
  }
}

const sources = walk("src")
  .filter((file) => /\.(vue|js|ts)$/.test(file))
  .map((file) => ({ file, text: fs.readFileSync(file, "utf8") }));
const allText = sources.map((s) => s.text).join("\n");

/**
 * 是否被引用。
 * 用前后边界排除「子串巧合」：`.empty-state` 在 `class="mobile-empty-state"`
 * 里出现时不算被引用 —— 它们是两个不同的类。
 */
function isReferenced(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(allText);
}

function isDynamic(name) {
  if (DATA_CLASSES.has(name)) return true;
  return DYNAMIC_PREFIXES.some((prefix) => name.startsWith(prefix));
}

const dead = [...cssClasses].filter((name) => !isDynamic(name) && !isReferenced(name)).sort();

// --list 只输出类名，方便直接喂给 prune-css：
//   node scripts/prune-css.mjs $(node scripts/find-dead-css.mjs --list) --write
if (process.argv.includes("--list")) {
  console.log(dead.join(" "));
  process.exit(0);
}

console.log(`CSS 类名共 ${cssClasses.size} 个`);
console.log(`排除拼接/数据类名 ${[...cssClasses].filter(isDynamic).length} 个后，`);
console.log(`未被引用的候选 ${dead.length} 个：\n`);
for (const name of dead) {
  console.log(`  ${name.padEnd(36)} ${(classFiles.get(name) || []).join(", ")}`);
}
