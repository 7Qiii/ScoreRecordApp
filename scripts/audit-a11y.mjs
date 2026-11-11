/**
 * 无障碍 / 可用性巡检。
 *
 * 和 audit-buttons.mjs 的分工：那个管「点了有没有反应」，这个管
 * 「不点、或者用键盘和读屏，能不能用得下去」。查的都是能客观判定、
 * 不靠审美争论的硬指标：
 *
 *   1. 每个路由有没有控制台报错
 *   2. 可点元素有没有可访问名称（读屏念不出来的按钮 = 哑巴按钮）
 *   3. 表单控件有没有关联的 label
 *   4. 图片有没有 alt
 *   5. 手机尺寸下点击目标够不够大（44×44 是通行下限）
 *   6. 每页有没有 h1、标题层级有没有跳级
 *   7. 页面里有没有重复 id
 *
 * 用法：
 *   node scripts/audit-a11y.mjs
 *   node scripts/audit-a11y.mjs --only=/records
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createRequire } from "node:module";
import { listenSafePort } from "./lib/safe-listen.mjs";

const WORKSPACE = "C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace";
const chromium = createRequire(`${WORKSPACE}/package.json`)("playwright-core").chromium;
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

/**
 * 要审的路由。
 *
 * 大多数是一条路径字符串。但有些界面默认是收起的 —— 首页的录入表单要先点
 * 「记录成绩」才展开 —— 只审初始状态等于没审到它，而录入表单恰恰是
 * 整个应用最主要的数据入口。这类写成对象，用 prepare() 先展开再查。
 */
const ROUTES = [
  "/",
  "/records",
  "/mistakes",
  "/subjects",
  "/backup",
  "/login",
  {
    label: "/ 录入表单（展开后）",
    path: "/",
    async prepare(page) {
      await page.click('button:has-text("记录成绩")');
      await page.waitForSelector(".record-form", { timeout: 8000 });
      await page.waitForTimeout(400);
    }
  }
];

const routePath = (route) => (typeof route === "string" ? route : route.path);
const routeLabel = (route) => (typeof route === "string" ? route : route.label || route.path);

/** 一次性把该查的东西都在页面里算完，避免来回 evaluate */
const PROBE = `(() => {
  const describe = (el) => {
    const cls = typeof el.className === "string" ? el.className.split(/\\s+/).filter(Boolean).slice(0, 2).join(".") : "";
    const text = (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 20);
    return el.tagName.toLowerCase() + (cls ? "." + cls : "") + (text ? " 「" + text + "」" : "");
  };

  const visible = (el) => {
    if (el.closest("[aria-hidden='true']")) return false;
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };

  const nameOf = (el) => {
    const label = el.getAttribute("aria-label");
    if (label && label.trim()) return label.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const target = document.getElementById(labelledBy);
      if (target && target.innerText.trim()) return target.innerText.trim();
    }
    const text = (el.innerText || el.textContent || "").trim();
    if (text) return text;
    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    const img = el.querySelector("img[alt]");
    if (img && img.getAttribute("alt").trim()) return img.getAttribute("alt").trim();
    const svgTitle = el.querySelector("svg title");
    if (svgTitle && svgTitle.textContent.trim()) return svgTitle.textContent.trim();
    return "";
  };

  // 1. 可点元素没有可访问名称
  const nameless = [];
  document.querySelectorAll("button, a[href], [role='button'], [role='link']").forEach((el) => {
    if (!visible(el)) return;
    if (!nameOf(el)) nameless.push(describe(el));
  });

  // 2. 表单控件没有 label
  const unlabelled = [];
  document.querySelectorAll("input, select, textarea").forEach((el) => {
    if (el.type === "hidden" || !visible(el)) return;
    if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")) return;
    if (el.id && document.querySelector("label[for='" + el.id + "']")) return;
    if (el.closest("label")) return;
    unlabelled.push(describe(el) + (el.placeholder ? " placeholder=「" + el.placeholder + "」" : ""));
  });

  // 3. 图片没有 alt
  const noAlt = [];
  document.querySelectorAll("img").forEach((el) => {
    if (!visible(el)) return;
    if (el.getAttribute("alt") === null) noAlt.push(describe(el) + " src=" + (el.getAttribute("src") || "").slice(0, 40));
  });

  // 4. 点击目标大小
  //
  //    两个容易搞错的地方：
  //    a) 真正能被点到的是包着控件的 <label>，不是那个 16px 的 input。
  //       量 input 会量出一堆假问题，所以有 label 就量 label。
  //    b) 行内文字链接（句子中间那种）不受最小点击目标约束，
  //       WCAG 2.2 明确把它排除在外，别拿它凑数。
  //
  //    判定线用 WCAG 2.2 AA 的 24px；44px 是 Apple HIG 的建议值，
  //    达不到不算违规，只作为「不够宽裕」列出来供参考。
  const targets = [];
  document.querySelectorAll("button, a[href], [role='button'], input[type='checkbox'], input[type='radio']").forEach((el) => {
    if (!visible(el)) return;
    const isTextLink = el.tagName === "A" && !el.classList.contains("icon-button") && !el.classList.contains("secondary-button") && !el.classList.contains("ds-quick-item");
    if (isTextLink) return;

    const label = el.closest("label");
    const target = label && visible(label) ? label : el;
    const rect = target.getBoundingClientRect();
    targets.push({
      desc: describe(el) + (label ? "（label " + Math.round(rect.width) + "×" + Math.round(rect.height) + "）" : ""),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      under24: Math.min(rect.width, rect.height) < 24,
      under44: Math.min(rect.width, rect.height) < 44
    });
  });
  const small = targets.filter((t) => t.under24);
  const cramped = targets.filter((t) => !t.under24 && t.under44);

  // 5. 标题层级
  const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")]
    .filter(visible)
    .map((el) => ({ level: Number(el.tagName[1]), text: el.innerText.replace(/\\s+/g, " ").trim().slice(0, 20) }));
  const h1Count = headings.filter((h) => h.level === 1).length;
  const skips = [];
  let previous = 0;
  headings.forEach((h) => {
    if (previous && h.level > previous + 1) skips.push("h" + previous + " → h" + h.level + " 「" + h.text + "」");
    previous = h.level;
  });

  // 6. 重复 id
  const idCounts = new Map();
  document.querySelectorAll("[id]").forEach((el) => idCounts.set(el.id, (idCounts.get(el.id) || 0) + 1));
  const dupIds = [...idCounts.entries()].filter(([, count]) => count > 1).map(([id, count]) => id + " ×" + count);

  return { nameless, unlabelled, noAlt, small, cramped, h1Count, skips, dupIds };
})()`;

async function auditRoute(browser, base, route, viewport, label) {
  const page = await browser.newPage({ viewport });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 140));
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error.message).slice(0, 140)));

  let result = null;
  try {
    await page.goto(`${base}/#${routePath(route)}`, { waitUntil: "load" });
    await page.waitForTimeout(1800);
    // 收起状态的界面要先展开到要审的样子，再跑探针
    if (typeof route === "object" && route.prepare) await route.prepare(page);
    result = await page.evaluate(PROBE);
  } catch (error) {
    consoleErrors.push(`探针执行失败：${String(error.message).split("\n")[0]}`);
  } finally {
    await page.close();
  }
  return { route: routeLabel(route), label, consoleErrors, ...(result || {}) };
}

/**
 * 系统里开了「减少动态效果」时，页面必须真的安静下来。
 *
 * 只声明 `@media (prefers-reduced-motion: reduce)` 是不够的 —— 很容易被
 * 后面某条更具体的规则盖掉。所以这里用 reduce 模式真的渲染一遍，
 * 把所有元素算完之后的 transition / animation 时长读出来看。
 */
const MOTION_PROBE = `(() => {
  const toSeconds = (value) => {
    const text = String(value || "").trim();
    if (!text) return 0;
    if (text.endsWith("ms")) return parseFloat(text) / 1000;
    if (text.endsWith("s")) return parseFloat(text);
    return 0;
  };
  let worstTransition = 0;
  let worstAnimation = 0;
  let worstElement = "";
  document.querySelectorAll("*").forEach((el) => {
    if (!el.getBoundingClientRect().width && !el.getBoundingClientRect().height) return;
    const style = getComputedStyle(el);
    const transition = Math.max(0, ...style.transitionDuration.split(",").map(toSeconds));
    const animation = Math.max(0, ...style.animationDuration.split(",").map(toSeconds));
    if (transition > worstTransition) {
      worstTransition = transition;
      worstElement = el.tagName.toLowerCase() + "." + String(el.className).split(" ")[0];
    }
    if (animation > worstAnimation) worstAnimation = animation;
  });
  return { worstTransition, worstAnimation, worstElement };
})()`;

async function checkReducedMotion(browser, base, routes) {
  const problems = [];
  for (const route of routes) {
    // 先看看不限制的时候确实有动画，否则「测出来是 0」说明不了任何问题
    const normal = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await normal.goto(`${base}/#${routePath(route)}`, { waitUntil: "load" });
    await normal.waitForTimeout(1500);
    const baseline = await normal.evaluate(MOTION_PROBE);
    await normal.close();

    const reduced = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    await reduced.goto(`${base}/#${routePath(route)}`, { waitUntil: "load" });
    await reduced.waitForTimeout(1500);
    const actual = await reduced.evaluate(MOTION_PROBE);
    await reduced.close();

    if (baseline.worstTransition < 0.05 && baseline.worstAnimation < 0.05) {
      problems.push(`${route}：这个页面上本来就没有动画，检查没有意义`);
    } else if (actual.worstTransition > 0.01 || actual.worstAnimation > 0.01) {
      problems.push(
        `${route}：开了「减少动态效果」之后仍有动画（transition ${actual.worstTransition}s / animation ${actual.worstAnimation}s，最长的在 ${actual.worstElement}）`
      );
    }
  }
  return problems;
}

/**
 * 浮层能不能关掉。
 *
 * 全站浮层原来都只能靠再点一次触发按钮来关，点别处会一直挂着。
 * 这里逐个验证「按 Escape 能关」和「点别处能关」。
 */
async function checkPopovers(browser, base) {
  const problems = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => problems.push(`控制台报错：${String(error.message).slice(0, 120)}`));

  const gone = async (selector) => (await page.locator(selector).count()) === 0;

  try {
    await page.goto(`${base}/#/records`, { waitUntil: "load" });
    await page.waitForTimeout(2200);

    // 造一个「未记录用时」的健康问题，再把它的忽略状态预置好 ——
    // 这样「已忽略」那个按钮才会渲染出来（它只在有被忽略项时才显示）
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open("exam-tracker-v3");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction("records", "readwrite");
            tx.objectStore("records").put({
              id: "popover-untimed",
              subjectId: "math1",
              recordType: "paper",
              paperName: "没记用时的卷子",
              score: 80,
              fullScore: 150,
              durationMinutes: "",
              date: "2025-06-01",
              createdAt: "2025-06-01T10:00:00.000Z",
              note: ""
            });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        })
    );
    await page.evaluate(() => localStorage.setItem("exam-tracker-ignored-health-issues", JSON.stringify(["untimed"])));
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(2200);

    // ---- 排序菜单 ----
    const sortTrigger = page.locator(".records-sort-trigger");
    const SORT = ".records-sort-popover";

    await sortTrigger.click();
    await page.waitForTimeout(250);
    if (await gone(SORT)) problems.push("排序菜单点开后没出现");

    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    if (!(await gone(SORT))) problems.push("排序菜单按 Escape 关不掉");

    await sortTrigger.click();
    await page.waitForTimeout(250);
    await page.locator(".ds-page-head").click({ position: { x: 4, y: 4 } });
    await page.waitForTimeout(250);
    if (!(await gone(SORT))) problems.push("排序菜单点别处关不掉");

    // ---- 已忽略面板 ----
    const ignoreTrigger = page.locator('button:has-text("已忽略")');
    const PANEL = ".ignored-health-panel";

    if (await ignoreTrigger.count()) {
      await ignoreTrigger.first().click();
      await page.waitForTimeout(250);
      if (await gone(PANEL)) problems.push("「已忽略」面板点开后没出现");

      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      if (!(await gone(PANEL))) problems.push("「已忽略」面板按 Escape 关不掉");

      await ignoreTrigger.first().click();
      await page.waitForTimeout(250);
      await page.locator(".ds-page-head").click({ position: { x: 4, y: 4 } });
      await page.waitForTimeout(250);
      if (!(await gone(PANEL))) problems.push("「已忽略」面板点别处关不掉");
    } else {
      problems.push("没能让「已忽略」按钮出现，这个面板没测到");
    }

    // ---- 顶部搜索建议 ----
    const searchInput = page.locator('input[aria-label="搜索成绩和错题"]');
    const POPOVER = ".global-search-popover";

    await searchInput.click();
    await searchInput.fill("卷");
    await page.waitForTimeout(300);
    if (await gone(POPOVER)) problems.push("搜索建议输入后没出现");

    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    if (!(await gone(POPOVER))) problems.push("搜索建议按 Escape 关不掉");

    await searchInput.click();
    await searchInput.fill("卷");
    await page.waitForTimeout(300);
    await page.locator(".ds-page-head").click({ position: { x: 4, y: 4 } });
    await page.waitForTimeout(300);
    if (!(await gone(POPOVER))) problems.push("搜索建议点别处关不掉");
  } catch (error) {
    problems.push(`执行出错：${String(error.message).split("\n")[0]}`);
  } finally {
    await page.close();
  }

  return problems;
}

async function main() {
  if (!existsSync(DIST)) throw new Error("dist/ 不存在，先跑一次 npm run build。");

  const only = (process.argv.find((arg) => arg.startsWith("--only=")) || "").split("=")[1];
  const routes = only ? ROUTES.filter((route) => routeLabel(route) === only || routePath(route) === only) : ROUTES;

  // 一个都没匹配上就直接报错退出。否则会「跑完、什么都没查、还报全部通过」——
  // Git Bash 会把 / 开头的参数当路径转换（`--only=/` → `--only=C:/.../Git/`），
  // 于是 --only 静默失效，看起来像验过了，其实一条路由都没进。
  if (!routes.length) {
    console.error(`--only=${only} 没有匹配到任何路由。`);
    console.error(`已知路由：${ROUTES.map(routeLabel).join(" / ")}`);
    console.error("提示：Git Bash 会把 / 开头的参数当路径转换，请加 MSYS_NO_PATHCONV=1 前缀。");
    process.exit(1);
  }

  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });

  const DESKTOP = { width: 1440, height: 900 };
  const MOBILE = { width: 375, height: 667 };

  let issues = 0;
  const report = [];

  console.log("桌面 1440×900");
  for (const route of routes) {
    const r = await auditRoute(browser, base, route, DESKTOP, "桌面");
    report.push(r);
    const problems = [];
    if (r.consoleErrors?.length) problems.push(`控制台报错 ${r.consoleErrors.length} 条：${r.consoleErrors[0]}`);
    if (r.nameless?.length) problems.push(`可点元素无可访问名称 ${r.nameless.length} 个：${r.nameless.slice(0, 4).join(" / ")}`);
    if (r.unlabelled?.length) problems.push(`表单控件无 label ${r.unlabelled.length} 个：${r.unlabelled.slice(0, 4).join(" / ")}`);
    if (r.noAlt?.length) problems.push(`图片无 alt ${r.noAlt.length} 个：${r.noAlt.slice(0, 3).join(" / ")}`);
    if (r.h1Count !== 1) problems.push(`h1 有 ${r.h1Count} 个（应为 1）`);
    if (r.skips?.length) problems.push(`标题跳级：${r.skips.slice(0, 3).join(" / ")}`);
    if (r.dupIds?.length) problems.push(`重复 id：${r.dupIds.slice(0, 4).join(" / ")}`);
    issues += problems.length;
    if (problems.length) {
      console.log(`  ✗ ${routeLabel(route)}`);
      problems.forEach((p) => console.log(`      · ${p}`));
    } else {
      console.log(`  ✓ ${routeLabel(route)}`);
    }
  }

  console.log("\n手机 375×667（点击目标）");
  for (const route of routes) {
    const r = await auditRoute(browser, base, route, MOBILE, "手机");
    report.push(r);
    if (r.small?.length) {
      issues += 1;
      console.log(`  ✗ ${routeLabel(route)} —— ${r.small.length} 个点击目标小于 24px（WCAG 2.2 AA 下限）`);
      r.small.slice(0, 6).forEach((s) => console.log(`      · ${s.desc} ${s.w}×${s.h}`));
    } else {
      const cramped = r.cramped?.length || 0;
      console.log(`  ✓ ${routeLabel(route)}${cramped ? ` —— 全部达到 24px；另有 ${cramped} 个在 24–44px 之间（不违规，仅供参考）` : ""}`);
    }
  }

  console.log("\n系统开启「减少动态效果」");
  const motionProblems = await checkReducedMotion(browser, base, routes);
  if (motionProblems.length) {
    issues += motionProblems.length;
    motionProblems.forEach((p) => console.log(`  ✗ ${p}`));
  } else {
    console.log(`  ✓ ${routes.length} 个路由都真的安静下来了`);
  }

  console.log("\n浮层可关闭性（Escape / 点别处）");
  const popoverProblems = await checkPopovers(browser, base);
  if (popoverProblems.length) {
    issues += popoverProblems.length;
    popoverProblems.forEach((p) => console.log(`  ✗ ${p}`));
  } else {
    console.log("  ✓ 排序菜单 / 已忽略面板 / 搜索建议 都能用 Escape 和点别处关掉");
  }

  console.log(`\n共 ${issues} 类问题。明细见 .verify/a11y-report.json`);
  await browser.close();
  server.close();

  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(".verify", { recursive: true });
  await writeFile(".verify/a11y-report.json", JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
