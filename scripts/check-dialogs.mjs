/**
 * 弹窗键盘可达性检查。
 *
 * 背景：手写弹窗挂上 `role="dialog" aria-modal="true"` 只是声明，浏览器**不会**
 * 因此限制焦点。之前的实测结果：导出面板按 Escape 关不掉，连按 12 次 Tab 有 6 次
 * 焦点跑到被遮住的页面按钮上，回车就点到了看不见的东西。鼠标用户完全无感。
 *
 * 这个脚本把四条规则钉死，防止以后再退化：
 *   1. 打开后焦点进入弹窗
 *   2. Tab / Shift+Tab 若干次，焦点始终留在弹窗内
 *   3. Escape 能关掉
 *   4. 关掉后焦点回到打开它的那个按钮
 *   5. 返回手势（手机侧滑 / 安卓系统返回键）只关弹窗、不换页
 *
 * 用法：
 *   node scripts/check-dialogs.mjs
 *   node scripts/check-dialogs.mjs --only=导出面板
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createRequire } from "node:module";
import { listenSafePort } from "./lib/safe-listen.mjs";

// playwright-core 装在托管工作区里（不污染项目依赖），ESM 不认 NODE_PATH
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
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json"
};

async function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let file = join(DIST, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ""));
    // hash 路由：找不到实体文件就回退到 index.html
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

/** 在页面里用 canvas 造一张真图，避免在脚本里塞 base64 常量 */
const ATTACH_IMAGE = `(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#3366ff";
  ctx.fillRect(0, 0, 16, 16);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  const file = new File([blob], "check-dialogs.png", { type: "image/png" });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  const input = document.querySelector('input[type="file"][accept="image/*"]');
  if (!input) return false;
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`;

/**
 * 点一个选择器，失败时把「哪个按钮点不到」说清楚 ——
 * 不然只有一句 locator.click timeout，根本不知道卡在哪一步。
 *
 * 注意别再把错误信息截成第一行：Playwright 的真正原因（找不到 / 被遮挡 /
 * 一直不稳定）全在 Call log 里，截掉之后就只剩一句没头没脑的 timeout。
 */
async function click(page, selector, label, { timeout = 5000 } = {}) {
  try {
    await page.locator(selector).first().click({ timeout });
  } catch (error) {
    throw new Error(`点不到「${label}」（${selector}）：\n${error.message}`);
  }
}

/**
 * 弹窗要能打开，前提是页面里真的有成绩 —— 导出、合成、删除都是围绕记录的操作。
 *
 * 以前这里白拿「演示数据」：老版本 seedIfEmpty() 无条件往空库灌 4 条成绩，
 * 所以随便打开 /#/records 就有数据。后来修掉了那个 bug（云端模式下不再灌），
 * 这个脚本就跟着空了 —— 不是回归，是它一直在依赖一件不该依赖的事。
 * 现在自己塞数据，和 check-export.mjs 一个路子。
 */
const DIALOG_SEED = [
  { id: "dlg-1", subjectId: "math1", recordType: "paper", paperName: "模拟 01", score: 92, fullScore: 150, durationMinutes: 170, date: "2026-09-20", createdAt: "2026-09-20T10:00:00.000Z", note: "" },
  { id: "dlg-2", subjectId: "math1", recordType: "paper", paperName: "模拟 02", score: 98, fullScore: 150, durationMinutes: 165, date: "2026-09-27", createdAt: "2026-09-27T10:00:00.000Z", note: "" },
  { id: "dlg-3", subjectId: "math1", recordType: "paper", paperName: "模拟 03", score: 104, fullScore: 150, durationMinutes: 160, date: "2026-10-02", createdAt: "2026-10-02T10:00:00.000Z", note: "" }
];

/** 应用用的是 Dexie/IndexedDB，等它自己建好库之后直接往里塞记录 */
function seedRecords(page, records) {
  return page.evaluate(
    (rows) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("exam-tracker-v3");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("records", "readwrite");
          const store = tx.objectStore("records");
          rows.forEach((row) => store.put(row));
          tx.oncomplete = () => {
            db.close();
            resolve(rows.length);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    records
  );
}

/**
 * 打开路由 → 等应用建库 → 塞数据 → 重载让 store 读到。
 *
 * 必须重载：store 在挂载时一次性读 IndexedDB，塞完不重载页面看到的还是空列表。
 */
async function openWithSeed(page, base, route) {
  await page.goto(`${base}/#${route}`, { waitUntil: "load" });
  await page.waitForTimeout(2200);
  await seedRecords(page, DIALOG_SEED);
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(2200);
}

const DIALOGS = [
  {
    name: "导出面板",
    route: "/records",
    selector: ".export-dialog",
    async open(page) {
      await click(page, 'button:has-text("导出 Excel")', "导出 Excel");
    }
  },
  {
    name: "合成成绩",
    route: "/records",
    selector: ".composite-dialog",
    async open(page) {
      await click(page, 'button:has-text("全选当前结果")', "全选当前结果");
      await page.waitForTimeout(500);
      await click(page, 'button:has-text("进入合成")', "进入合成");
    }
  },
  {
    name: "签名弹窗",
    route: "/records",
    selector: ".signature-dialog",
    async open(page) {
      await click(page, 'button[aria-label="签名"]', "签名");
    }
  },
  {
    name: "确认框",
    route: "/records",
    selector: ".ds-modal",
    async open(page) {
      // 这是纯图标按钮，文字在 aria-label 上，:has-text 匹配不到
      await click(page, 'button[aria-label="删除成绩"]', "删除成绩");
    }
  },
  {
    name: "图片灯箱",
    route: "/mistakes",
    selector: ".lightbox",
    async open(page) {
      await click(page, 'button:has-text("新增错题")', "新增错题");
      await page.waitForTimeout(700);
      const attached = await page.evaluate(ATTACH_IMAGE);
      if (!attached) throw new Error("没找到图片上传输入框");
      await page.waitForTimeout(1000);
      await click(page, ".image-preview-button", "图片缩略图");
    }
  }
];

const only = (process.argv.find((arg) => arg.startsWith("--only=")) || "").split("=")[1];
const dialogs = only ? DIALOGS.filter((dialog) => dialog.name === only) : DIALOGS;
if (!dialogs.length) {
  console.error(`--only=${only} 没匹配到任何弹窗。已知：${DIALOGS.map((d) => d.name).join(", ")}`);
  process.exit(1);
}

/** 焦点现在在弹窗内还是外 */
function focusState(selector) {
  return `(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { where: "body", tag: "body", text: "(body)" };
    const root = document.querySelector(${JSON.stringify(selector)});
    const inside = Boolean(root && root.contains(el));
    return {
      where: inside ? "inside" : "outside",
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\\s+/g, " ").trim().slice(0, 24)
    };
  })()`;
}

const TAB_PRESSES = 14;

async function checkDialog(browser, base, spec) {
  const problems = [];
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 160));
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error.message).slice(0, 160)));

  const isOpen = () => page.locator(spec.selector).count().then((count) => count > 0);

  try {
    await openWithSeed(page, base, spec.route);

    await spec.open(page);
    await page.waitForTimeout(700);

    if (!(await isOpen())) {
      problems.push("弹窗没打开（选择器找不到）");
      return { problems, consoleErrors };
    }

    // 1. 打开后焦点应该已经在弹窗里
    const initial = await page.evaluate(focusState(spec.selector));
    if (initial.where !== "inside") {
      problems.push(`打开后焦点不在弹窗内（在 ${initial.where}: <${initial.tag}> ${initial.text}）`);
    }

    // 2. 弹窗开着的时候页面不应该能滚动
    //    必须在这里查：合成成绩那种弹窗会把页面切到「合成模式」，
    //    关掉之后再想用同一个按钮把它打开一次是打不开的。
    const locked = await page.evaluate(() => document.body.style.overflow === "hidden");
    if (!locked) problems.push("打开时没有锁住页面滚动");

    // 3. Tab 不能跑出弹窗
    const escapes = [];
    for (let i = 0; i < TAB_PRESSES; i += 1) {
      await page.keyboard.press("Tab");
      const state = await page.evaluate(focusState(spec.selector));
      if (state.where === "outside") escapes.push(`${i + 1}次后→<${state.tag}> ${state.text}`);
    }
    if (escapes.length) {
      problems.push(`Tab ${TAB_PRESSES} 次里有 ${escapes.length} 次焦点跑出弹窗：${escapes.slice(0, 3).join(" / ")}`);
    }

    // 4. Shift+Tab 也不能跑出去（反向绕回）
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    const backward = await page.evaluate(focusState(spec.selector));
    if (backward.where === "outside") {
      problems.push(`Shift+Tab 后焦点跑出弹窗（<${backward.tag}> ${backward.text}）`);
    }

    // 5. Escape 能关掉
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    if (await isOpen()) {
      problems.push("按 Escape 关不掉");
    } else {
      // 6. 关掉后焦点回到触发它的按钮
      const restored = await page.evaluate(
        `(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return "(body)";
          return (el.innerText || el.getAttribute("aria-label") || el.tagName).replace(/\\s+/g, " ").trim().slice(0, 24);
        })()`
      );
      if (restored === "(body)") problems.push("关闭后焦点丢到 body，没有回到触发按钮");
    }

    // 7. 关闭后要恢复页面滚动
    const released = await page.evaluate(() => document.body.style.overflow !== "hidden");
    if (!released) problems.push("关闭后没有恢复页面滚动");
  } catch (error) {
    problems.push(`执行出错：${String(error.message)}`);
  } finally {
    await page.close();
  }

  return { problems, consoleErrors };
}

/**
 * 返回手势（手机侧滑 / 安卓系统返回键）只关弹窗、不换页。
 *
 * 单独开一个页面跑，而不是接在 checkDialog 后面：合成成绩那个弹窗关掉之后
 * 再用同一个按钮是打不开的（要先重新勾选记录），复用页面会误报「弹窗没打开」。
 *
 * 用页面内的 history.back() 而不是 page.goBack()：弹窗压进去的是一条**同地址**
 * 的记录，这条返回不产生导航，Playwright 的 goBack 会一直等 load 事件。
 * history.back() 走的正是浏览器返回键那一条代码路径。
 */
async function checkBackGesture(browser, base, spec) {
  const problems = [];
  const page = await browser.newPage();
  try {
    await openWithSeed(page, base, spec.route);

    await spec.open(page);
    await page.waitForTimeout(700);
    if (!(await page.locator(spec.selector).count())) {
      problems.push("弹窗没打开（选择器找不到）");
      return problems;
    }

    const before = await page.evaluate(() => ({ hash: location.hash, marker: history.state?.__dialogId ?? null }));
    if (!before.marker) {
      problems.push("打开时没往历史里压记录（history.state.__dialogId 为空），手机返回手势会直接离开当前页");
    }

    await page.evaluate(() => history.back());
    await page.waitForTimeout(800);

    const after = await page.evaluate(
      `(() => ({
        hash: location.hash,
        marker: history.state?.__dialogId ?? null,
        open: Boolean(document.querySelector(${JSON.stringify(spec.selector)}))
      }))()`
    );

    if (after.open) problems.push(`返回手势关不掉弹窗（还开着，页面已经从 ${before.hash} 换到 ${after.hash}）`);
    if (after.hash !== before.hash) problems.push(`返回手势换了页：${before.hash} → ${after.hash}`);
    if (after.marker) problems.push(`返回后历史里还留着标记 ${after.marker}，之后按返回会「没反应」一下`);
  } catch (error) {
    problems.push(`执行出错：${String(error.message)}`);
  } finally {
    await page.close();
  }
  return problems;
}

async function main() {
  if (!existsSync(DIST)) throw new Error("dist/ 不存在，先跑一次 npm run build。");

  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });

  let failed = 0;
  console.log(`检查 ${dialogs.length} 个弹窗的键盘可达性\n`);

  for (const spec of dialogs) {
    const { problems, consoleErrors } = await checkDialog(browser, base, spec);
    if (consoleErrors.length) problems.push(`控制台报错：${consoleErrors[0]}`);
    problems.push(...(await checkBackGesture(browser, base, spec)));
    if (problems.length) {
      failed += 1;
      console.log(`✗ ${spec.name}`);
      problems.forEach((problem) => console.log(`    · ${problem}`));
    } else {
      console.log(`✓ ${spec.name} —— 焦点进入 / Tab 不逃逸 / Escape 关闭 / 焦点归位 / 滚动锁定 / 返回手势只关弹窗`);
    }
  }

  console.log(`\n共 ${dialogs.length} 个弹窗，${failed} 个有问题。`);
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
