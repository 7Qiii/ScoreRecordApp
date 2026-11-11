/**
 * 导出结果的端到端检查 —— 真的把文件导出来，再拆开看里面写了什么。
 *
 * 为什么需要它：audit-buttons.mjs 只能确认「点了导出按钮有反应」，
 * check-dialogs.mjs 只能确认「面板能开能关」。两者都看不出导出的表
 * 到底长什么样。导出面板从 RecordsPage.vue 抽成组件之后，最容易出错的
 * 恰恰是「喂给 Excel 的是哪批成绩」这一层 —— 抽错了，按钮照样有反应，
 * 预览照样好看，但文件里的内容是错的。所以这里直接解析 xlsx 断言。
 *
 * 验证默认按年份分开、简称合并，以及可选的跨年模式：
 *   1. 不同年份的真题并成一列（09/11/12 真题 → 一列「真题」）
 *   2. 「每列包含哪些成绩」真的能把某一条从文件里去掉
 *
 * 用法：node scripts/check-export.mjs
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createRequire } from "node:module";
import { listenSafePort } from "./lib/safe-listen.mjs";

// playwright-core 装在托管工作区里（不污染项目依赖），ESM 不认 NODE_PATH
const WORKSPACE = "C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace";
const chromium = createRequire(`${WORKSPACE}/package.json`)("playwright-core").chromium;
// exceljs 是项目自己的依赖，直接拿来解析导出的文件
const ExcelJS = createRequire(join(process.cwd(), "package.json"))("exceljs");

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
 * 导出用的数据集：1 组「真题」（3 个年份要并成一列）+ 4 组各自独立的卷子。
 *
 * 为什么自己带全 5 组：以前这里只塞 3 条英语真题，另外 4 组靠「演示数据」
 * 凑 —— 老版本 seedIfEmpty() 无条件往空库灌 4 条成绩。修掉那个 bug 之后
 * （云端模式下不再灌），这个脚本就只剩 1 组了，列数断言跟着失败。
 * 依赖演示数据本身就是错的：那是产品功能，不是测试夹具。
 *
 * 期望结果：序号列 + 5 组 × 2 字段 = 11 列。
 */
const SEED = [
  ...["26张八1", "2026张宇8套卷第2套", "27张八1"].map((paperName, index) => ({ id: `edition-${index}`, subjectId: "math1", recordType: "paper", paperName, score: 100 + index, fullScore: 150, date: "2026-10-30", createdAt: "2026-10-30T10:00:00.000Z" })),
  { id: "e2e-en-09", subjectId: "english1", recordType: "paper", paperName: "09真题", score: 61, fullScore: 100, durationMinutes: 70, date: "2025-03-01", createdAt: "2025-03-01T10:00:00.000Z", note: "" },
  { id: "e2e-en-11", subjectId: "english1", recordType: "paper", paperName: "11真题", score: 66, fullScore: 100, durationMinutes: 72, date: "2025-04-01", createdAt: "2025-04-01T10:00:00.000Z", note: "" },
  { id: "e2e-en-12", subjectId: "english1", recordType: "paper", paperName: "12真题", score: 71, fullScore: 100, durationMinutes: 74, date: "2025-05-01", createdAt: "2025-05-01T10:00:00.000Z", note: "" },
  { id: "e2e-408-1", subjectId: "cs408", recordType: "paper", paperName: "408 综合模拟 01", score: 86, fullScore: 150, durationMinutes: 180, date: "2025-06-01", createdAt: "2025-06-01T10:00:00.000Z", note: "" },
  { id: "e2e-math-1", subjectId: "math1", recordType: "paper", paperName: "数一 模拟 01", score: 92, fullScore: 150, durationMinutes: 170, date: "2025-06-08", createdAt: "2025-06-08T10:00:00.000Z", note: "" },
  { id: "e2e-en-read", subjectId: "english1", recordType: "paper", paperName: "英一 阅读专项", score: 68, fullScore: 100, durationMinutes: 70, date: "2025-06-15", createdAt: "2025-06-15T10:00:00.000Z", note: "" },
  { id: "e2e-pol-1", subjectId: "politics", recordType: "paper", paperName: "政治 选择题套卷", score: 63, fullScore: 100, durationMinutes: 60, date: "2025-06-22", createdAt: "2025-06-22T10:00:00.000Z", note: "" }
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
 * 导出的表拆成「第 1 行的分组标题」和「整张表里出现过的所有文字」。
 *
 * 注意：分组标题那一行是横向合并单元格（一套卷子跨 N 列）。ExcelJS 读回来
 * 时会把主单元格的值复制到合并区里的每一个格子上，所以「真题」会连着出现
 * span 次。相邻分组本身一定是不同的（分组 key 唯一），因此把连续重复的
 * 标题折叠掉，就是真正的分组列表。
 */
async function readWorkbook(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.worksheets[0];
  const rawLabels = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell) => {
    const text = String(cell.value ?? "").trim();
    if (text) rawLabels.push(text);
  });
  const labels = rawLabels.filter((label, index) => label !== rawLabels[index - 1]);
  const allText = [];
  sheet.eachRow((row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const text = String(cell.value ?? "").trim();
      if (text) allText.push(text);
    });
  });
  return {
    sheetName: sheet.name,
    labels,
    allText,
    merges: sheet.model.merges?.length ?? 0,
    columnCount: sheet.columnCount,
    rowCount: sheet.rowCount
  };
}

const problems = [];

async function main() {
  if (!existsSync(DIST)) throw new Error("dist/ 不存在，先跑一次 npm run build。");

  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  const page = await browser.newPage({ acceptDownloads: true });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 160));
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error.message).slice(0, 160)));

  try {
    await page.goto(`${base}/#/records`, { waitUntil: "load" });
    await page.waitForTimeout(2200);

    // 等应用建好库再塞数据，然后重载让 store 读到
    await seedRecords(page, SEED);
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(2200);

    // 打开导出面板，切到「按卷子分列」
    await page.locator('button:has-text("导出 Excel")').first().click({ timeout: 8000 });
    await page.waitForTimeout(700);
    await page.locator('.export-dialog button:has-text("按卷子分列")').first().click({ timeout: 8000 });
    await page.waitForTimeout(800);

    // Default mode must preserve editions in both the preview and downloaded file.
    const edition26 = page.locator(".matrix-picker-group").filter({ hasText: "2026 张宇八套卷" });
    const edition27 = page.locator(".matrix-picker-group").filter({ hasText: "2027 张宇八套卷" });
    if (await edition26.locator(".matrix-picker-chip").count() !== 2) problems.push("2026 aliases did not converge");
    if (await edition27.locator(".matrix-picker-chip").count() !== 1) problems.push("2027 edition was not separated");
    const downloadDefault = page.waitForEvent("download");
    await page.locator('.export-dialog-footer .primary-button').click();
    const defaultResult = await readWorkbook(await (await downloadDefault).path());
    for (const label of ["2026 张宇八套卷", "2027 张宇八套卷", "2009 真题", "2011 真题", "2012 真题"]) {
      if (!defaultResult.labels.includes(label)) problems.push("Missing edition header: " + label);
    }
    console.log("  Default export preserves edition years and merges aliases");
    await page.locator('button:has-text("导出 Excel")').first().click();
    await page.getByRole("button", { name: /跨年份合并/ }).click();

    // 1. 选择器里「真题」应该是一个分组，里面 3 条
    const group = page.locator(".matrix-picker-group").filter({ hasText: "真题" });
    const groupCount = await group.count();
    if (groupCount !== 1) {
      problems.push(`选择器里「真题」分组应有 1 个，实际 ${groupCount} 个`);
    } else {
      const chips = await group.locator(".matrix-picker-chip").count();
      console.log(`  选择器：「真题」一列，含 ${chips} 条成绩`);
      if (chips !== 3) problems.push(`「真题」这一列应有 3 条，实际 ${chips} 条`);
      const chipTexts = await group.locator(".matrix-picker-chip").allInnerTexts();
      console.log(`  列内成绩：${chipTexts.map((t) => t.trim()).join(" / ")}`);
    }

    // 2. 去掉 12真题 这一条
    await page.locator(".matrix-picker-chip").filter({ hasText: "12真题" }).first().click({ timeout: 8000 });
    await page.waitForTimeout(500);

    // 3. 真的导出，把文件抓下来
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 20000 }),
      page.locator('.export-dialog button:has-text("导出 Excel")').first().click({ timeout: 8000 })
    ]);
    const file = await download.path();
    const result = await readWorkbook(file);

    console.log(`\n  导出文件：${result.sheetName}  ${result.columnCount} 列 × ${result.rowCount} 行，${result.merges} 处合并`);
    console.log(`  第 1 行分组标题：${result.labels.join(" | ")}`);

    // 4. 断言
    const trueQuestionLabels = result.labels.filter((label) => label === "真题");
    if (trueQuestionLabels.length !== 1) {
      problems.push(`第 1 行应有 1 个「真题」分组标题，实际 ${trueQuestionLabels.length} 个（${result.labels.join(" | ")}）`);
    }
    const yearLabels = result.labels.filter((label) => /0?9真题|11真题|12真题/.test(label));
    if (yearLabels.length) {
      problems.push(`年份真题不该单独占列，却出现了：${yearLabels.join(" / ")}`);
    }
    // 序号列 + 5 套卷子 × 每套 2 个字段（记录 / 分数）
    if (result.columnCount !== 13) {
      problems.push(`应为 1 + 6 套 × 2 字段 = 13 列，实际 ${result.columnCount} 列（分组：${result.labels.join(" | ")}）`);
    }

    if (!result.allText.includes("09真题")) problems.push("文件里找不到 09真题 —— 被排除的那条之外的成绩不该丢");
    if (!result.allText.includes("11真题")) problems.push("文件里找不到 11真题");
    if (result.allText.includes("12真题")) problems.push("12真题 已经被排除，却还是写进了文件");

    if (!result.allText.includes("408 综合模拟 01")) {
      problems.push("408 综合模拟 01 丢了 —— 说明喂给导出的记录集不对");
    }
    if (!result.allText.includes("数一 模拟 01")) problems.push("数一 模拟 01 丢了");
    if (!result.allText.includes("政治 选择题套卷")) problems.push("政治 选择题套卷 丢了");

    if (consoleErrors.length) problems.push(`控制台报错：${consoleErrors[0]}`);
  } catch (error) {
    problems.push(`执行出错：${error.message}`);
    if (consoleErrors.length) problems.push(`控制台：${consoleErrors.join("; ")}`);
  } finally {
    await page.close();
    await browser.close();
    server.close();
  }

  if (problems.length) {
    console.log("\n✗ 导出检查未通过：");
    problems.forEach((problem) => console.log(`    · ${problem}`));
    process.exit(1);
  }
  console.log("\n✓ 导出检查通过 —— 默认按年份分开，跨年合并可选，被排除的成绩没有写进文件。");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
