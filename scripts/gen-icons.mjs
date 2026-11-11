/**
 * 从 public/icon.svg 生成各平台需要的主屏幕图标 PNG。
 *
 * 为什么必须生成 PNG（而不是只放那个 SVG）：
 *   - iOS 不支持 SVG 作为主屏幕图标。只提供 SVG 的话，iPad 上
 *     「添加到主屏幕」会得到一个空白图标（退化成网页截图）。
 *   - Android / 鸿蒙 的 maskable 图标要求内容落在安全区内，
 *     用一张全出血底色图最稳。
 *
 * 为什么用浏览器画布而不是 sharp / PIL：
 *   本机没有这两个库，而 Chromium 本来就在（playwright-core），
 *   光栅化 SVG 恰好是它擅长的事，省一个新依赖。
 *   用 Blob URL 而不是 data: URL —— blob 是同源的，画布不会被污染。
 *
 * 用法：node scripts/gen-icons.mjs
 * 产物：public/apple-touch-icon.png、icon-192.png、icon-512.png、
 *       icon-maskable-512.png
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";

const WORKSPACE = "C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace";
const chromium = createRequire(`${WORKSPACE}/package.json`)("playwright-core").chromium;

const ROOT = process.cwd();
const SRC = join(ROOT, "public/icon.svg");
const OUT_DIR = join(ROOT, "public");

const raw = await readFile(SRC, "utf8");

/**
 * 全出血版本：把圆角改成直角。
 * 透明圆角在 iOS 上会被填成黑色，看起来像图坏了 ——
 * 交给系统自己去裁形状才是对的。
 *
 * 注意是**全部**替换（/g）：底色、渐变叠加、高光各有一层 rect，只换第一层的话
 * 剩下的还带着圆角，全出血时四角就会露出没铺满的边。
 */
const fullBleed = raw.replace(/rx="96"/g, 'rx="0"');

/** 补上明确宽高，光栅化时尺寸才可控（viewBox 本身不提供内在尺寸） */
const sized = (svg, px) => svg.replace("<svg ", `<svg width="${px}" height="${px}" `);

const TARGETS = [
  // iOS 主屏幕：180×180，必须全出血
  { file: "apple-touch-icon.png", size: 180, svg: sized(fullBleed, 180) },
  // Android / 鸿蒙 PWA 常规图标（保留原本的圆角设计）
  { file: "icon-192.png", size: 192, svg: sized(raw, 192) },
  { file: "icon-512.png", size: 512, svg: sized(raw, 512) },
  // maskable：内容已在安全区内，用全出血底色，系统裁成圆形/圆角都不会切到字
  { file: "icon-maskable-512.png", size: 512, svg: sized(fullBleed, 512) }
];

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();

const results = await page.evaluate(async (targets) => {
  const out = [];
  for (const t of targets) {
    const url = URL.createObjectURL(new Blob([t.svg], { type: "image/svg+xml" }));
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error(`SVG 加载失败：${t.file}`));
      i.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = t.size;
    canvas.height = t.size;
    const ctx = canvas.getContext("2d");
    // 先用底色铺满，再画图 —— 万一 SVG 有透明区域也不会露出透明通道。
    // 这个值要和 icon.svg 里那个 hex 基底一致（check-pwa 读的也是那一层）。
    ctx.fillStyle = "#E6ECFF";
    ctx.fillRect(0, 0, t.size, t.size);
    ctx.drawImage(img, 0, 0, t.size, t.size);
    URL.revokeObjectURL(url);
    out.push({ file: t.file, size: t.size, data: canvas.toDataURL("image/png").split(",")[1] });
  }
  return out;
}, TARGETS);

await browser.close();

for (const item of results) {
  const buffer = Buffer.from(item.data, "base64");
  await writeFile(join(OUT_DIR, item.file), buffer);
  console.log(`${item.file.padEnd(26)} ${item.size}×${item.size}  ${(buffer.length / 1024).toFixed(1)} kB`);
}

console.log(`\n共生成 ${results.length} 个图标 → public/`);
