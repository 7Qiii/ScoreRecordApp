/**
 * 系统公告面板检查。
 *
 * 背景：公告以前是硬编码在组件里的，最后一条停在 2026-08-13，而且铃铛角标
 * 写的是「公告条数」—— 永远显示 4，看过也不消。现在公告由 docs/REDESIGN.md
 * 生成（见 scripts/gen-announcements.mjs），这个脚本负责钉住应用侧的行为。
 *
 * 为什么必须用浏览器查，而不是只查生成结果：
 *   1. 内容对不对是生成器的事，但「渲染出来是不是 13 条、顺序对不对」是组件的事；
 *   2. 更重要的：公告从 4 条变成 13 条之后，弹层会不会**被裁掉而不是滚动**。
 *      弹层是 display:grid + overflow:hidden，隐式行是 auto（= max-content），
 *      列表撑到内容高度后直接被父级剪掉，列表自己的 overflow:auto 不生效。
 *      这种问题在源码里看不出来，只有量 scrollHeight 才知道。
 *   3. 角标「看过要消」依赖 localStorage，也得真跑一遍。
 *
 * 用法：
 *   node scripts/check-announcements.mjs
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createRequire } from "node:module";
import { listenSafePort } from "./lib/safe-listen.mjs";

const WORKSPACE = "C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace";

function loadChromium() {
  const candidates = [
    () => createRequire(`${WORKSPACE}/package.json`)("playwright-core"),
    () => createRequire(import.meta.url)("playwright-core")
  ];
  for (const load of candidates) {
    try {
      return load().chromium;
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error(`没有找到 playwright-core，请先在 ${WORKSPACE} 里执行 npm install playwright-core`);
}

const chromium = loadChromium();
const DIST = join(process.cwd(), "dist");

const BROWSER_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
];

function findBrowser() {
  const found = BROWSER_CANDIDATES.find((path) => existsSync(path));
  if (!found) throw new Error("没有找到 Chrome / Edge");
  return found;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

async function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let file = join(DIST, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ""));
    if (!existsSync(file) || !extname(file)) file = join(DIST, "index.html");
    try {
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await listenSafePort(server);
  return { server, port: server.address().port };
}

// 直接 import 生成结果：它就是普通 ESM，没有 Vite 专属语法。
// 期望值从「唯一来源」里取，而不是在测试里再抄一遍条数。
const { announcements } = await import("../src/data/announcements.js");

if (!existsSync(DIST)) throw new Error("dist/ 不存在，先跑一次 npm run build。");

const problems = [];
const ok = (message) => console.log(`  ok   ${message}`);
const bad = (message) => {
  problems.push(message);
  console.log(`  问题 ${message}`);
};
const check = (condition, good, badMessage) => (condition ? ok(good) : bad(badMessage));

const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text().slice(0, 160));
});
page.on("pageerror", (error) => consoleErrors.push(String(error.message).slice(0, 160)));

const TRIGGER = 'button[aria-label="系统公告"]';
const POPOVER = ".announcement-popover";
const ITEM = ".announcement-item";

try {
  console.log(`检查系统公告面板（生成结果 ${announcements.length} 条）\n`);

  await page.goto(`${base}/#/`, { waitUntil: "load" });
  await page.locator(TRIGGER).waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(600);

  // 1. 没看过时，角标显示未读数（超过 9 显示 9+）
  const expectedBadge = announcements.length > 9 ? "9+" : String(announcements.length);
  const badgeText = (await page.locator(".notification-dot").first().innerText().catch(() => ""))?.trim() ?? "";
  check(
    badgeText === expectedBadge,
    `未读角标显示「${badgeText}」`,
    `未读角标应为「${expectedBadge}」，实际「${badgeText}」—— 角标没跟上公告条数`
  );

  // 2. 打开面板
  await page.locator(TRIGGER).click({ timeout: 8000 });
  await page.locator(POPOVER).waitFor({ state: "visible", timeout: 5000 });
  await page.waitForTimeout(400);

  // 3. 条数、顺序、内容都要和生成结果一致
  const count = await page.locator(ITEM).count();
  check(
    count === announcements.length,
    `时间线渲染 ${count} 条，与更新日志一致`,
    `时间线应渲染 ${announcements.length} 条，实际 ${count} 条`
  );

  const renderedTitles = await page.locator(`${ITEM} strong`).allInnerTexts();
  const expectedTitles = announcements.map((item) => item.title);
  check(
    JSON.stringify(renderedTitles.map((text) => text.trim())) === JSON.stringify(expectedTitles),
    "顺序正确：最新的排在最前面",
    `顺序不对。实际第一条「${renderedTitles[0]?.trim()}」，应为「${expectedTitles[0]}」`
  );

  const firstDate = (await page.locator(`${ITEM} span`).first().innerText()).trim();
  check(
    /^\d{4}-\d{2}-\d{2}$/.test(firstDate),
    `每条都带日期（最新 ${firstDate}）`,
    `日期格式不对：「${firstDate}」`
  );

  // 4. 关键：13 条必须能滚动，而不是被弹层裁掉
  const metrics = await page.evaluate((selector) => {
    const list = document.querySelector(selector);
    if (!list) return null;
    const popover = list.closest(".announcement-popover");
    list.scrollTop = 99999;
    return {
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
      scrollTop: list.scrollTop,
      popoverBottom: popover?.getBoundingClientRect().bottom ?? 0,
      viewportHeight: window.innerHeight
    };
  }, ".announcement-list");

  if (!metrics) {
    bad("找不到 .announcement-list");
  } else {
    check(
      metrics.scrollHeight > metrics.clientHeight + 20,
      `列表内容确实超出容器（${metrics.scrollHeight} > ${metrics.clientHeight}），走的是滚动`,
      `列表内容没有超出容器（${metrics.scrollHeight} vs ${metrics.clientHeight}），这个断言失去意义`
    );
    check(
      metrics.scrollTop > 0,
      `列表真的能滚（scrollTop 到 ${metrics.scrollTop}）`,
      "列表滚不动 —— 公告被弹层裁掉了，用户看不到下面的内容"
    );
    check(
      metrics.popoverBottom <= metrics.viewportHeight + 1,
      `弹层没有溢出视口（底边 ${Math.round(metrics.popoverBottom)} / 视口 ${metrics.viewportHeight}）`,
      `弹层溢出了视口：底边 ${Math.round(metrics.popoverBottom)} > 视口 ${metrics.viewportHeight}`
    );
  }

  // 5. 「通知」页签是另一份数据，不能被时间线顶掉
  await page.locator('.announcement-tabs button:has-text("通知")').click({ timeout: 5000 });
  await page.waitForTimeout(300);
  const noticeCount = await page.locator(ITEM).count();
  check(
    noticeCount > 0 && noticeCount < announcements.length,
    `「通知」页签有自己的内容（${noticeCount} 条）`,
    `「通知」页签内容不对：${noticeCount} 条`
  );

  // 6. 打开过之后角标要消，而且刷新后仍然不回来
  await page.locator('button[aria-label="关闭公告"]').click({ timeout: 5000 });
  await page.waitForTimeout(400);
  check(
    (await page.locator(".notification-dot").count()) === 0,
    "看过之后角标消失",
    "看过了角标还在 —— 角标等于公告总条数，永远不会消"
  );

  await page.reload({ waitUntil: "load" });
  await page.locator(TRIGGER).waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(600);
  check(
    (await page.locator(".notification-dot").count()) === 0,
    "刷新后角标仍然不回来（已读状态持久化）",
    "刷新后角标又出现了 —— 已读状态没存下来"
  );

  // 7. 新增一条公告时角标要重新出现
  await page.evaluate(() => localStorage.removeItem("exam-tracker-announcements-seen"));
  await page.reload({ waitUntil: "load" });
  await page.locator(TRIGGER).waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(600);
  check(
    (await page.locator(".notification-dot").count()) === 1,
    "清掉已读记录后角标重新出现",
    "清掉已读记录后角标没回来"
  );

  if (consoleErrors.length) bad(`控制台报错：${consoleErrors[0]}`);
} catch (error) {
  bad(`执行出错：${String(error.message)}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) {
  console.log(`\n✗ 系统公告检查未通过（${problems.length} 个问题）`);
  process.exit(1);
}
console.log("\n✓ 系统公告检查通过 —— 内容与更新日志一致，列表能滚动，角标看过即消。");
