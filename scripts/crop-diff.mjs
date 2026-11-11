/**
 * 截图差异的「放大镜」。
 *
 * diff-shots.mjs 告诉你「哪几张图不一样、差多少像素」；
 * 本脚本告诉你「差的那几像素到底长什么样」。
 * 两个配合使用：先用 diff-shots 定位，再用 crop-diff 看一眼，
 * 就能区分「内容变了」和「样式被改坏了」——这是改 CSS 时唯一靠谱的判据。
 *
 * 用法：
 *   node scripts/crop-diff.mjs <文件名> <目录A> <目录B>
 *   node scripts/crop-diff.mjs 1440x900_mistakes.png .verify/baseline .verify
 *
 * 输出：.verify/crop-before.png 和 .verify/crop-after.png，
 *       两张图都裁到「差异的包围盒」并留 12px 边距，直接肉眼看即可。
 *
 * 为什么用浏览器画布而不是 sharp/PIL：本机没有这些库，
 * 而 Chromium 本来就在（playwright-core），省一个依赖。
 * 注意画布跨域会被污染，所以必须从同源的 /__blank 空白页发起，
 * 不能用 about:blank（它的 origin 是 null）。
 */
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { createRequire } from "node:module";
import { listenSafePort } from "./lib/safe-listen.mjs";

const WORKSPACE = "C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace";
const chromium = createRequire(`${WORKSPACE}/package.json`)("playwright-core").chromium;

const [file, a, b] = process.argv.slice(2);
if (!file || !a || !b) {
  console.error("用法: node scripts/crop-diff.mjs <文件名> <目录A> <目录B>");
  process.exit(1);
}

const ROOT = process.cwd();
const MIME = { ".png": "image/png", ".html": "text/html; charset=utf-8" };

const server = createServer(async (req, res) => {
  const rel = decodeURIComponent((req.url || "/").split("?")[0]);
  if (rel === "/__blank") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><meta charset=utf-8>");
    return;
  }
  const f = join(ROOT, rel);
  if (!existsSync(f)) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
  res.end(await readFile(f));
});
await listenSafePort(server);
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
await page.goto(`${base}/__blank`);

const out = await page.evaluate(async ({ urlA, urlB }) => {
  const load = (src) => new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
  const [ia, ib] = await Promise.all([load(urlA), load(urlB)]);
  const draw = (img) => {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { data: g.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
  };
  const A = draw(ia);
  const B = draw(ib);
  if (A.w !== B.w || A.h !== B.h) return { mismatch: `${A.w}x${A.h} vs ${B.w}x${B.h}` };

  // 阈值 2：抗锯齿造成的 ±1 抖动不算差异，否则包围盒会被噪声撑满整页
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  for (let y = 0; y < A.h; y += 1) {
    for (let x = 0; x < A.w; x += 1) {
      const i = (y * A.w + x) * 4;
      if (
        Math.abs(A.data[i] - B.data[i]) > 2 ||
        Math.abs(A.data[i + 1] - B.data[i + 1]) > 2 ||
        Math.abs(A.data[i + 2] - B.data[i + 2]) > 2
      ) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { none: true };

  const pad = 12;
  const x0 = Math.max(0, minX - pad);
  const y0 = Math.max(0, minY - pad);
  const w = Math.min(A.w - x0, maxX - minX + pad * 2);
  const h = Math.min(A.h - y0, maxY - minY + pad * 2);
  const crop = (img) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(img, x0, y0, w, h, 0, 0, w, h);
    return c.toDataURL("image/png");
  };
  return { box: { x0, y0, w, h }, before: crop(ia), after: crop(ib) };
}, { urlA: `${base}/${a}/${file}`, urlB: `${base}/${b}/${file}` });

if (out.none) {
  console.log(`${file}: 没有差异`);
} else if (out.mismatch) {
  console.error(`${file}: 尺寸不一致（${out.mismatch}），无法比对`);
  process.exitCode = 1;
} else {
  console.log(`${file}: 差异包围盒 ${JSON.stringify(out.box)}`);
  await writeFile(".verify/crop-before.png", Buffer.from(out.before.split(",")[1], "base64"));
  await writeFile(".verify/crop-after.png", Buffer.from(out.after.split(",")[1], "base64"));
  console.log("已写出 .verify/crop-before.png / .verify/crop-after.png");
}

await browser.close();
server.close();
