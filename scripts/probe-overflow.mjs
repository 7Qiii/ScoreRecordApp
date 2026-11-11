/**
 * 针对单个元素的祖先链诊断：把某个选择器的父级链上每一层的
 * overflow / width / 是否可横向滚动全部打出来。
 *
 * 用法：node scripts/probe-overflow.mjs --route=/records --size=1440x900 --selector=.table-wrap
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createRequire } from "node:module";
import { listenSafePort } from "./lib/safe-listen.mjs";

const WORKSPACE = "C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace";
const chromium = createRequire(`${WORKSPACE}/package.json`)("playwright-core").chromium;

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

function arg(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const route = arg("route", "/records");
const [w, h] = arg("size", "1440x900").split("x").map(Number);
const selector = arg("selector", ".table-wrap");

const server = createServer(async (req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (pathname === "/") pathname = "/index.html";
  let filePath = join(DIST, normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!existsSync(filePath)) filePath = join(DIST, "index.html");
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("nf");
  }
});

await listenSafePort(server);
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
await page.goto(`http://127.0.0.1:${port}/#${route}`, { waitUntil: "load" });
await page.waitForTimeout(700);

const report = await page.evaluate((sel) => {
  const describe = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      cls: typeof el.className === "string" ? el.className.trim().slice(0, 60) : "",
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      width: Math.round(rect.width),
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      overflowX: style.overflowX,
      display: style.display,
      maxWidth: style.maxWidth,
      gridTemplateColumns: style.gridTemplateColumns?.slice(0, 80)
    };
  };

  const target = document.querySelector(sel);
  const chain = [];
  let node = target;
  while (node && node !== document.documentElement) {
    chain.push(describe(node));
    node = node.parentElement;
  }
  chain.push(describe(document.documentElement));

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    docScrollWidth: document.documentElement.scrollWidth,
    docClientWidth: document.documentElement.clientWidth,
    targetFound: Boolean(target),
    chain
  };
}, selector);

console.log(`route=${route} size=${w}x${h} selector=${selector}`);
console.log(`viewport=${report.viewport.w}x${report.viewport.h} docScrollWidth=${report.docScrollWidth} docClientWidth=${report.docClientWidth}`);
if (!report.targetFound) console.log("!! 目标选择器没找到");
for (const item of report.chain) {
  console.log(
    `${item.tag.padEnd(8)} ${String(item.cls).padEnd(42)} L=${String(item.left).padStart(6)} R=${String(item.right).padStart(6)} w=${String(item.width).padStart(5)} cw=${String(item.clientWidth).padStart(5)} sw=${String(item.scrollWidth).padStart(5)} ox=${item.overflowX.padEnd(8)} mw=${item.maxWidth}`
  );
}

await browser.close();
server.close();
