/**
 * 比对两批截图，逐像素报差异。
 *
 * 为什么需要它：改 CSS 之后「有没有改坏」不能靠读代码判断 ——
 * 删掉一个还在用的类名不会报错，页面只是悄悄变了样。跑一遍截图比对是唯一
 * 能证明「什么都没动」的手段。REDESIGN 里每次动样式都用这一招。
 *
 * 为什么不用 hash 比对：这个项目的截图**不是逐字节稳定的**（页面上有相对时间、
 * 随机 id 之类的东西），直接比 md5 会把无害的抖动当成回归。所以这里逐像素统计
 * 「有多少个像素变了、最大通道差是多少」，用阈值判断。
 *
 * 为什么不用 PIL / sharp：这台机器上都没有，而项目约定是不为校验脚本引入新依赖。
 * 浏览器自带 canvas，把两张图 drawImage 进去读像素即可，零依赖。
 *
 * 用法：
 *   node scripts/diff-shots.mjs .verify/baseline .verify
 *   node scripts/diff-shots.mjs .verify/baseline .verify --threshold=2
 */
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { createRequire } from "node:module";
import { listenSafePort } from "./lib/safe-listen.mjs";

const WORKSPACE = "C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace";
const chromium = createRequire(`${WORKSPACE}/package.json`)("playwright-core").chromium;

const [dirA, dirB] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const threshold = Number((process.argv.find((a) => a.startsWith("--threshold=")) || "").split("=")[1] || 0);

if (!dirA || !dirB) {
  console.error("用法：node scripts/diff-shots.mjs <基准目录> <对比目录> [--threshold=2]");
  process.exit(1);
}

const ROOT = process.cwd();
const MIME = { ".png": "image/png", ".html": "text/html; charset=utf-8" };

const server = createServer(async (req, res) => {
  const rel = decodeURIComponent((req.url || "/").split("?")[0]);

  // 必须有一个和图片**同源**的空白页可以落脚：如果用 about:blank，
  // 页面源是 null，drawImage 之后 canvas 会被判定为 cross-origin，
  // getImageData 直接抛 SecurityError。
  if (rel === "/__blank") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><meta charset=utf-8><title>blank</title>");
    return;
  }

  const file = join(ROOT, rel);
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  res.end(await readFile(file));
});
await listenSafePort(server);
const base = `http://127.0.0.1:${server.address().port}`;

const files = (await readdir(dirA)).filter((f) => f.endsWith(".png")).sort();
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();

let identical = 0;
const changed = [];
const missing = [];

for (const file of files) {
  const bPath = join(dirB, file);
  if (!existsSync(bPath)) {
    missing.push(file);
    continue;
  }
  await page.goto(`${base}/__blank`);
  const result = await page.evaluate(
    async ({ urlA, urlB }) => {
      const load = (src) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error(`加载失败 ${src}`));
          img.src = src;
        });
      const [a, b] = await Promise.all([load(urlA), load(urlB)]);
      if (a.naturalWidth !== b.naturalWidth || a.naturalHeight !== b.naturalHeight) {
        return { sizeMismatch: true, a: [a.naturalWidth, a.naturalHeight], b: [b.naturalWidth, b.naturalHeight] };
      }
      const draw = (img) => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const da = draw(a);
      const db = draw(b);
      let diffPixels = 0;
      let maxDelta = 0;
      let sumDelta = 0;
      for (let i = 0; i < da.length; i += 4) {
        let pixelDelta = 0;
        for (let k = 0; k < 3; k += 1) {
          const d = Math.abs(da[i + k] - db[i + k]);
          if (d > pixelDelta) pixelDelta = d;
        }
        if (pixelDelta > 0) {
          diffPixels += 1;
          sumDelta += pixelDelta;
          if (pixelDelta > maxDelta) maxDelta = pixelDelta;
        }
      }
      return { total: da.length / 4, diffPixels, maxDelta, avgDelta: diffPixels ? sumDelta / diffPixels : 0 };
    },
    { urlA: `${base}/${dirA.replace(/\\/g, "/")}/${file}`, urlB: `${base}/${dirB.replace(/\\/g, "/")}/${file}` }
  );

  if (result.sizeMismatch) {
    changed.push({ file, note: `尺寸不同 ${result.a} vs ${result.b}` });
  } else if (result.diffPixels === 0) {
    identical += 1;
  } else if (result.maxDelta <= threshold) {
    // 在容忍范围内（抗锯齿之类的微差）
    identical += 1;
  } else {
    changed.push({
      file,
      note: `${result.diffPixels}/${result.total} 像素不同 (${((result.diffPixels / result.total) * 100).toFixed(3)}%)，最大通道差 ${result.maxDelta}，平均 ${result.avgDelta.toFixed(1)}`
    });
  }
}

await browser.close();
server.close();

console.log(`比对 ${files.length} 张截图（阈值 maxDelta<=${threshold} 视为相同）`);
console.log(`  完全相同：${identical}`);
if (missing.length) console.log(`  对比目录里缺失：${missing.length} —— ${missing.slice(0, 5).join(", ")}`);
if (changed.length) {
  console.log(`  有差异：${changed.length}`);
  for (const c of changed) console.log(`    ${c.file}\n      ${c.note}`);
} else {
  console.log("  有差异：0 —— 渲染结果一致");
}
process.exit(changed.length ? 1 : 0);
