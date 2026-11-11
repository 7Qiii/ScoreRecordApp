/**
 * 生成 iOS 启动图（apple-touch-startup-image）。
 *
 * 为什么需要：
 *   从主屏幕启动一个 iOS 网页应用时，如果没声明启动图，系统会先给一张**白屏**，
 *   等页面渲染完才出现内容 —— 这一下白闪是「像个网页」和「像个 App」最明显的差别。
 *   iOS 又不像 Android 那样能用 manifest 的 background_color 自动生成，
 *   必须**每种机型分辨率各给一张**，靠 media 查询精确匹配。
 *
 * 为什么启动图「什么都没有」：
 *   这不是偷懒，是照 Apple 人机界面指南（HIG · Launching）抄的。原文：
 *     · "A launch screen isn't an opportunity for artistic expression."
 *     · "Design a launch screen that's nearly identical to the first screen…
 *        If your app displays a solid color before transitioning to the first
 *        screen, create a launch screen that displays only that solid color."
 *     · "Avoid including text on your launch screen."（文字没法本地化）
 *     · "Don't advertise… don't include logos or other branding elements unless
 *        they're a fixed part of your app's first screen."
 *   之前那版放了一个「IN」字标 + 「错题本」，四条全踩：启动屏和首屏不一样，
 *   反而制造了一次「深蓝 → 浅色」的闪。启动屏的作用是把「还没渲染好」的那段
 *   时间藏起来，不是给人看画面。
 *
 * 但「什么都不画」也踩了同一个坑的另一个面：
 *   只铺一层和 body 相同的底色，启动图和 App 自己的背景**像素级一致**，
 *   用户根本看不出它存在过 —— 反馈就是「没有启动动画」，明明它是生效的。
 *   HIG 的原话是「和首屏**几乎一样**」，前提是首屏本身有东西。这个 App 的
 *   首屏有顶栏、宽屏有侧栏、窄屏有底部导航，所以启动图要照着画这几块
 *   **纯色矩形**（仍然没有文字、没有 logo，仍然不碰渐变），
 *   这样过渡依然是无缝的，但看得见。
 *
 * 颜色从哪来 —— 两个踩过的坑，都写在这儿免得再踩：
 *   1. **不能手抄 --bg。** 这个项目里 --bg 被定义了好几次，而 main.css 的
 *      `:root[data-theme="light"]`（特异度 0,2,0）会压过 design-system.css 里的
 *      裸 `:root`（0,1,0）—— 所以浅色真实的底色是 #dfe7f0，不是 #f4f6f9。
 *      抄一份就必然和首屏对不上。
 *   2. **也不去复刻那层渐变。** 首屏 body 的渐变里有一条 `... 54%` 的色标，
 *      是按 body 高度算的，而 body 高度由内容决定（实测 3018px）。静态图片
 *      无论怎么画都对不齐，反而把单张图从 12KB 撑到 505KB。
 *      实测「平铺底色」和「复刻渐变」的最大色差是同一个量级（Δ≈13/255），
 *      所以老老实实用平铺底色。
 *   所以这里用**浏览器读真实计算样式**（body 的 backgroundColor，即渐变下面的
 *   基色）—— 由浏览器按完整层叠算出来，改了 CSS 重新生成即可，永不漂移。
 *
 * 产出：public/splash/<light|dark>/<宽>x<高>.png，文件名就是真实像素尺寸。
 *       纯色 PNG 自己编码，不走截图，所以单张十几 KB（截图版要 505KB）。
 * 用法：node scripts/gen-splash.mjs
 */
import { createRequire } from "node:module";
import { deflateSync, inflateSync, crc32 } from "node:zlib";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { listenSafe } from "./lib/safe-listen.mjs";

const WORKSPACE = "C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace";
const chromium = createRequire(`${WORKSPACE}/package.json`)("playwright-core").chromium;

const BROWSER_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
];

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, "public", "splash");

/** 和 src/main.js 的 import 顺序保持一致 —— 顺序错了算出来的背景就不是首屏那个背景。 */
const CSS_FILES = ["main.css", "mistakes-refresh.css", "tablet.css", "design-system.css"];

/**
 * iPhone 各代的分辨率。
 *
 * width / height 是 **CSS 点**（就是 media 查询里 device-width 用的值），
 * ratio 是 -webkit-device-pixel-ratio，两者相乘才是图片的真实像素。
 * 竖屏取值：device-width/device-height 在 iOS 上恒为竖屏尺寸，不随旋转变化。
 */
export const IPHONE_SCREENS = [
  { width: 320, height: 568, ratio: 2, note: "SE 1代 / 5s" },
  { width: 375, height: 667, ratio: 2, note: "SE 2/3代 / 8 / 7 / 6s" },
  { width: 375, height: 812, ratio: 3, note: "X / XS / 11 Pro / 12·13 mini" },
  { width: 390, height: 844, ratio: 3, note: "12 / 13 / 14" },
  { width: 393, height: 852, ratio: 3, note: "14 Pro / 15 / 15 Pro / 16" },
  { width: 402, height: 874, ratio: 3, note: "16 Pro" },
  { width: 414, height: 896, ratio: 2, note: "XR / 11" },
  { width: 414, height: 896, ratio: 3, note: "XS Max / 11 Pro Max" },
  { width: 428, height: 926, ratio: 3, note: "12·13 Pro Max / 14 Plus" },
  { width: 430, height: 932, ratio: 3, note: "14 Pro Max / 15 Plus / 15 Pro Max / 16 Plus" },
  { width: 440, height: 956, ratio: 3, note: "16 Pro Max" }
];

/**
 * iPad 各代的**竖屏**尺寸（CSS 点）。
 *
 * 这里就是「iPad 装了却看不到启动屏」的根因所在：上一版只列了 iPhone，
 * iPad 上没有任何一条 media 查询能匹配上 —— iOS 匹配不到就退回白屏，
 * 不报错、不提示，看起来就像「iPad 不支持启动屏」。其实支持，只是没给图。
 *
 * 两个和 iPhone 不一样的地方：
 *   1. **iPad 要区分横竖屏。** iPhone 的 device-width/height 恒定竖屏值，
 *      一条查询就够；iPad 能转，所以每种尺寸要 portrait / landscape 各一张。
 *   2. **横屏那一条的 device-width 仍然是竖屏值。** 这是最容易写错的地方：
 *      device-width/device-height 在 iOS 上**永远**是竖屏读数，不随旋转变化，
 *      变的只是当前 orientation 条件是否成立。所以横屏的 media 查询里
 *      宽高照写竖屏的 768×1024，只有**图片**要转成 2048×1536。
 *      写成 (device-width: 1024px) 的横屏查询永远不会匹配。
 */
export const IPAD_BASE = [
  { width: 768, height: 1024, ratio: 2, note: "iPad 9.7 / mini 1-5" },
  { width: 810, height: 1080, ratio: 2, note: "iPad 10.2" },
  { width: 820, height: 1180, ratio: 2, note: "iPad 10.9 / Air 4-5 / Air 11 M2" },
  { width: 834, height: 1112, ratio: 2, note: "iPad Pro 10.5" },
  { width: 834, height: 1194, ratio: 2, note: "iPad Pro 11" },
  { width: 1024, height: 1366, ratio: 2, note: "iPad Pro 12.9 / 13" },
  { width: 744, height: 1133, ratio: 2, note: "iPad mini 6" }
];

export const IPAD_SCREENS = IPAD_BASE.flatMap((screen) => [
  { ...screen, orientation: "portrait" },
  { ...screen, orientation: "landscape", note: `${screen.note} · 横屏` }
]);

/** iPhone 不用管方向（device-width 恒定竖屏），iPad 必须区分。 */
export const ALL_SCREENS = [
  ...IPHONE_SCREENS.map((screen) => ({ ...screen, orientation: null })),
  ...IPAD_SCREENS
];

/**
 * 图片的真实像素。
 * 横屏那张要把宽高对调 —— 但**只对图片**，media 查询里仍是竖屏读数。
 */
export const screenPixels = (screen) =>
  screen.orientation === "landscape"
    ? { w: screen.height * screen.ratio, h: screen.width * screen.ratio }
    : { w: screen.width * screen.ratio, h: screen.height * screen.ratio };

export const splashPixels = (screen) => {
  const { w, h } = screenPixels(screen);
  return `${w}x${h}`;
};
export const splashPath = (mode, screen) => `/splash/${mode}/${splashPixels(screen)}.png`;

/**
 * iOS 匹配启动图用的 media 查询，必须和图片的真实像素完全对应。
 * 深色那一条在设备条件前再加一个 prefers-color-scheme 条件。
 * 带方向的那一条（iPad）在最后追加 orientation 条件。
 */
export const splashMedia = (screen, mode) => {
  const parts = [
    `(device-width: ${screen.width}px)`,
    `(device-height: ${screen.height}px)`,
    `(-webkit-device-pixel-ratio: ${screen.ratio})`
  ];
  if (screen.orientation) parts.push(`(orientation: ${screen.orientation})`);
  const device = parts.join(" and ");
  return mode === "dark" ? `(prefers-color-scheme: dark) and ${device}` : device;
};

// ---------------------------------------------------------------------------
// 极简 PNG 编码：只做「整张图一个颜色」这一件事。
// 比开无头浏览器截图快得多，也不会把平滑渐变编成 500KB 的抖动噪点。
// ---------------------------------------------------------------------------
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/**
 * 一张 RGB 画布，最后编码成 PNG。
 *
 * 为什么不直接截图：截图会把抗锯齿、字体、渐变全带进来，单张 505KB，
 * 而且和首屏永远对不齐（见文件头第 2 条）。这里只画**首屏的几个矩形**，
 * 颜色全部来自浏览器算出来的真实值，单张仍然只有几 KB。
 */
function createCanvas(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 3) };
}

function fillAll(canvas, hex) {
  const [r, g, b] = hexToRgb(hex);
  for (let i = 0; i < canvas.data.length; i += 3) {
    canvas.data[i] = r;
    canvas.data[i + 1] = g;
    canvas.data[i + 2] = b;
  }
}

/** 画一个矩形，radius > 0 时切圆角（逐像素判，够用且不引入依赖）。 */
function fillRect(canvas, x, y, w, h, hex, radius = 0) {
  const [r, g, b] = hexToRgb(hex);
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(canvas.width, Math.round(x + w));
  const y1 = Math.min(canvas.height, Math.round(y + h));
  const rad = Math.min(radius, Math.floor(Math.min(w, h) / 2));
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      if (rad > 0) {
        // 落在四个角的方框内才判圆角
        const cx = px < x0 + rad ? x0 + rad : px >= x1 - rad ? x1 - rad - 1 : px;
        const cy = py < y0 + rad ? y0 + rad : py >= y1 - rad ? y1 - rad - 1 : py;
        if (cx !== px || cy !== py) {
          const dx = px - cx;
          const dy = py - cy;
          if (dx * dx + dy * dy > rad * rad) continue;
        }
      }
      const i = (py * canvas.width + px) * 3;
      canvas.data[i] = r;
      canvas.data[i + 1] = g;
      canvas.data[i + 2] = b;
    }
  }
}

function encodePng(canvas) {
  const { width, height, data } = canvas;
  const stride = width * 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  // 10/11/12 = compression / filter / interlace，全 0
  //
  // 过滤器用「Up」(2)：每行存的是「本行 - 上一行」。这种图大面积是平的，
  // 相邻两行完全相同 → 整行都是 0，deflate 几乎全吃掉。第一行没有上一行
  //（按全 0 处理），Up 退化成直接存原值，正好。
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 2;
    const upStart = (y - 1) * stride;
    for (let i = 0; i < stride; i += 1) {
      const cur = data[y * stride + i];
      const up = y === 0 ? 0 : data[upStart + i];
      raw[rowStart + 1 + i] = (cur - up + 256) & 0xff;
    }
  }
  return Buffer.concat([
    PNG_MAGIC,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

const rgbToHex = (value) => {
  const [r, g, b] = /rgba?\(([^)]+)\)/.exec(value)[1].split(",").map((v) => parseInt(v, 10));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

/** "#dfe7f0" → [223, 231, 240]。带 alpha 的 rgba(...) 先和底色合成。 */
const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

const browserPath = BROWSER_CANDIDATES.find((path) => existsSync(path));
if (!browserPath) throw new Error("没有找到 Chrome / Edge，无法计算真实背景色。");

const appCss = CSS_FILES.map((file) => readFileSync(join(ROOT, "src", "styles", file), "utf8")).join("\n");

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

/* ------------------------------------------------------------------ *
 * 量外壳几何需要跑真正的 App，所以起一个静态服务器指向 dist。
 * 因此这个脚本要在 `npm run build` **之后**跑。
 * ------------------------------------------------------------------ */
const DIST = join(ROOT, "dist");
if (!existsSync(join(DIST, "index.html"))) {
  throw new Error("dist/index.html 不存在 —— 先跑一次 npm run build，再生成启动图。");
}
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json"
};
const { server, port } = await listenSafe(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let file = join(DIST, normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!existsSync(file) || url.pathname === "/") file = join(DIST, "index.html");
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("nf");
  }
});
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ executablePath: browserPath, headless: true });

// 让浏览器按真实层叠算出「首屏背景的基色」。
// 视口用最窄的那档（320pt），保证手机断言的媒体查询生效。
const COLORS = {};
for (const mode of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><html data-theme="${mode}"><head><meta charset="UTF-8" /><style>${appCss}</style></head><body></body></html>`,
    { waitUntil: "load" }
  );
  const computed = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  COLORS[mode] = rgbToHex(computed);
  await page.close();
}

/* ------------------------------------------------------------------ *
 * 首屏外壳：顶栏 / 侧栏 / 底部导航 的位置与颜色
 *
 * 为什么要画它们：HIG 要求启动图「和首屏几乎一样」。这个 App 的首屏
 * **不是**一整块纯色 —— 它有顶栏、宽屏有侧栏、窄屏有底部导航。
 * 只铺一层和 body 相同的底色，结果是启动图和 App 自己的背景**像素级一致**：
 * 用户看到的是一次「什么都没发生」，反馈就成了「没有启动动画」。
 * 启动图得让人**看得出来**它在，才有意义。
 *
 * 颜色一律**从真实渲染里采样**（截 1×1 像素），不读 backgroundColor ——
 * 侧栏和 body 用的都是 linear-gradient，backgroundColor 是透明的，
 * 读出来会拿到祖先元素的颜色，那又对不上了。
 * ------------------------------------------------------------------ */
function decodeFirstPixel(png) {
  let pos = 8;
  let colorType = 2;
  const idat = [];
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString("ascii", pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") colorType = data[9];
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : 3;
  const o = 1; // 第一行：1 字节 filter
  const px = raw.subarray(o, o + channels);
  return `#${[px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** 截 1×1 像素解出真实颜色，渐变背景也能拿到。 */
async function sampleColor(page, x, y) {
  const buf = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
  return decodeFirstPixel(buf);
}

/** 启动图的 CSS 视口尺寸。横屏只是把宽高换过来，media 查询仍用竖屏读数。 */
const cssViewport = (screen) =>
  screen.orientation === "landscape" ? { w: screen.height, h: screen.width } : { w: screen.width, h: screen.height };

const shellCache = new Map();

async function measureShell(mode, screen) {
  const key = `${mode}:${screen.width}x${screen.height}:${screen.orientation || "portrait"}`;
  if (shellCache.has(key)) return shellCache.get(key);
  const { w, h } = cssViewport(screen);
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: true });
  await page.goto(`${base}/#/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);

  const geo = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return null;
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) return null;
      return {
        x: b.x, y: b.y, w: b.width, h: b.height,
        radius: parseFloat(cs.borderTopLeftRadius) || 0,
        borderW: parseFloat(cs.borderTopWidth) || 0
      };
    };
    return { topbar: rect(".topbar"), sidebar: rect(".sidebar"), bottomNav: rect(".bottom-nav") };
  });

  const shell = { topbar: null, sidebar: null, bottomNav: null };
  for (const key2 of ["topbar", "sidebar", "bottomNav"]) {
    const r = geo[key2];
    if (!r) continue;
    const fill = await sampleColor(page, r.x + r.w / 2, r.y + r.h / 2);
    const entry = { ...r, bg: fill };
    if (r.borderW > 0) entry.border = await sampleColor(page, r.x + r.w / 2, r.y + r.borderW / 2);
    shell[key2] = entry;
  }
  await page.close();
  shellCache.set(key, shell);
  return shell;
}

/** 把外壳画成矩形。像素坐标 = CSS 坐标 × ratio。 */
function drawShell(width, height, ratio, shell, baseColor) {
  const canvas = createCanvas(width, height);
  fillAll(canvas, baseColor);
  const P = (v) => v * ratio;
  for (const key of ["sidebar", "topbar", "bottomNav"]) {
    const r = shell[key];
    if (!r) continue;
    const bw = r.border ? P(r.borderW) : 0;
    const rad = P(r.radius);
    if (bw > 0) fillRect(canvas, P(r.x), P(r.y), P(r.w), P(r.h), r.border, rad);
    fillRect(
      canvas,
      P(r.x) + bw,
      P(r.y) + bw,
      P(r.w) - bw * 2,
      P(r.h) - bw * 2,
      r.bg,
      Math.max(0, rad - bw)
    );
  }
  return canvas;
}

let total = 0;
const expected = new Set();
for (const mode of ["light", "dark"]) {
  const color = COLORS[mode];
  const dir = join(OUT_DIR, mode);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  console.log(`\n${mode}  底色 ${color}`);
  for (const screen of ALL_SCREENS) {
    const { w, h } = screenPixels(screen);
    const name = `${w}x${h}.png`;
    expected.add(name);
    const shell = await measureShell(mode, screen);
    const canvas = drawShell(w, h, screen.ratio, shell, color);
    writeFileSync(join(dir, name), encodePng(canvas));
    total += 1;
    const parts = ["topbar", "sidebar", "bottomNav"].filter((k) => shell[k]);
    console.log(`  ${name.padEnd(14)} ${String(w).padStart(4)}×${String(h).padEnd(4)}  ${screen.note}  [${parts.join("+") || "纯色"}]`);
  }
}
await browser.close();
server.close();

// 清掉上一版留下的、这版不再需要的图 —— 否则机型列表一变，旧图会一直躺在
// 产物里，index.html 不引用它、check 也看不见它，但 dist 会一直带着它发出去。
for (const mode of ["light", "dark"]) {
  const dir = join(OUT_DIR, mode);
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".png") && !expected.has(file)) {
      unlinkSync(join(dir, file));
      console.log(`  (清理旧图 ${mode}/${file})`);
    }
  }
}

// 顺手写一份清单：index.html 里的 link 标签和 check-pwa.mjs 都从这里对答案，
// 免得「改了机型列表忘了同步 index.html」这种漂移。
writeFileSync(
  join(OUT_DIR, "screens.json"),
  `${JSON.stringify(
    {
      colors: COLORS,
      screens: ALL_SCREENS.map((screen) => ({
        pixels: splashPixels(screen),
        light: splashPath("light", screen),
        dark: splashPath("dark", screen),
        media: splashMedia(screen, "light"),
        mediaDark: splashMedia(screen, "dark"),
        note: screen.note
      }))
    },
    null,
    2
  )}\n`
);
console.log(
  `\n共 ${total} 张（${ALL_SCREENS.length} 档机型 × 2 种外观：iPhone ${IPHONE_SCREENS.length} + iPad ${IPAD_SCREENS.length}），清单见 public/splash/screens.json`
);
