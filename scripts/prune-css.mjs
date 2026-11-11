#!/usr/bin/env node
/**
 * 剪掉「已经没有任何模板引用」的 CSS 规则。
 *
 * 为什么不自动推断死类：模板里存在 `preview-cell-${id}` 这类拼接类名，
 * 「CSS 里定义了但 .vue 里搜不到」并不等于死类，自动推断会误删。
 * 所以死类清单必须由调用方显式给出，本脚本只负责安全地摘除规则。
 *
 * 安全策略：
 * - 一个规则的选择器列表按顶层逗号拆开，只丢掉命中死类的那些选择器；
 *   只要还剩一个活选择器，规则就保留（不会误伤 `.a, .b {}` 里的 .b）。
 * - 递归进入 @media / @supports / @layer / @container；块内全空则整块丢掉。
 * - 扫描时跳过注释和字符串，避免把注释里的 {} 当成结构。
 *
 * 用法：
 *   node scripts/prune-css.mjs records-hero records-metric            # 预演
 *   node scripts/prune-css.mjs records-hero records-metric --write    # 落盘
 */
import fs from "node:fs";
import path from "node:path";

const CSS_FILES = [
  "src/styles/main.css",
  "src/styles/tablet.css",
  "src/styles/mistakes-refresh.css",
  "src/styles/design-system.css"
];

const args = process.argv.slice(2);
const write = args.includes("--write");
const deadClasses = args.filter((item) => !item.startsWith("--"));

if (!deadClasses.length) {
  console.error("请至少给出一个死类名，例如：node scripts/prune-css.mjs records-hero --write");
  process.exit(1);
}

const deadSet = new Set(deadClasses);

/** 选择器里是否引用了死类（要求 .name 是完整类名，避免 records-hero 命中 records-hero-grid） */
function referencesDead(selector) {
  for (const name of deadSet) {
    const re = new RegExp(`\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
    if (re.test(selector)) return true;
  }
  return false;
}

function skipComment(src, i) {
  const end = src.indexOf("*/", i + 2);
  return end === -1 ? src.length : end + 2;
}

function skipString(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== quote) {
    if (src[j] === "\\") j += 1;
    j += 1;
  }
  return j + 1;
}

/** 找到下一个顶层 { 或 }，跳过注释/字符串/括号内的内容 */
function findTopLevelBrace(src, from) {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "*") {
      i = skipComment(src, i);
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(src, i);
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (depth === 0 && (c === "{" || c === "}")) return i;
    i += 1;
  }
  return -1;
}

/**
 * 把 prelude 拆成「前导注释与空白」+「真正的选择器文本」。
 * 否则摘除选择器时会把规则上方的注释（尤其是章节分隔注释）一起丢掉。
 */
function splitTrivia(prelude) {
  const lastComment = prelude.lastIndexOf("*/");
  if (lastComment !== -1) {
    let cut = lastComment + 2;
    while (cut < prelude.length && /\s/.test(prelude[cut])) cut += 1;
    return { trivia: prelude.slice(0, cut), rest: prelude.slice(cut) };
  }
  const leading = prelude.match(/^\s*/)[0];
  return { trivia: leading, rest: prelude.slice(leading.length) };
}

/** 按顶层逗号拆分选择器列表 */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "*") {
      i = skipComment(text, i);
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      continue;
    }
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (depth === 0 && c === separator) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  parts.push(text.slice(start));
  return parts;
}

function processCss(src, stats) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "*") {
      const stop = skipComment(src, i);
      out += src.slice(i, stop);
      i = stop;
      continue;
    }

    const braceIdx = findTopLevelBrace(src, i);
    if (braceIdx === -1) {
      out += src.slice(i);
      break;
    }
    if (src[braceIdx] === "}") {
      // 交给调用方处理（嵌套块的结束）
      out += src.slice(i, braceIdx);
      return { out, next: braceIdx + 1 };
    }

    const prelude = src.slice(i, braceIdx);
    // 先剥掉前导注释再判断是不是 @ 规则。
    // 这里踩过一个坑：原来直接对 prelude.trim() 判断 startsWith("@")，
    // 而本项目几乎每个 @media 上方都有一行说明注释，于是 trimmed 以 "/*" 开头，
    // 判断失败 → 整个 @media 块被当成普通规则原样拷贝，**再也没有递归进去**。
    // 后果是媒体查询里的死规则一条都删不掉（tablet.css 整份都是 @media，全被跳过）。
    const { trivia, rest } = splitTrivia(prelude);
    const trimmed = rest.trim();

    // 找配对的花括号
    let depth = 1;
    let j = braceIdx + 1;
    while (j < src.length) {
      const c = src[j];
      if (c === "/" && src[j + 1] === "*") {
        j = skipComment(src, j);
        continue;
      }
      if (c === '"' || c === "'") {
        j = skipString(src, j);
        continue;
      }
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      j += 1;
    }
    const body = src.slice(braceIdx + 1, j);

    if (trimmed.startsWith("@")) {
      if (/^@(media|supports|layer|container)\b/.test(trimmed)) {
        const inner = processCss(body, stats);
        if (inner.out.trim()) {
          out += `${prelude}{${inner.out}}`;
        } else {
          stats.droppedAtRules += 1;
        }
      } else {
        out += `${prelude}{${body}}`;
      }
    } else {
      const selectors = splitTopLevel(rest, ",");
      const kept = selectors.filter((selector) => !referencesDead(selector));
      stats.removedSelectors += selectors.length - kept.length;
      if (kept.length) {
        if (kept.length !== selectors.length) stats.partialRules += 1;
        out += `${trivia}${kept.join(",")}{${body}}`;
      } else {
        // 规则整体作废，但保留它上方的注释，避免丢掉章节分隔说明
        stats.droppedRules += 1;
        stats.droppedList.push(rest.trim().replace(/\s+/g, " ").slice(0, 90));
        out += trivia;
      }
    }

    i = j + 1;
  }
  return { out, next: i };
}

const cwd = process.cwd();
let totalDropped = 0;
let totalSelectors = 0;

for (const relative of CSS_FILES) {
  const file = path.join(cwd, relative);
  if (!fs.existsSync(file)) continue;

  const source = fs.readFileSync(file, "utf8");
  const stats = { droppedRules: 0, removedSelectors: 0, partialRules: 0, droppedAtRules: 0, droppedList: [] };
  const { out } = processCss(source, stats);

  const before = source.split("\n").length;
  const after = out.split("\n").length;
  totalDropped += stats.droppedRules;
  totalSelectors += stats.removedSelectors;

  const changed = out !== source;
  console.log(
    `${changed ? "→" : " "} ${relative.padEnd(32)} 丢规则 ${String(stats.droppedRules).padStart(3)} · ` +
      `摘选择器 ${String(stats.removedSelectors).padStart(3)} · 部分摘除 ${String(stats.partialRules).padStart(2)} · ` +
      `空媒体块 ${String(stats.droppedAtRules).padStart(2)} · 行数 ${before} → ${after}`
  );
  for (const item of stats.droppedList.slice(0, 6)) console.log(`      - ${item}`);
  if (stats.droppedList.length > 6) console.log(`      … 另有 ${stats.droppedList.length - 6} 条`);

  if (write && changed) fs.writeFileSync(file, out, "utf8");
}

console.log(
  `\n${write ? "已写入" : "预演（未写入）"}：共丢 ${totalDropped} 条规则、摘除 ${totalSelectors} 个选择器。`
);
if (!write) console.log("确认无误后加 --write 落盘。");
