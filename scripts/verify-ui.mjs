/**
 * 多尺寸 UI 验证。
 *
 * 做三件事：
 * 1. 起一个静态服务器托管 dist/（hash 路由，回退到 index.html）。
 * 2. 用系统里已装的 Chrome/Edge 逐页打开（playwright-core 不自带浏览器，正好复用本机）。
 * 3. 每个「路由 × 尺寸」组合检查：控制台报错、整页横向溢出、溢出元素、
 *    底部导航是否遮住内容，并截图存到 .verify/。
 *
 * 用法：
 *   node scripts/verify-ui.mjs                 # 全部路由 × 全部尺寸
 *   node scripts/verify-ui.mjs --routes=/,/records
 *   node scripts/verify-ui.mjs --sizes=390x844
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createRequire } from "node:module";
import { listenSafePort } from "./lib/safe-listen.mjs";
import { seedRows } from "./lib/seed-rows.mjs";

// playwright-core 装在托管工作区里（不污染项目依赖），
// ESM 不认 NODE_PATH，所以用 createRequire 从那个目录解析。
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

// 详情页没法直接拼 URL（要真实 id），所以用「先打开列表、点第一条」的方式进入。
const ALL_ROUTES = [
  "/",
  "/records",
  "/mistakes",
  "/subjects",
  "/backup",
  "/login",
  // 成绩页同时渲染了桌面表格和移动卡片列表，其中一个被 CSS 藏起来，
  // :visible 保证点到的是真正可见的那一个。
  { label: "/records/:id", path: "/records", click: "a[href*='#/records/']:visible" },
  { label: "/mistakes/:id", path: "/mistakes", click: ".review-card-main" }
];
const ALL_SIZES = [
  { label: "1440x900", width: 1440, height: 900 },
  { label: "1280x720", width: 1280, height: 720 },
  { label: "1024x768", width: 1024, height: 768 },
  { label: "768x1024", width: 768, height: 1024 },
  { label: "390x844", width: 390, height: 844 },
  { label: "375x667", width: 375, height: 667 }
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

function argValue(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).split(",") : fallback;
}

// Git Bash 会把 `/` 开头的参数当路径转换（`--routes=/` → `--routes=C:/.../PortableGit/...`），
// 过滤后一个都不剩就会静默跑完、什么都不验。匹配不到就报错退出，别让人白等。
// 这里的 ALL_ROUTES 既有字符串也有对象，取标签要兼容两种形态
const routeLabel = (route) => (typeof route === "string" ? route : route.label || route.path);

function readRoutes() {
  const raw = argValue("routes", null);
  if (!raw) return ALL_ROUTES;
  const matched = ALL_ROUTES.filter((route) => raw.includes(routeLabel(route)));
  if (!matched.length) {
    console.error(`--routes=${raw.join(",")} 没有匹配到任何已知路由。`);
    console.error(`已知路由：${ALL_ROUTES.map(routeLabel).join(", ")}`);
    console.error("提示：Git Bash 会把 / 开头的参数当路径转换，请加 MSYS_NO_PATHCONV=1 前缀。");
    process.exit(1);
  }
  return matched;
}

const routes = readRoutes();
const sizeFilter = argValue("sizes", null);
const sizes = sizeFilter
  ? ALL_SIZES.filter((size) => sizeFilter.includes(size.label))
  : ALL_SIZES;

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
  if (!found) throw new Error("没有找到本机 Chrome / Edge，无法运行 UI 验证。");
  return found;
}

/** 在页面里找出横向溢出视口、且不在可滚动容器里的元素 */
const OVERFLOW_PROBE = `(() => {
  const docWidth = document.documentElement.clientWidth;
  const offenders = [];
  const scrollable = (node) => {
    let el = node.parentElement;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowX)) return true;
      el = el.parentElement;
    }
    return false;
  };
  document.querySelectorAll("body *").forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    if (rect.right <= docWidth + 1 && rect.left >= -1) return;
    if (scrollable(el)) return;
    const style = getComputedStyle(el);
    if (style.position === "fixed") return;
    offenders.push({
      selector: el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).slice(0, 3).join(".") : ""),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      width: Math.round(rect.width)
    });
  });
  return {
    docWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    offenders: offenders.slice(0, 12)
  };
})()`;

/** 底部导航是否压住了页面内容 */
const BOTTOM_NAV_PROBE = `(() => {
  const nav = document.querySelector(".bottom-nav");
  if (!nav) return { visible: false };
  const style = getComputedStyle(nav);
  const visible = style.display !== "none" && style.visibility !== "hidden" && nav.getBoundingClientRect().height > 0;
  if (!visible) return { visible: false };
  const navRect = nav.getBoundingClientRect();
  const navCount = nav.querySelectorAll(".bottom-nav-item").length;
  // 页面最后一个可见块级内容的底边，是否被导航遮住
  const main = document.querySelector("main");
  const lastChild = main?.lastElementChild;
  const contentBottom = lastChild ? lastChild.getBoundingClientRect().bottom + window.scrollY : 0;
  const scrollBottom = document.documentElement.scrollHeight;
  return {
    visible: true,
    navCount,
    navHeight: Math.round(navRect.height),
    overlapsContent: contentBottom > 0 && contentBottom > scrollBottom - navRect.height + 1
  };
})()`;

/**
 * 文字被裁检测。
 * scrollWidth > clientWidth 且 overflow 不是 auto/scroll，说明内容撑破了盒子却没地方滚，
 * 表现就是「这一列的字看不见了」。之前 records / subjects 两张表就是这个毛病。
 *
 * 注意排除绝对定位的「故意探出」：未读红点这类角标本来就压在按钮外沿，
 * 只要祖先都没裁它（overflow: visible）就属于正常设计，不是 bug。
 */
const CLIP_PROBE = `(() => {
  const offenders = [];
  document.querySelectorAll("body *").forEach((el) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return;
    if (/(auto|scroll)/.test(style.overflowX)) return;
    if (el.clientWidth === 0 || el.clientHeight === 0) return;
    if (!el.textContent || !el.textContent.trim()) return;
    if (el.scrollWidth <= el.clientWidth + 2) return;
    if (el.classList.contains("heatmap-scroll") || el.closest(".heatmap-scroll")) return;

    // 区分「在流内被撑破」和「绝对定位子元素故意探出」。
    // 角标往往挂在更深的子节点上（.announcement-center > button > .notification-dot），
    // 所以要把整棵子树走一遍，不能只看直接子元素。
    const box = el.getBoundingClientRect();
    let maxInFlowRight = -Infinity;
    let absOverhang = false;
    const walk = (node, insideAbs) => {
      for (const child of node.children) {
        const childStyle = getComputedStyle(child);
        if (childStyle.display === "none") continue;
        const isAbs = insideAbs || childStyle.position === "absolute" || childStyle.position === "fixed";
        const childRect = child.getBoundingClientRect();
        if (isAbs) {
          if (childRect.right - box.left > el.clientWidth + 2) absOverhang = true;
        } else {
          maxInFlowRight = Math.max(maxInFlowRight, childRect.right - box.left);
        }
        walk(child, isAbs);
      }
    };
    walk(el, false);
    // 唯一的溢出源是绝对定位的角标 → 正常设计，放行
    if (absOverhang && maxInFlowRight <= el.clientWidth + 2) return;

    offenders.push({
      selector: el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 3).join(".") : ""),
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      maxInFlowRight: Math.round(maxInFlowRight)
    });
  });
  return offenders.slice(0, 10);
})()`;

/**
 * 点击目标尺寸检测。
 * 移动端手指点不准小按钮，这里只挑「看起来就是主操作」的控件（按钮、图标按钮、底部标签），
 * 段落里的行内链接不算，否则全是误报。
 */
const TAP_TARGET_PROBE = `(() => {
  const SELECTOR = "button, a.primary-button, a.secondary-button, .icon-button, .bottom-nav-item, .nav-item";
  const MIN = 28;
  const offenders = [];
  document.querySelectorAll(SELECTOR).forEach((el) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    if (el.disabled) return;
    if (rect.height >= MIN && rect.width >= MIN) return;
    offenders.push({
      selector: el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : ""),
      text: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 20),
      w: Math.round(rect.width),
      h: Math.round(rect.height)
    });
  });
  return offenders.slice(0, 10);
})()`;

const results = [];

/**
 * 探针自检：往页面里塞一个「确定被裁」的元素和一个「确定正常的角标」，
 * 确认 CLIP_PROBE 抓得到前者、放得过后者。
 * 否则探针一旦写错就是永远通过，比没有还危险。
 */
async function runSelfTest(page) {
  const outcome = await page.evaluate(`(() => {
    const host = document.createElement("div");
    host.className = "probe-clip-host";
    host.style.cssText = "position:fixed;left:0;top:0;width:100px;overflow:hidden;";
    const inner = document.createElement("div");
    inner.style.cssText = "width:400px;white-space:nowrap;";
    inner.textContent = "这一段文字一定会被裁掉";
    host.appendChild(inner);

    const badgeHost = document.createElement("div");
    badgeHost.className = "probe-badge-host";
    badgeHost.style.cssText = "position:fixed;left:300px;top:0;width:40px;height:40px;overflow:visible;";
    const badge = document.createElement("span");
    badge.className = "probe-badge-dot";
    badge.style.cssText = "position:absolute;right:-5px;top:-5px;width:18px;height:18px;";
    badge.textContent = "3";
    badgeHost.appendChild(badge);

    document.body.append(host, badgeHost);
    const flagged = ${CLIP_PROBE};
    host.remove();
    badgeHost.remove();
    return flagged.map((item) => item.selector);
  })()`);

  const caughtClipped = outcome.some((selector) => selector.includes("probe-clip-host"));
  const falsePositive = outcome.some((selector) => selector.includes("probe-badge-host"));

  if (!caughtClipped) throw new Error(`自检失败：CLIP_PROBE 抓不到明确被裁的元素（返回 ${JSON.stringify(outcome)}）。`);
  if (falsePositive) throw new Error("自检失败：CLIP_PROBE 把正常角标误判为被裁。");
  console.log("✓ 探针自检通过（能抓到真裁切，不误报角标）\n");
}

async function main() {
  if (!existsSync(DIST)) throw new Error("dist/ 不存在，先跑一次 npm run build。");
  await mkdir(OUT, { recursive: true });

  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });

  // 先跑一次探针自检，确认探针本身是有效的
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.goto(`${base}/#/`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    await runSelfTest(page);
    await context.close();
  }

  for (const size of sizes) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: 1
    });

    // 每个视口使用独立的浏览器存储，详情页用例在空库也有固定入口。
    const fixturePage = await context.newPage();
    await fixturePage.goto(`${base}/#/records`);
    await fixturePage.getByRole("heading", { name: "成绩工作台", exact: true }).waitFor();
    const createdAt = new Date().toISOString();
    await seedRows(fixturePage, {
      records: [{ id: "ui-score", subjectId: "math1", recordType: "paper", paperName: "积分综合练习", date: createdAt.slice(0, 10), createdAt, score: 108, fullScore: 150, durationMinutes: 120 }],
      mistakes: [{ id: "ui-mistake", subjectId: "math1", title: "变上限积分求导", knowledgePoint: "高等数学", status: "待复盘", difficulty: "中等", createdAt }]
    });
    await fixturePage.close();

    for (const entry of routes) {
      const route = typeof entry === "string" ? entry : entry.path;
      const label = typeof entry === "string" ? entry : entry.label || entry.path;
      const page = await context.newPage();
      const consoleErrors = [];
      const pageErrors = [];

      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => pageErrors.push(String(error.message || error)));

      await page.goto(`${base}/#${route}`, { waitUntil: "load" });
      // 等首页的懒加载图表/热力图落位
      await page.waitForTimeout(700);

      // 需要进详情页的，先点第一条；点不到就记为问题，而不是静默跳过
      let clickFailed = "";
      if (typeof entry !== "string" && entry.click) {
        try {
          await page.locator(entry.click).first().click({ timeout: 3000 });
          await page.waitForTimeout(700);
        } catch (error) {
          clickFailed = `无法进入详情页（${entry.click}）：${String(error.message).split("\n")[0]}`;
        }
      }

      const overflow = await page.evaluate(OVERFLOW_PROBE);
      const bottomNav = await page.evaluate(BOTTOM_NAV_PROBE);
      const clipped = await page.evaluate(CLIP_PROBE);
      // 触摸尺寸只在窄屏下要求，桌面用鼠标不存在点不准的问题
      const tapTargets = size.width < 768 ? await page.evaluate(TAP_TARGET_PROBE) : [];

      const shot = join(OUT, `${size.label}${label.replace(/[/:]/g, "_") || "_root"}.png`);
      await page.screenshot({ path: shot, fullPage: false });

      results.push({ size: size.label, route: label, consoleErrors, pageErrors, overflow, bottomNav, clipped, tapTargets, clickFailed });
      await page.close();
    }

    await context.close();
  }

  await browser.close();
  server.close();

  // ---- 报告 ----
  let problems = 0;
  for (const item of results) {
    const issues = [];
    if (item.clickFailed) issues.push(item.clickFailed);
    if (item.pageErrors.length) issues.push(`页面异常 ${item.pageErrors.length} 条`);
    if (item.consoleErrors.length) issues.push(`控制台报错 ${item.consoleErrors.length} 条`);
    if (item.overflow.scrollWidth > item.overflow.docWidth + 1) {
      issues.push(`整页横向溢出 ${item.overflow.scrollWidth - item.overflow.docWidth}px`);
    }
    if (item.overflow.offenders.length) issues.push(`越界元素 ${item.overflow.offenders.length} 个`);
    if (item.bottomNav.visible && item.bottomNav.navCount !== 5) issues.push(`底部导航 ${item.bottomNav.navCount} 项（应为 5）`);
    if (item.bottomNav.overlapsContent) issues.push("底部导航遮挡内容");
    if (item.clipped?.length) issues.push(`文字被裁 ${item.clipped.length} 处`);
    if (item.tapTargets?.length) issues.push(`点击目标过小 ${item.tapTargets.length} 处`);

    if (!issues.length) {
      console.log(`✓ ${item.size.padEnd(9)} ${item.route}`);
      continue;
    }

    problems += 1;
    console.log(`✗ ${item.size.padEnd(9)} ${item.route} — ${issues.join("，")}`);
    item.pageErrors.slice(0, 3).forEach((text) => console.log(`     [pageerror] ${text.slice(0, 200)}`));
    item.consoleErrors.slice(0, 3).forEach((text) => console.log(`     [console]   ${text.slice(0, 200)}`));
    item.overflow.offenders.slice(0, 6).forEach((el) => {
      console.log(`     [overflow]  ${el.selector} left=${el.left} right=${el.right} w=${el.width}`);
    });
    (item.clipped || []).slice(0, 5).forEach((el) => {
      console.log(`     [clipped]   ${el.selector} client=${el.clientWidth} scroll=${el.scrollWidth}`);
    });
    (item.tapTargets || []).slice(0, 5).forEach((el) => {
      console.log(`     [tap]       ${el.selector} "${el.text}" ${el.w}x${el.h}`);
    });
  }

  console.log(`\n共 ${results.length} 个组合，${problems} 个存在问题。截图在 ${OUT}`);
  await writeFile(join(OUT, "report.json"), JSON.stringify(results, null, 2), "utf8");
  process.exit(problems ? 1 : 0);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
