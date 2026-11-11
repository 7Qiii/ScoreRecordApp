#!/usr/bin/env node
/**
 * 逐页点击审计：把每个可见、未禁用的按钮都点一遍，看它到底有没有用。
 *
 * 为什么不是「找没绑事件的按钮」：
 * 静态扫过一遍，全站 138 个 <button> 都绑了 @click，没有空壳。
 * 真正会出问题的是「点了没反应 / 点了报错 / 点了把界面搞坏」，所以只能真点。
 *
 * 每个按钮点之前都重新加载页面：
 * - 状态天然干净，不用写一堆「关弹窗、清输入、回路由」的复原逻辑；
 * - 危险操作（删除 / 清空）即使弹出了确认框，重新加载也会丢弃，不会真的删数据。
 *
 * 用法：
 *   node scripts/audit-buttons.mjs                  # 全部路由
 *   node scripts/audit-buttons.mjs --routes=/,/records
 *   node scripts/audit-buttons.mjs --max=20         # 每条路由最多点 20 个，先试水
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
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

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");
const OUT = join(ROOT, ".verify");

const BROWSER_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json"
};

const ALL_ROUTES = [
  { label: "/", path: "/" },
  { label: "/records", path: "/records" },
  { label: "/mistakes", path: "/mistakes" },
  { label: "/subjects", path: "/subjects" },
  { label: "/backup", path: "/backup" },
  { label: "/login", path: "/login" },
  { label: "/records/:id", path: "/records", click: "a[href*='#/records/']:visible" },
  { label: "/mistakes/:id", path: "/mistakes", click: ".review-card-main" },
  // 导出面板是点开才出现的，只扫页面初始状态会整个漏掉它 ——
  // 而这里恰恰是全站按钮最密的地方（列布局、字段、每列成绩选择器）。
  { label: "/records · 导出面板", path: "/records", click: 'button:has-text("导出 Excel")', scope: ".export-dialog" },
  // 录入表单同样是点开才出现的，只扫初始状态会整个漏掉它 ——
  // 而这是全站最主要的数据入口，「用时」那组快捷按钮也在里面。
  { label: "/ · 录入表单", path: "/", click: 'button:has-text("记录成绩")', scope: ".record-form" }
];

// 顶栏 / 侧栏 / 底部导航在每个路由都出现，只在首页审一次，避免报告里刷屏
const CHROME_SELECTORS = [".topbar", ".sidebar", ".bottom-nav"];

/**
 * 审核用的数据。
 *
 * 没有成绩，/records 上就没有成绩卡片，卡片上的按钮（删除、基于本成绩新增错题…）
 * 一个都审不到；没有错题，/mistakes/:id 那一行直接是「全部 0」。实测条目从
 * 131 掉到 62 —— 报告照样全绿，但审的按钮少了一半，这种「绿」是假的。
 *
 * 以前这批数据是白拿演示数据的（老版本 seedIfEmpty() 无条件往空库灌）。
 * 修掉「演示数据漏进账号」那个 bug 之后就没有了 —— 但依赖演示数据当夹具本来
 * 就错，那是产品功能。所以自己塞，名字也刻意用「审计」，避免和种子数据撞指纹。
 */
const AUDIT_SEED = {
  records: [
    { id: "audit-rec-1", subjectId: "cs408", recordType: "paper", paperName: "审计卷 01", score: 86, fullScore: 150, durationMinutes: 180, date: "2026-09-25", createdAt: "2026-09-25T10:00:00.000Z", note: "" },
    { id: "audit-rec-2", subjectId: "math1", recordType: "paper", paperName: "审计卷 02", score: 92, fullScore: 150, durationMinutes: 170, date: "2026-09-27", createdAt: "2026-09-27T10:00:00.000Z", note: "" },
    { id: "audit-rec-3", subjectId: "english1", recordType: "paper", paperName: "审计卷 03", score: 68, fullScore: 100, durationMinutes: 70, date: "2026-09-29", createdAt: "2026-09-29T10:00:00.000Z", note: "" },
    { id: "audit-rec-4", subjectId: "politics", recordType: "paper", paperName: "审计卷 04", score: 63, fullScore: 100, durationMinutes: 60, date: "2026-10-01", createdAt: "2026-10-01T10:00:00.000Z", note: "" }
  ],
  mistakes: [
    { id: "audit-mis-1", subjectId: "cs408", title: "审计错题 01", knowledgePoint: "操作系统", reason: "concept", difficulty: "中等", status: "待复盘", sourceRecordId: "", questionText: "", analysis: "", nextReviewAt: "", createdAt: "2026-09-25T10:00:00.000Z", updatedAt: "2026-09-25T10:00:00.000Z" },
    { id: "audit-mis-2", subjectId: "math1", title: "审计错题 02", knowledgePoint: "高等数学", reason: "method", difficulty: "困难", status: "已整理", sourceRecordId: "", questionText: "", analysis: "", nextReviewAt: "", createdAt: "2026-09-23T10:00:00.000Z", updatedAt: "2026-09-23T10:00:00.000Z" }
  ]
};

/** 应用用的是 Dexie/IndexedDB，等它自己建好库之后直接往里塞 */
function seedAuditData(page) {
  return page.evaluate(
    (payload) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("exam-tracker-v3");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(["records", "mistakes"], "readwrite");
          payload.records.forEach((row) => tx.objectStore("records").put(row));
          payload.mistakes.forEach((row) => tx.objectStore("mistakes").put(row));
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    AUDIT_SEED
  );
}

/**
 * 每次点击前要清掉的本地偏好。
 *
 * 导出面板的「每组字段」和「每列包含哪些成绩」都是持久化的：不清的话，
 * 上一轮点过的「清空 / 全部去掉」会留到下一轮，后面几次点击就落在
 * 「成绩全被排除」的状态上，判定失真。只清 UI 偏好，IndexedDB 里的数据不动。
 */
const RESET_LOCAL_KEYS = ["exam-tracker-export-matrix-fields", "exam-tracker-export-matrix-excluded"];

// 「按卷子分列」才渲染出每列的成绩选择器，固定成 matrix 让那些按钮可被审到
const EXPORT_LAYOUT_KEY = "exam-tracker-export-layout";
const EXPORT_LAYOUT_VALUE = "matrix";

const EXPORT_PREFS_INIT_ARG = {
  resetKeys: RESET_LOCAL_KEYS,
  layoutKey: EXPORT_LAYOUT_KEY,
  layoutValue: EXPORT_LAYOUT_VALUE
};

function EXPORT_PREFS_INIT({ resetKeys, layoutKey, layoutValue }) {
  try {
    resetKeys.forEach((key) => window.localStorage.removeItem(key));
    window.localStorage.setItem(layoutKey, layoutValue);
  } catch {
    /* 无痕模式等场景下 localStorage 不可用，忽略 */
  }
}

// 会动数据或退出登录的按钮：只验证确认弹窗能正常弹出，不真的确认。
// 「最近删除」是回收站面板的开关，不是删除动作，用否定环视排除掉。
// 「清空」要限定成「清空成绩…」：导出面板里按列清空只是取消勾选，不是危险操作。
const DANGEROUS = /清空成绩|清空全部|清空所有|移除|退出登录|覆盖恢复|(?<!最近)删除/;

/**
 * 「合并导入 / 恢复备份 / 覆盖恢复」会拉起系统文件选择框，
 * DOM 上看不到任何变化，光靠点击没法判断按钮到底有没有用。
 * 这里用 Playwright 的 filechooser 事件喂一个结构合法但内容为空的备份：
 * - JSON.parse 能过，后面的确认框会正常弹出，这条路径就被真正走到了；
 * - 内容为空 + 脚本永远不点「确认」，所以不会真的改到测试数据。
 */
const SYNTHETIC_BACKUP = JSON.stringify({
  version: 3,
  exportedAt: new Date().toISOString(),
  subjects: [],
  records: [],
  mistakes: [],
  images: []
});

function argValue(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).split(",") : fallback;
}

/**
 * 解析 --routes。
 *
 * 注意 Git Bash 会把 `/` 开头的参数当路径自动转换：`--routes=/` 会变成
 * `--routes=C:/.../PortableGit/versions/1.2.0/`，过滤后一个都不剩，
 * 脚本就会静默地什么都不做——排查起来很费时间。所以这里匹配不到就直接报错退出，
 * 并提示加 MSYS_NO_PATHCONV=1。
 */
function readRoutes() {
  const raw = argValue("routes", null);
  if (!raw) return ALL_ROUTES;
  const matched = ALL_ROUTES.filter((route) => raw.includes(route.label));
  if (!matched.length) {
    console.error(`--routes=${raw.join(",")} 没有匹配到任何已知路由。`);
    console.error(`已知路由：${ALL_ROUTES.map((route) => route.label).join(", ")}`);
    console.error("提示：Git Bash 会把 / 开头的参数当路径转换。请改用：");
    console.error(`  MSYS_NO_PATHCONV=1 node scripts/audit-buttons.mjs --routes=${ALL_ROUTES[0].label}`);
    process.exit(1);
  }
  return matched;
}

const routes = readRoutes();
const maxPerRoute = Number(argValue("max", ["0"])[0]) || Infinity;

function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";

    let filePath = join(DIST, normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
    if (!existsSync(filePath)) filePath = join(DIST, "index.html");

    try {
      const body = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
      res.end(body);
    } catch (error) {
      res.writeHead(404).end(String(error.message));
    }
  });

  return new Promise(async (resolve) => {
    resolve({ server, port: await listenSafePort(server) });
  });
}

function findBrowser() {
  const found = BROWSER_CANDIDATES.find((item) => existsSync(item));
  if (!found) throw new Error("没有找到本机 Chrome / Edge，无法运行按钮审计。");
  return found;
}

/** 点击前后各取一次，用来判断「到底有没有发生什么」 */
const SIGNATURE = `(() => {
  const text = (document.body.innerText || "").replace(/\\s+/g, "");
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  const overlays = document.querySelectorAll(
    '.ds-modal-backdrop, [role="dialog"], [aria-modal="true"], [class*="backdrop"]'
  ).length;
  return {
    hash: location.hash,
    textLen: text.length,
    textHash: h,
    overlays,
    toasts: document.querySelectorAll(".toast").length,
    visibleButtons: [...document.querySelectorAll('button, [role="button"]')].filter((b) => b.offsetParent !== null).length,
    // 主题切换只改属性、不改文字，不带上就会把「跟随系统/浅色/深色」误判成无反应
    theme: document.documentElement.dataset.theme || "system",
    colorScheme: document.documentElement.style.colorScheme || "",
    // 分段控件 / 主题色板这类只挪 .active 高亮、文字一个字都不变，
    // 不带上就会把「导出主题」这种按钮误判成无反应
    activeText: [...document.querySelectorAll(".active")].map((el) => (el.innerText || "").replace(/\\s+/g, "")).join("§"),
    // 外观切换器是纯图标按钮，innerText 是空串：从「浅色」点到「跟随系统」时
    // 高亮确实挪了，但 activeText 一个字都不变，于是被记成「点了没反应」。
    // 主题改成「跟随系统 = 按系统解析成浅色/深色」之后，这两个按钮在系统是浅色时
    // 渲染结果本来就一样（这正是修复的目标），所以更不能靠 theme 属性去区分，
    // 只能看高亮落在哪个按钮上。
    activeTheme: document.querySelector(".theme-switcher button.active")?.getAttribute("aria-label") || ""
  };
})()`;

/** 给第 index 个「可见且未禁用」的按钮打标记，返回它的文案 */
const MARK_BUTTON = (payload) => `(() => {
  document.querySelectorAll("[data-audit]").forEach((el) => el.removeAttribute("data-audit"));
  const skip = ${JSON.stringify(payload.skip)};
  // scope：弹窗类路由只审弹窗内的按钮。弹窗盖住页面后，页面上的按钮
  // 依然 offsetParent 非空（看着「可见」），但点不到，会一路超时报错。
  const scope = ${JSON.stringify(payload.scope || "")};
  const root = scope ? document.querySelector(scope) : document;
  if (!root) return null;
  const list = [...root.querySelectorAll('button, [role="button"]')].filter((b) => {
    if (b.offsetParent === null || b.disabled) return false;
    return !skip.some((sel) => b.closest(sel));
  });
  const target = list[${payload.index}];
  if (!target) return null;
  target.setAttribute("data-audit", "1");
  const text = (target.innerText || "").replace(/\\s+/g, " ").trim();
  return {
    label: text || target.getAttribute("aria-label") || target.getAttribute("title") || "(无文案)",
    total: list.length
  };
})()`;

function classify(before, after, errors) {
  if (errors.length) return "报错";
  if (after.overlays > before.overlays) return "打开弹窗";
  if (after.hash !== before.hash) return "路由跳转";
  if (after.toasts > before.toasts) return "Toast 反馈";
  if (after.theme !== before.theme || after.colorScheme !== before.colorScheme) return "主题切换";
  if (
    after.textHash !== before.textHash ||
    after.visibleButtons !== before.visibleButtons ||
    after.activeText !== before.activeText ||
    after.activeTheme !== before.activeTheme
  ) {
    return "界面变化";
  }
  return "无可见变化";
}

async function main() {
  if (!existsSync(DIST)) throw new Error("dist/ 不存在，先跑一次 npm run build。");
  await mkdir(OUT, { recursive: true });

  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

  // 先塞一次数据。所有页面共用同一个 context，IndexedDB 是共享的，塞一次就够。
  const seedPage = await context.newPage();
  await seedPage.goto(`${base}/#/records`, { waitUntil: "load" });
  await seedPage.waitForTimeout(2200);
  await seedAuditData(seedPage);
  await seedPage.close();

  const records = [];
  const totals = { 正常: 0, 报错: 0, 无可见变化: 0, 危险操作已拦截: 0 };

  for (const route of routes) {
    // 非首页跳过顶栏/侧栏/底部导航，避免同一批按钮重复出现
    const skip = route.path === "/" ? [] : CHROME_SELECTORS;

    // 先探一次，拿到按钮总数
    const probe = await context.newPage();
    await probe.addInitScript(EXPORT_PREFS_INIT, EXPORT_PREFS_INIT_ARG);
    await probe.goto(`${base}/#${route.path}`, { waitUntil: "load" });
    await probe.waitForTimeout(700);
    if (route.click) {
      await probe.locator(route.click).first().click({ timeout: 3000 }).catch(() => {});
      await probe.waitForTimeout(600);
    }
    const probeResult = await probe.evaluate(MARK_BUTTON({ index: 0, skip, scope: route.scope }));
    const total = probeResult ? probeResult.total : 0;
    await probe.close();

    const limit = Math.min(total, maxPerRoute);
    console.log(`\n── ${route.label} ── 可见按钮 ${total} 个${limit < total ? `（本次只点前 ${limit} 个）` : ""}`);

    for (let index = 0; index < limit; index += 1) {
      const page = await context.newPage();
      const errors = [];
      let fileChooserFired = false;
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text().slice(0, 200));
      });
      page.on("pageerror", (error) => errors.push(String(error.message || error).slice(0, 200)));
      page.on("filechooser", async (chooser) => {
        fileChooserFired = true;
        try {
          await chooser.setFiles({
            name: "audit-synthetic-backup.json",
            mimeType: "application/json",
            buffer: Buffer.from(SYNTHETIC_BACKUP)
          });
        } catch {
          /* 选择框被取消不影响后续判定 */
        }
      });

      await page.addInitScript(EXPORT_PREFS_INIT, EXPORT_PREFS_INIT_ARG);

      await page.goto(`${base}/#${route.path}`, { waitUntil: "load" });
      await page.waitForTimeout(700);
      if (route.click) {
        await page.locator(route.click).first().click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(600);
      }

      const marked = await page.evaluate(MARK_BUTTON({ index, skip, scope: route.scope }));
      if (!marked) {
        await page.close();
        break;
      }

      const before = await page.evaluate(SIGNATURE);
      const isDangerous = DANGEROUS.test(marked.label);

      await page.locator("[data-audit='1']").click({ timeout: 3000 }).catch((error) => {
        errors.push(`点击失败：${String(error.message).split("\n")[0]}`);
      });
      await page.waitForTimeout(600);
      const after = await page.evaluate(SIGNATURE);

      let verdict;
      if (isDangerous) {
        // 危险操作：只确认确认弹窗能正常弹出，不点「确认」
        if (after.overlays > before.overlays) verdict = "危险操作已拦截";
        else if (fileChooserFired) verdict = "选了文件但没确认弹窗";
        // 像备份页的「清空」要先输入「清空」二字，空着点会被前置校验挡下并显示错误提示。
        // 界面有变化就说明按钮不是哑的，属于合理拦截。
        else if (after.textHash !== before.textHash) verdict = "危险操作被前置校验挡住";
        else verdict = "危险操作未弹出确认";
      } else if (fileChooserFired) {
        // 拉起文件选择框本身就是「有反应」，再看后续有没有变化
        verdict = after.overlays > before.overlays || after.toasts > before.toasts ? "文件选择框 + 后续反馈" : "文件选择框";
      } else {
        verdict = classify(before, after, errors);
      }

      totals[verdict] = (totals[verdict] || 0) + 1;
      records.push({
        route: route.label,
        label: marked.label,
        verdict,
        errors,
        fileChooserFired,
        before,
        after
      });

      const mark = verdict === "报错" ? "✗" : verdict === "无可见变化" ? "?" : "✓";
      console.log(`  ${mark} [${verdict}] ${marked.label}${errors.length ? `  ← ${errors[0]}` : ""}`);

      await page.close();
    }
  }

  await browser.close();
  server.close();

  await writeFile(join(OUT, "buttons-report.json"), JSON.stringify(records, null, 2), "utf8");

  const problems = records.filter((item) => item.verdict === "报错" || item.verdict.startsWith("危险操作未"));
  const silent = records.filter((item) => item.verdict === "无可见变化");

  console.log("\n════════ 汇总 ════════");
  console.log(`共点击 ${records.length} 个按钮`);
  for (const [key, value] of Object.entries(totals)) console.log(`  ${key}: ${value}`);

  if (problems.length) {
    console.log(`\n需要修的问题（${problems.length}）：`);
    for (const item of problems) console.log(`  ${item.route} · ${item.label} → ${item.verdict}\n      ${item.errors[0] || ""}`);
  } else {
    console.log("\n没有报错，也没有危险操作漏掉确认。");
  }

  if (silent.length) {
    console.log(`\n点了没有任何可见变化的（${silent.length}）——需要人工判断是不是合理的无反馈：`);
    for (const item of silent) console.log(`  ${item.route} · ${item.label}`);
  }

  console.log(`\n明细已写入 ${join(OUT, "buttons-report.json")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
