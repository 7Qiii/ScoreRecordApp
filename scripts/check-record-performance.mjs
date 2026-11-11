import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";

let chromium;
for (const base of [import.meta.url, "C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/package.json"]) {
  try { chromium = createRequire(base)("playwright-core").chromium; break; } catch { /* Try bundled runtime. */ }
}
assert.ok(chromium, "playwright-core is required");
const executablePath = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const server = await createServer({
  configFile: false, plugins: [vue()], server: { host: "127.0.0.1", port: 0 },
  define: { "import.meta.env.VITE_SUPABASE_URL": '""', "import.meta.env.VITE_SUPABASE_ANON_KEY": '""' }
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/#/records');
  await page.waitForSelector('main .page-stack');
  await page.evaluate(async () => {
    const { useTrackerStore } = await import('/src/stores/tracker.js');
    const { db } = await import('/src/services/storage.js');
    window.entryStore = useTrackerStore(document.querySelector('#app').__vue_app__.config.globalProperties.$pinia);
    const rows = Array.from({ length: 3000 }, (_, index) => ({ id: 'perf-' + index, subjectId: 'math1', recordType: 'paper', paperName: '26张八第' + index + '套', score: 90, fullScore: 150, date: '2026-10-30', createdAt: new Date(2026, 0, 1, 0, index).toISOString(), note: '' }));
    await db.transaction("rw", db.records, async () => {
      await db.records.clear();
      await db.records.bulkPut(rows);
    });
    window.entryStore.records = rows;
  });
  await page.waitForTimeout(500);
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const timings = await page.evaluate(async () => {
    const { nextTick } = await import('/node_modules/.vite/deps/vue.js');
    const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const start = performance.now();
    [...document.querySelectorAll('button')].find(el => el.textContent.trim() === '新增成绩').click();
    await nextTick(); await paint();
    const opened = performance.now() - start;
    const name = document.querySelector('.record-form input[list]') || document.querySelector('.record-form input[placeholder*="张八"]');
    const score = document.querySelector('.record-form input[placeholder="本次得分"]');
    const keys = [];
    for (const value of ['2', '27', '27张', '27张八', '27张八1']) {
      const t = performance.now(); name.value = value; name.dispatchEvent(new Event('input', { bubbles: true })); await paint(); keys.push(performance.now()-t);
    }
    for (const value of ['1','12','120']) {
      const t = performance.now(); score.value = value; score.dispatchEvent(new Event('input', { bubbles: true })); await paint(); keys.push(performance.now()-t);
    }
    const save = performance.now();
    document.querySelector('.record-form button[type="submit"]').click();
    while(document.querySelector('.record-form')) await paint();
    return { openMs: Math.round(opened), inputMaxMs: Math.round(Math.max(...keys)), saveMs: Math.round(performance.now()-save) };
  });
  assert.ok(timings.openMs < 750, "Opening the form should not block for 750ms");
  assert.ok(timings.inputMaxMs < 250, "Typing should not block for 250ms");
  assert.ok(timings.saveMs < 1000, "Local saving should finish within 1s");
  console.log("3000 records, 4x CPU throttle: " + JSON.stringify(timings));

  const selection = await page.evaluate(async () => {
    const before = document.querySelectorAll("*").length;
    const start = performance.now();
    [...document.querySelectorAll("button")].find(el => el.textContent.trim() === "全选当前结果").click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      selectMs: Math.round(performance.now() - start),
      addedDom: document.querySelectorAll("*").length - before
    };
  });
  assert.ok(selection.addedDom < 250, "Selecting all should only render the selection preview");
  assert.equal(await page.locator(".selected-record-chip").count(), 8);
  assert.match(await page.locator(".selection-count").innerText(), /3001 条/);
  console.log("Select all, 4x CPU throttle: " + JSON.stringify(selection));

  await page.getByRole("button", { name: "进入合成" }).click();
  const dialog = page.getByRole("dialog", { name: "合成成绩" });
  const sources = dialog.locator(".composite-source-editor");
  const pager = dialog.getByRole("navigation", { name: "合成来源分页" });
  assert.equal(await sources.count(), 8);
  assert.match(await dialog.locator(".composite-total-bar").innerText(), /270120 \/ 450150/);
  await pager.getByRole("button", { name: "下一页" }).click();
  await sources.first().getByLabel("计入得分").fill("-1");
  await pager.getByRole("button", { name: "上一页" }).click();
  await dialog.getByRole("button", { name: "生成合成成绩" }).click();
  await pager.getByText("第 2 / 376 页").waitFor();
  assert.equal(await sources.first().getByLabel("计入得分").inputValue(), "-1");
  assert.equal(await page.evaluate(() => window.entryStore.records.length), 3001);
  console.log("Composite editor pages retain drafts and validate inputs across pages");

  await dialog.getByRole("button", { name: "继续选择" }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByLabel("目标科目").selectOption("cs408");
  const moveStarted = Date.now();
  await page.getByRole("button", { name: "批量改科目" }).click();
  await page.getByText("已批量调整 3001 条成绩的科目。", { exact: true }).waitFor();
  const moveMs = Date.now() - moveStarted;
  assert.equal(await page.evaluate(async () => {
    const { db } = await import("/src/services/storage.js");
    return (await db.records.where("subjectId").equals("cs408").count());
  }), 3001);

  const rolledBack = await page.evaluate(async () => {
    const { db } = await import("/src/services/storage.js");
    const bulkDelete = db.records.bulkDelete;
    db.records.bulkDelete = async function (ids) {
      await bulkDelete.call(this, ids);
      throw new Error("Abort the transaction");
    };
    try {
      await window.entryStore.removeRecords(["perf-0"]);
      return false;
    } catch {
      return Boolean(await db.records.get("perf-0")) && !(await db.deletedRecords.get("perf-0"));
    } finally {
      db.records.bulkDelete = bulkDelete;
    }
  });
  assert.equal(rolledBack, true, "A failed bulk delete rolls back the trash write too");

  await page.getByRole("button", { name: "批量删除" }).click();
  const deleteStarted = Date.now();
  await page.getByRole("button", { name: "删除 3001 条", exact: true }).click();
  await page.getByText("3001 条成绩已移入最近删除。", { exact: true }).waitFor();
  const deleteMs = Date.now() - deleteStarted;
  const recycleBin = page.locator(".record-restore-panel");
  assert.equal(await recycleBin.locator("article").count(), 8);
  await recycleBin.getByRole("button", { name: "下一页" }).click();
  await recycleBin.getByText("第 2 / 376 页").waitFor();
  await recycleBin.getByRole("button", { name: "恢复" }).first().click();
  await page.getByText("成绩已恢复。", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(async () => {
    const { db } = await import("/src/services/storage.js");
    return [await db.records.count(), await db.deletedRecords.count()];
  }), [1, 3000]);
  console.log("3001 persisted records, 4x CPU throttle: " + JSON.stringify({ moveMs, deleteMs }));

  const importCounts = await page.evaluate(async () => {
    const { db } = await import("/src/services/storage.js");
    const entries = await db.deletedRecords.limit(2).toArray();
    await window.entryStore.importData({ records: [entries[0].record] }, true, { restoreDeleted: true });
    const merged = [await db.records.count(), await db.deletedRecords.count()];
    // 覆盖恢复要求完整备份，并清掉不属于新档案的可恢复快照。
    await window.entryStore.importData({ subjects: [], records: [entries[1].record], mistakes: [], images: [] }, false, { restoreDeleted: true });
    return [merged, [await db.records.count(), await db.deletedRecords.count()]];
  });
  assert.deepEqual(importCounts, [[2, 2999], [1, 0]], "Backup recovery restores selected records and clears superseded snapshots");
} finally { await browser?.close(); await server.close(); }
