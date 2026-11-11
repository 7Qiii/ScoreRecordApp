/**
 * 校验「装到桌面」这条路是不是真的通。
 *
 * 为什么需要这个脚本：
 * 这个项目之前 manifest.webmanifest 和 sw.js 都写好了，但 index.html 里
 * **一个 link 标签都没有** —— 浏览器不知道 manifest 的存在，于是
 * display:standalone、快捷方式、图标全部失效，手机上打开就是普通网页。
 * 光看文件在不在（public/ 里确实有）会得出「PWA 已经做好了」的错误结论。
 * 所以要按浏览器实际看到的东西来判定。
 *
 * 检查项（对应 Chrome 的「可安装」判定条件）：
 *   1. 页面里引用了 manifest
 *   2. manifest 能取到、是合法 JSON
 *   3. 有 name / start_url / display（standalone 及以上）/ 192 与 512 图标
 *   4. manifest 里每个图标的 URL 都能取到，且实际像素尺寸与声明一致
 *   5. iOS 需要的 apple-touch-icon 存在（iOS 不认 SVG）
 *   6. Service Worker 真的注册成功（可安装的必要条件）
 *   7. 快捷方式的 URL 与路由模式匹配（hash 路由必须带 /#/）
 *   8. iOS 启动图：每档机型浅 / 深两条都在、真实像素尺寸正确、
 *      而且底色真的等于 App 的 --bg（采样 PNG 像素，不是信配置）
 *   8b. iPad 必须真的被覆盖到，且横屏那条的 device-width 仍是竖屏读数。
 *      「数量一致 / 每档都在」是拿 index.html 和 screens.json 对答案，
 *      两边一致地漏掉 iPad 时它们照样全绿 —— 自洽的清单证明不了清单完整，
 *      所以这里点名要求 iPad 机型。上一版就是这么漏的。
 *   9. iOS 安装引导只在 iPhone Safari 上出现，关掉后刷新也不再出现
 *  10. iPad 独立窗口的入场动画、首屏交接、离线启动及失败时的退出
 *  11. 模拟 iOS 原生桥接，验证启动交接、失败兜底和 Service Worker 守卫
 *
 * 用法：node scripts/check-pwa.mjs
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
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

let problems = 0;
const ok = (msg) => console.log(`  ok   ${msg}`);
const bad = (msg) => { problems += 1; console.log(`  失败 ${msg}`); };
const check = (cond, msg, detail) => (cond ? ok(msg) : bad(`${msg}${detail ? ` —— ${detail}` : ""}`));

const server = createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  let file = join(DIST, normalize(decodeURIComponent(url)));
  // 目录请求直接当 404，别让 readFile 抛 EISDIR
  if (!existsSync(file) || url === "/" || !extname(file)) file = join(DIST, "index.html");
  if (!existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  res.end(await readFile(file));
});
await listenSafePort(server);
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();

const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

await page.goto(base, { waitUntil: "load" });

console.log("页面引用");
const links = await page.evaluate(() => ({
  manifest: document.querySelector('link[rel="manifest"]')?.getAttribute("href") || null,
  appleIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href") || null,
  icon: document.querySelector('link[rel="icon"]')?.getAttribute("href") || null
}));
check(!!links.manifest, "引用了 manifest", "index.html 里没有 <link rel=\"manifest\">，PWA 不会生效");
check(!!links.appleIcon, "引用了 apple-touch-icon", "iOS 上装到桌面会是没有图标的空白方块");

console.log("\nmanifest 内容");
const manifestRes = links.manifest ? await page.evaluate((href) => fetch(href).then((r) => r.status), links.manifest) : 0;
check(manifestRes === 200, `manifest 可访问（HTTP ${manifestRes}）`);

let manifest = null;
if (manifestRes === 200) {
  manifest = await page.evaluate((href) => fetch(href).then((r) => r.json()).catch(() => null), links.manifest);
  check(!!manifest, "manifest 是合法 JSON");

  if (manifest) {
    check(!!manifest.name, "有 name");
    check(!!manifest.start_url, "有 start_url");
    check(
      ["standalone", "fullscreen", "minimal-ui"].includes(manifest.display),
      `display 是 ${manifest.display}（可安装要求 standalone 及以上）`
    );
    const sizes = (manifest.icons || []).map((i) => i.sizes);
    check(sizes.includes("192x192"), "有 192×192 图标");
    check(sizes.includes("512x512"), "有 512×512 图标");
    check(
      (manifest.icons || []).some((i) => (i.purpose || "").includes("maskable")),
      "有 maskable 图标（安卓/鸿蒙裁圆角不会切到内容）"
    );

    // 启动配色必须和图标底色一致：安卓的启动屏就是「background_color + 图标」，
    // 两者不同色会看到一块突兀的方底。直接从 icon.svg 里读，别在这里再抄一遍颜色，
    // 否则改了图标忘了改这里，测试反而会替错误的组合背书。
    const iconSvg = await readFile(join(ROOT, "public", "icon.svg"), "utf8");
    const brandBg = /<rect[^>]*fill="(#[0-9a-fA-F]{3,8})"/.exec(iconSvg)?.[1]?.toLowerCase() || "";
    check(!!brandBg, `从 icon.svg 读出品牌底色（${brandBg || "读不到"}）`, "icon.svg 里找不到 <rect fill=...>");
    for (const key of ["background_color", "theme_color"]) {
      check(
        (manifest[key] || "").toLowerCase() === brandBg,
        `manifest ${key} 与图标底色一致（${manifest[key]}）`,
        `manifest ${key} 是 ${manifest[key]}，图标底色是 ${brandBg} —— 启动屏会和图标不同色`
      );
    }
  }
}

console.log("\n图标实际尺寸");
if (manifest) {
  const icons = await page.evaluate(async (list) => {
    const out = [];
    for (const icon of list) {
      const r = await fetch(icon.src);
      if (r.status !== 200) { out.push({ src: icon.src, sizes: icon.sizes, status: r.status }); continue; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; });
      out.push({ src: icon.src, sizes: icon.sizes, status: 200, w: img?.naturalWidth || 0, h: img?.naturalHeight || 0 });
      URL.revokeObjectURL(url);
    }
    return out;
  }, manifest.icons || []);

  for (const icon of icons) {
    if (icon.status !== 200) { bad(`${icon.src} 取不到（HTTP ${icon.status}）`); continue; }
    // SVG 的 sizes 是 "any"，跳过尺寸比对
    if (icon.sizes === "any") { ok(`${icon.src}（SVG，尺寸任意）`); continue; }
    const [w, h] = icon.sizes.split("x").map(Number);
    check(icon.w === w && icon.h === h, `${icon.src} 实际 ${icon.w}×${icon.h}，声明 ${icon.sizes}`, "尺寸不一致时部分浏览器会拒绝安装");
  }
}

console.log("\niOS 专用");
if (links.appleIcon) {
  const st = await page.evaluate((href) => fetch(href).then((r) => r.status).catch(() => 0), links.appleIcon);
  check(st === 200, `apple-touch-icon 可访问（HTTP ${st}）`);
  check(!links.appleIcon.endsWith(".svg"), "apple-touch-icon 不是 SVG", "iOS 不支持 SVG 主屏幕图标");
}

console.log("\niOS 启动图");
const startupLinks = await page.evaluate(() =>
  [...document.querySelectorAll('link[rel="apple-touch-startup-image"]')].map((el) => ({
    href: el.getAttribute("href"),
    media: el.getAttribute("media") || ""
  }))
);
check(
  startupLinks.length > 0,
  `声明了 ${startupLinks.length} 张启动图`,
  "一个 apple-touch-startup-image 都没有 —— 从主屏幕启动会先闪一张白屏"
);

// 启动屏底色必须和 App 首屏的 body 底色一致，否则「启动屏 → 首屏」会闪一下。
// 颜色不在这里抄第二遍 —— 开两个页面让**浏览器按真实层叠**算出 body 的
// backgroundColor，再和 PNG 的真实像素对。这样改了 CSS 忘了重新生成，这里就会挂。
// （注意不能只读 design-system.css 的 --bg：main.css 里 :root[data-theme="light"]
//   特异度更高，浅色真实的底色是它说了算。）
const APP_BG = {};
for (const mode of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 320, height: 568 } });
  const p = await ctx.newPage();
  await p.goto(base, { waitUntil: "load" });
  await p.waitForTimeout(300);
  await p.evaluate((m) => {
    document.documentElement.dataset.theme = m;
  }, mode);
  APP_BG[mode] = await p.evaluate(() => {
    const parts = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
    return `#${parts.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  });
  await ctx.close();
}
check(
  !!APP_BG.light && !!APP_BG.dark,
  `读出 App 首屏两种主题的 body 底色（浅 ${APP_BG.light} / 深 ${APP_BG.dark}）`,
  "读不到 body 的计算背景色"
);

/** 取一张图的真实像素尺寸 + 若干个采样点的颜色（用来证明它是一块纯色）。 */
const probePng = (href) =>
  page.evaluate(async (url) => {
    const blob = await (await fetch(url)).blob();
    const objectUrl = URL.createObjectURL(blob);
    const img = await new Promise((res) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => res(null);
      i.src = objectUrl;
    });
    if (!img) {
      URL.revokeObjectURL(objectUrl);
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const hex = (x, y) => {
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    };
    // 3×3 采样：正中间那一点能抓到「有人在启动屏中间放了个 logo」这种回归。
    const points = [0.25, 0.5, 0.75].flatMap((fy) =>
      [0.25, 0.5, 0.75].map((fx) => hex(Math.floor(img.naturalWidth * fx), Math.floor(img.naturalHeight * fy)))
    );
    URL.revokeObjectURL(objectUrl);
    return { w: img.naturalWidth, h: img.naturalHeight, colors: [...new Set(points)] };
  }, href);

// 和生成器的清单对答案。index.html 里的 link 是贴上去的，机型列表在
// public/splash/screens.json 里，两边会漂移，所以要逐档比。
const screensPath = join(ROOT, "public", "splash", "screens.json");
if (existsSync(screensPath)) {
  const { screens: expected, colors: declaredColors } = JSON.parse(await readFile(screensPath, "utf8"));
  check(
    expected.length * 2 === startupLinks.length,
    `启动图数量与 screens.json 一致（${expected.length} 档机型 × 2 种外观 = ${expected.length * 2} 张）`,
    `index.html 里有 ${startupLinks.length} 张，screens.json 要求 ${expected.length * 2} 张 —— 两边漂移了`
  );
  const missing = expected.filter(
    (e) => !startupLinks.some((l) => l.media === e.media) || !startupLinks.some((l) => l.media === e.mediaDark)
  );
  check(
    missing.length === 0,
    "每一档机型的浅色 / 深色两条 link 都在",
    `缺少：${missing.map((m) => m.note).join("、")}`
  );

  // 下面这几条是专为「iPad 装到主屏幕却看不到启动屏」加的。
  //
  // 为什么上面那些断言抓不到：它们都是拿 index.html 和 screens.json 对答案，
  // 而上一版 screens.json 本身也只有 iPhone —— 两边一致地缺失，于是「数量一致」
  // 「每档都在」全部通过，iPad 却一张图都没有。**自洽的清单证明不了清单是完整的**，
  // 必须点名要求 iPad 覆盖，否则同样的回归下次照样溜过去。
  const REQUIRED_IPAD = [
    { media: "(device-width: 768px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)", why: "iPad 9.7 / mini" },
    { media: "(device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)", why: "iPad Pro 11" },
    { media: "(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)", why: "iPad Pro 12.9 / 13" }
  ];
  const missingIpad = REQUIRED_IPAD.filter((r) => !startupLinks.some((l) => l.media === r.media));
  check(
    missingIpad.length === 0,
    `iPad 有启动图覆盖（${REQUIRED_IPAD.map((r) => r.why).join("、")}）`,
    `缺少 iPad 的 media 查询：${missingIpad.map((r) => r.why).join("、")} —— iPad 上会退回白屏`
  );

  const landscapeLinks = startupLinks.filter((l) => l.media.includes("(orientation: landscape)"));
  check(
    landscapeLinks.length >= 6,
    `iPad 横屏也覆盖了（${landscapeLinks.length} 条 landscape 查询）`,
    "iPad 横屏没有启动图，横着点开会闪白屏"
  );

  // 横屏那条的 device-width 必须是**竖屏读数**（宽 < 高）。device-width/height 在
  // iOS 上永远不随旋转变化，把横屏写成 (device-width: 1024px) and (device-height: 768px)
  // 是这块最常见的错，且错得静默 —— 查询语法合法，只是永远不匹配。
  const badLandscape = landscapeLinks.filter((l) => {
    const w = Number(/device-width:\s*(\d+)px/.exec(l.media)?.[1] || 0);
    const h = Number(/device-height:\s*(\d+)px/.exec(l.media)?.[1] || 0);
    return !(w > 0 && h > 0 && w < h);
  });
  check(
    badLandscape.length === 0,
    "横屏查询的 device-width 仍是竖屏读数（宽 < 高）",
    `${badLandscape.length} 条横屏查询把宽高写反了，永远不会匹配`
  );

  // 逐档机型核对四条：link 在、图能取到、**真实像素 = media 算出来的值**、
  // **真实像素颜色 = App 首屏的 body 底色**。尺寸对不上时 iOS 会直接不用这张图
  //（表现是「启动图时有时无」，极难查）；颜色对不上则会「启动屏 → 首屏」闪一下。
  for (const screen of expected) {
    const [w, h] = screen.pixels.split("x").map(Number);
    const results = [];
    for (const mode of ["light", "dark"]) {
      const href = screen[mode];
      const link = startupLinks.find((l) => l.href === href);
      if (!link) {
        results.push(`${mode} 没有 link`);
        continue;
      }
      const probe = await probePng(href);
      if (!probe) {
        results.push(`${mode} 取不到`);
        continue;
      }
      if (probe.w !== w || probe.h !== h) results.push(`${mode} 尺寸 ${probe.w}×${probe.h}≠${w}×${h}`);
      // 纯色：9 个采样点必须同色，否则说明有人在启动屏上画了东西
      if (probe.colors.length !== 1) results.push(`${mode} 不是纯色（${probe.colors.join("/")}）`);
      else if (probe.colors[0] !== APP_BG[mode]) {
        results.push(`${mode} 底色 ${probe.colors[0]}≠首屏 ${APP_BG[mode]}`);
      }
    }
    check(results.length === 0, `${screen.pixels} ${screen.note} 尺寸与底色都对`, results.join("；"));
  }

  // screens.json 里记的颜色也要和 App 首屏一致，否则说明生成器读错了来源
  for (const mode of ["light", "dark"]) {
    check(
      (declaredColors?.[mode] || "") === APP_BG[mode],
      `screens.json 记的 ${mode} 底色与 App 首屏一致（${declaredColors?.[mode]}）`,
      `screens.json 写的是 ${declaredColors?.[mode]}，App 首屏是 ${APP_BG[mode]} —— 生成器读的颜色来源不对`
    );
  }
}

console.log("\niOS 安装引导");
// 桌面浏览器上这条提示不该出现（检测的是 iOS Safari UA）
check(
  !(await page.evaluate(() => !!document.querySelector(".install-hint"))),
  "桌面浏览器上不出现「添加到主屏幕」引导"
);

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

async function iosPage(extra) {
  const context = await browser.newContext({
    userAgent: IOS_UA,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true
  });
  const p = await context.newPage();
  if (extra) await p.addInitScript(extra);
  await p.goto(base, { waitUntil: "load" });
  await p.waitForTimeout(1500);
  return { context, page: p };
}

const hasHint = (p) => p.evaluate(() => !!document.querySelector(".install-hint"));

const ios = await iosPage();
check(await hasHint(ios.page), "iPhone Safari 上出现「添加到主屏幕」引导", "iOS 用户看不到安装方法");
check(!(await ios.page.locator("#app-launch").count()), "Safari 标签页跳过启动画面");
if (await hasHint(ios.page)) {
  await ios.page.locator(".install-hint button").click();
  await ios.page.waitForTimeout(300);
  check(!(await hasHint(ios.page)), "点关闭后引导消失");
  await ios.page.reload({ waitUntil: "load" });
  await ios.page.waitForTimeout(1500);
  check(!(await hasHint(ios.page)), "刷新后不再出现（已记到 localStorage）");
}
await ios.context.close();

// 已经装到主屏幕（standalone）时不该再提
const standalone = await iosPage(() => {
  Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
});
check(!(await hasHint(standalone.page)), "已装到主屏幕（standalone）时不再提示");
await standalone.context.close();

console.log("\niPad 独立窗口启动");
const ipadUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const entryJs = /\/assets\/index-[^/]+\.js$/;

async function ipadLaunchPage({ landscape = false, reducedMotion = "no-preference", colorScheme = "light" } = {}) {
  const context = await browser.newContext({
    userAgent: ipadUa,
    viewport: landscape ? { width: 1194, height: 834 } : { width: 834, height: 1194 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    reducedMotion,
    colorScheme
  });
  const page = await context.newPage();
  await page.addInitScript((useDisplayMode) => {
    if (useDisplayMode) {
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query) => matchMedia(query === "(display-mode: standalone)" ? "(min-width: 0px)" : query);
    } else {
      Object.defineProperty(navigator, "standalone", { value: true });
    }
    document.addEventListener("animationstart", (event) => {
      if (event.animationName === "launch-brand-in") window.launchAnimated = true;
    });
    document.addEventListener("score-record:launch-ready", () => {
      window.launchReadyWithDashboard = !!document.querySelector(".dashboard-page");
    });
  }, landscape);
  return { context, page, launch: page.locator("#app-launch") };
}

const ipad = await ipadLaunchPage();
let releaseEntry;
const entryGate = new Promise((resolve) => { releaseEntry = resolve; });
await ipad.page.route(entryJs, async (route) => {
  await entryGate;
  await route.continue();
});
await ipad.page.goto(base, { waitUntil: "commit" });
await ipad.launch.waitFor({ state: "visible", timeout: 1500 });
await ipad.page.waitForFunction(() => window.launchAnimated, undefined, { timeout: 1500 });
check(!(await ipad.page.locator("#app[data-v-app]").count()), "iPad 竖屏在 Vue 下载完之前就能播放动画");
releaseEntry();
await ipad.page.unrouteAll({ behavior: "wait" });
await ipad.launch.waitFor({ state: "detached", timeout: 3500 });
check(await ipad.page.evaluate(() => window.launchReadyWithDashboard), "档案与首页已渲染，再退出启动画面");

await ipad.page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 8000 });
await ipad.page.reload({ waitUntil: "load" });
await ipad.page.locator(".dashboard-page").waitFor({ timeout: 3500 });
await ipad.context.setOffline(true);
await ipad.page.reload({ waitUntil: "load" });
await ipad.launch.waitFor({ state: "detached", timeout: 3500 });
check(await ipad.page.evaluate(() => window.launchAnimated && window.launchReadyWithDashboard), "已缓存的 iPad 独立窗口离线启动也能播放并进入首页");
await ipad.context.close();

const reduced = await ipadLaunchPage({ landscape: true, reducedMotion: "reduce", colorScheme: "dark" });
await reduced.page.route(entryJs, (route) => route.abort());
await reduced.page.goto(base, { waitUntil: "commit" });
await reduced.launch.waitFor({ state: "visible", timeout: 1500 });
const reducedStyles = await reduced.launch.evaluate((el) => ({
  background: getComputedStyle(el).backgroundColor,
  transition: getComputedStyle(el).transitionProperty,
  animation: getComputedStyle(el.firstElementChild).animationName
}));
check(reducedStyles.background === "rgb(15, 20, 27)" && reducedStyles.transition === "none" && reducedStyles.animation === "none",
  "横屏深色、减少动态效果时显示静态品牌画面", JSON.stringify(reducedStyles));
await reduced.launch.waitFor({ state: "detached", timeout: 3500 });
check(!(await reduced.page.locator("#app[data-v-app]").count()), "应用入口加载失败时启动画面也会自动退出");
await reduced.context.close();

console.log("\niOS 原生容器启动（模拟 Capacitor 桥接）");
async function nativeLaunchPage(hideFails) {
  const context = await browser.newContext({ userAgent: IOS_UA, viewport: { width: 834, height: 1194 }, hasTouch: true });
  const page = await context.newPage();
  await page.addInitScript((hideFails) => {
    window.webkit = { messageHandlers: { bridge: {} } };
    window.Capacitor = {
      getPlatform: () => "ios",
      PluginHeaders: [{ name: "SplashScreen", methods: [{ name: "hide", rtype: "promise" }] }],
      nativePromise: (plugin, method, options) => {
        window.nativeHideCall = { plugin, method, options };
        return hideFails ? Promise.reject(new Error("模拟原生启动屏交接失败")) :
          new Promise((resolve) => { window.finishNativeHide = resolve; });
      }
    };
    navigator.serviceWorker.register = async () => { window.nativeSwRegistered = true; };
    document.addEventListener("animationstart", (event) => {
      if (event.animationName === "launch-brand-in") window.nativeLaunchAnimated = true;
    });
  }, hideFails);
  await page.goto(base, { waitUntil: "load" });
  await page.locator(".dashboard-page").waitFor({ timeout: 5000 });
  await page.waitForFunction(() => !!window.nativeHideCall, undefined, { timeout: 5000 });
  return { context, page, launch: page.locator("#app-launch") };
}

const native = await nativeLaunchPage(false);
check(await native.launch.isVisible() && await native.launch.evaluate((el) => getComputedStyle(el.firstElementChild).animationName === "none"),
  "首页先就绪时，原生启动屏退场前的网页品牌层保持可见且不提前播放");
check(await native.page.evaluate(() => window.nativeHideCall.plugin === "SplashScreen" && window.nativeHideCall.method === "hide" && !window.nativeSwRegistered),
  "通过 Capacitor 桥接关闭启动屏，原生容器不注册 Service Worker");
check(!(await hasHint(native.page)), "原生容器跳过网页安装引导");
await native.page.evaluate(() => window.finishNativeHide());
await native.launch.waitFor({ state: "detached", timeout: 3500 });
check(await native.page.evaluate(() => window.nativeLaunchAnimated), "原生启动屏交接后播放动画并进入首页");
await native.context.close();

const nativeFailed = await nativeLaunchPage(true);
await nativeFailed.launch.waitFor({ state: "detached", timeout: 3500 });
check(await nativeFailed.page.locator(".dashboard-page").isVisible(), "原生插件调用失败时网页启动层超时退场");
await nativeFailed.context.close();

console.log("\nService Worker");
const swState = await page.evaluate(async () => {
  if (!("serviceWorker" in navigator)) return "unsupported";
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, rej) => setTimeout(() => rej(new Error("超时")), 8000))
    ]);
    return reg?.active ? "active" : "registered";
  } catch (e) { return `失败：${e.message}`; }
});
check(swState === "active", `Service Worker 已激活（${swState}）`, "SW 是可安装的必要条件");

console.log("\n快捷方式 URL");
// 直接从源码判断路由模式，比猜更可靠
const routerSrc = existsSync(join(ROOT, "src/router/index.js")) ? await readFile(join(ROOT, "src/router/index.js"), "utf8") : "";
const usesHash = /createWebHashHistory/.test(routerSrc);
if (manifest?.shortcuts) {
  for (const s of manifest.shortcuts) {
    const valid = usesHash ? s.url.includes("#/") : !s.url.includes("#/");
    check(valid, `快捷方式「${s.short_name}」${s.url}${usesHash ? "（hash 路由需带 /#/）" : ""}`);
  }
}

console.log("\n控制台");
check(consoleErrors.length === 0, "无控制台报错", consoleErrors.slice(0, 3).join(" | "));

await browser.close();
server.close();

console.log(`\n${problems === 0 ? "全部通过" : `共 ${problems} 个问题`}`);
process.exitCode = problems === 0 ? 0 : 1;
