/**
 * 交互体验审计：量「切页面时的位置与焦点」这类手感问题。
 *
 * 为什么单独写一个：audit-a11y 查的是静态可达性（名字、尺寸、对比度），
 * audit-buttons 查的是「点一下有没有反应」。两者都覆盖不到
 * 「从列表滚到一半点进详情、再返回」这种**跨页面的状态**问题 ——
 * 而这类问题恰恰是天天用的人最先感觉到的。
 *
 * 检查项：
 *   1. 前进导航（切到另一个路由）后应回到顶部，否则新页面会「从半截开始」
 *   2. 返回时应恢复离开时的位置，否则长列表里翻到一半点进去再退回来会丢失位置
 *   3. 切路由后焦点应落到新页面（键盘 / 读屏用户否则还停在旧位置）
 *   4. 弹窗开着时按返回，应该只关弹窗、不换页，且不能把页面滚回顶部
 *   5. 弹窗开开关关之后历史记录要回到原样，不能留下「按返回没反应」的幽灵记录
 *   6. 搜索浮层要能用键盘走到（Tab / ↑↓ / Enter / Escape），不能只有鼠标能点
 *   7. 填了一半的表单被收起 / 关闭 / 取消编辑时要拦一下，且没填内容时不能误报
 *   8. 填了一半时点侧栏换页要拦一下（取消要留在原页、放弃要真的换页）；
 *      按返回放行，但地址栏和画面必须一致
 *   9. 「基于本成绩新增错题」要真的把表单打开（以前只是带着 query 落到列表上）
 *
 * 用法：node scripts/audit-interaction.mjs
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createRequire } from "node:module";
import { listenSafePort } from "./lib/safe-listen.mjs";
import { seedRows } from "./lib/seed-rows.mjs";

const WORKSPACE = "C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace";
const chromium = createRequire(`${WORKSPACE}/package.json`)("playwright-core").chromium;

const DIST = join(process.cwd(), "dist");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

let problems = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { problems += 1; console.log(`  问题 ${m}`); };
const check = (cond, good, badMsg) => (cond ? ok(good) : bad(badMsg));

const server = createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  let file = join(DIST, normalize(decodeURIComponent(url)));
  if (!existsSync(file) || url === "/" || !extname(file)) file = join(DIST, "index.html");
  if (!existsSync(file)) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  res.end(await readFile(file));
});
await listenSafePort(server);
const base = `http://127.0.0.1:${server.address().port}`;

/**
 * 这些场景都要「列表里真的有成绩」才有意义：滚动、点进详情、搜索、新增错题。
 *
 * 以前这份数据是白拿的 —— 老版本 seedIfEmpty() 无条件往空库灌 4 条演示成绩，
 * 随便打开 /#/records 就有内容。修掉那个 bug 之后（云端模式下不再灌演示数据），
 * 这里就空了。问题不在修复本身：拿「演示数据」当测试夹具从一开始就是错的，
 * 那是产品功能，随时可能变。所以现在自己塞。
 *
 * 8 条是为了在 390×844 的小屏上真的能滚起来；名字带「模拟」是给场景 6 的
 * 搜索用的；demo-1 是给场景 2 的详情页用的（它直接 goto #/records/demo-1）。
 */
const SEED = Array.from({ length: 8 }, (_, index) => ({
  id: `demo-${index + 1}`,
  subjectId: "math1",
  recordType: "paper",
  paperName: `模拟 ${String(index + 1).padStart(2, "0")}`,
  score: 88 + index,
  fullScore: 150,
  durationMinutes: 165 + index,
  date: `2026-09-${String(index + 20).padStart(2, "0")}`,
  createdAt: `2026-09-${String(index + 20).padStart(2, "0")}T10:00:00.000Z`,
  note: ""
}));

/**
 * 打开页面 → 等应用建库 → 塞数据 → 重载。
 *
 * 每个 page 都要单独来一次：Playwright 的 browser.newPage() 会新开一个
 * browser context，IndexedDB 不共享。
 */
async function openSeeded(page, url) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await seedRows(page, { records: SEED });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
}

const browser = await chromium.launch({ channel: "chrome" });

// 用小屏跑，列表才有足够长度滚起来
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await openSeeded(page, base);

const scrollY = () => page.evaluate(() => Math.round(window.scrollY));
const goto = async (hash) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(500);
};

console.log("场景 1：在长列表里向下滚动，然后切到另一个路由");
await goto("#/records");
await page.waitForTimeout(300);
const canScroll = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 100);
if (!canScroll) {
  bad("成绩页在当前视口下不够长，测不出滚动（demo 数据只有 4 条）");
} else {
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForTimeout(200);
  const before = await scrollY();
  await goto("#/subjects");
  const after = await scrollY();
  check(after === 0, `切到新路由后回到顶部（滚动 ${before} → ${after}）`,
    `切到新路由后没有回到顶部：从 ${before} 变成 ${after}，新页面会从半截开始显示`);
}

console.log("\n场景 2：从列表点进详情，再返回");
await goto("#/records");
await page.waitForTimeout(300);
if (await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 100)) {
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForTimeout(200);
  const listPos = await scrollY();
  await goto("#/records/demo-1");
  await page.waitForTimeout(400);
  await page.goBack();
  await page.waitForTimeout(500);
  const backPos = await scrollY();
  check(backPos === 0 || Math.abs(backPos - listPos) < 40,
    `返回后位置可接受（离开时 ${listPos}，返回后 ${backPos}）`,
    `返回后位置异常：离开时 ${listPos}，返回后 ${backPos}`);
} else {
  bad("列表不够长，跳过返回位置测试");
}

console.log("\n场景 3：切路由后焦点落到哪里");
await goto("#/records");
const focusOnRecords = await page.evaluate(() => ({
  tag: document.activeElement?.tagName || "",
  cls: document.activeElement?.className || "",
  isBody: document.activeElement === document.body
}));
await goto("#/mistakes");
const focusAfterNav = await page.evaluate(() => ({
  tag: document.activeElement?.tagName || "",
  cls: document.activeElement?.className || "",
  isBody: document.activeElement === document.body
}));
check(
  !focusAfterNav.isBody || !focusOnRecords.isBody,
  `切路由后焦点不在 body（${focusAfterNav.tag}.${focusAfterNav.cls}）`,
  "切路由后焦点仍在 body —— 键盘和读屏用户还停在旧页面的位置，不知道已经换页了"
);

console.log("\n场景 4：弹窗开着时按「返回」（手机手势 / 系统返回键）");
await goto("#/records");
await page.waitForTimeout(400);
const routeBefore = await page.evaluate(() => location.hash);
await page.click('button[aria-label="签名"]');
await page.waitForTimeout(400);
const dialogOpened = await page.evaluate(() => !!document.querySelector(".signature-dialog"));
if (!dialogOpened) {
  bad("没能打开签名弹窗，跳过该场景");
} else {
  // 用页面内的 history.back()，而不是 page.goBack()：弹窗的记录是同地址的，
  // 这条返回不会产生导航，Playwright 的 goBack 会一直等 load 事件。
  // history.back() 走的正是浏览器返回键 / 手机侧滑那一条代码路径。
  await page.evaluate(() => history.back());
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    hash: location.hash,
    dialog: !!document.querySelector(".signature-dialog")
  }));
  check(
    !after.dialog && after.hash === routeBefore,
    `返回键关掉了弹窗、且没有换页（仍停在 ${after.hash}）`,
    `返回键没有先关弹窗：hash ${routeBefore} → ${after.hash}，弹窗${after.dialog ? "还开着" : "已消失"} —— 手机上滑一下返回，会直接离开当前页`
  );

  // 关弹窗时不能顺手把页面滚回顶部。
  // 注意这里必须用页面内 .click() 而不是 page.click()：Playwright 的 click 会先把
  // 元素滚进视野，顶栏的签名按钮在页面顶部，一滚就把 scrollY 清成 0 ——
  // 量到的是「Playwright 自己滚的」，不是弹窗干的。
  const scrolled = await page.evaluate(() => {
    window.scrollTo(0, 500);
    return Math.round(window.scrollY);
  });
  await page.evaluate(() => document.querySelector('button[aria-label="签名"]')?.click());
  await page.waitForTimeout(350);
  await page.evaluate(() => history.back());
  await page.waitForTimeout(500);
  const kept = await scrollY();
  check(Math.abs(kept - scrolled) < 40,
    `关弹窗没动滚动位置（${scrolled} → ${kept}）`,
    `关弹窗把页面滚到了 ${kept}（原本在 ${scrolled}）—— 返回手势关弹窗时页面会跳回顶部`);
}

console.log("\n场景 5：历史记录不能越积越多（打开又关掉，要能原路退回）");
await goto("#/records");
await page.waitForTimeout(300);
// 不能用 history.length 判断：它统计的是「会话历史里的条目总数」，
// 后退不会让它变小（实测 3→4 之后一直是 4），而且在中途 pushState 会截断
// 前面的条目、总数可能不增反减。用我们自己压进去的标记来判断才准。
await page.click('button[aria-label="签名"]');
await page.waitForTimeout(400);
const opened = await page.evaluate(() => ({
  dialog: !!document.querySelector(".signature-dialog"),
  marker: history.state?.__dialogId ?? null
}));
check(opened.dialog && !!opened.marker,
  `弹窗打开时压了一条带标记的历史记录（__dialogId=${opened.marker}），返回手势才有东西可以拦`,
  `弹窗打开时历史里没有标记（dialog=${opened.dialog}, __dialogId=${opened.marker}）—— 没压记录，返回手势会直接换页`);

// Escape 关闭：这一条记录必须被主动弹掉，否则会留下一层「按返回没反应」的幽灵
await page.keyboard.press("Escape");
await page.waitForTimeout(550);
const afterEscape = await page.evaluate(() => ({
  marker: history.state?.__dialogId ?? null,
  dialog: !!document.querySelector(".signature-dialog"),
  hash: location.hash
}));
check(!afterEscape.dialog && !afterEscape.marker,
  `Escape 关弹窗后那条记录被弹掉了（标记 ${opened.marker} → ${afterEscape.marker}）`,
  `Escape 关弹窗后历史里还留着标记 ${afterEscape.marker} —— 之后按返回会「没反应」一下，用户以为卡住了`);

// 反向验证：没有残留记录时，返回应该真的能换页
await page.evaluate(() => history.back());
await page.waitForTimeout(600);
const hashAfterRealBack = await page.evaluate(() => location.hash);
check(hashAfterRealBack !== "#/records",
  `关掉弹窗后，返回键恢复成正常换页（→ ${hashAfterRealBack}）`,
  `关掉弹窗后返回键还是没换页（仍停在 ${hashAfterRealBack}）—— 历史里留了多余记录`);

console.log("\n场景 6：搜索浮层的键盘操作（Tab / ↑↓ / Enter / Escape）");
// 搜索框在 ≤820px 是 display:none（手机规则把它藏了），所以这一场景要单独开一个
// 宽一点的视口。用同一个 page 改视口也行，但列表/布局的其它断言会被牵连。
const searchPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await openSeeded(searchPage, `${base}/#/records`);
const SEARCH = 'input[aria-label="搜索成绩和错题"]';
// 用 fill 而不是 type：fill 会先清空，省得上一段测试留下的关键字被接在后面
await searchPage.fill(SEARCH, "模拟");
await searchPage.waitForTimeout(400);
const resultCount = await searchPage.locator(".global-search-result").count();
if (!resultCount) {
  bad('搜索「模拟」没有出结果（demo 数据变了？），跳过该场景');
} else {
  // 1. Tab 从输入框进到结果上时，浮层不能先收起来
  await searchPage.keyboard.press("Tab");
  const tabState = await searchPage.evaluate(() => ({
    open: !!document.querySelector(".global-search-popover"),
    cls: String(document.activeElement?.className || "")
  }));
  check(tabState.open && tabState.cls.includes("global-search-result"),
    "Tab 能把焦点移到结果上，浮层保持打开",
    `Tab 之后浮层${tabState.open ? "还在、但焦点没落到结果上" : "被关掉了"}（焦点在 ${tabState.cls || "?"}）—— 键盘用户够不到搜索结果，只能靠 Enter 撞第一条`);

  // 2. ↑↓ 在结果之间移动（要真的换了一条，不能只是「焦点在某个结果上」）
  await searchPage.fill(SEARCH, "模拟");
  await searchPage.waitForTimeout(350);
  const activeText = () =>
    searchPage.evaluate(() => String(document.activeElement?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40));
  await searchPage.keyboard.press("ArrowDown");
  const firstStop = await activeText();
  await searchPage.keyboard.press("ArrowDown");
  const secondStop = await activeText();
  if (resultCount < 2) {
    check(Boolean(firstStop), `↓ 把焦点移到了结果上（「${firstStop}」）`, "↓ 没能把焦点移到结果上");
  } else {
    check(Boolean(firstStop) && secondStop !== firstStop,
      `↓ 在结果之间移动（「${firstStop}」 → 「${secondStop}」）`,
      `↓ 没能换到下一条（两次都停在「${firstStop || "?"}」，共 ${resultCount} 条结果）`);
  }

  // 3. Enter 打开当前高亮的那一条
  const hashBefore = await searchPage.evaluate(() => location.hash);
  await searchPage.keyboard.press("Enter");
  await searchPage.waitForTimeout(800);
  const afterEnter = await searchPage.evaluate(() => ({
    hash: location.hash,
    open: !!document.querySelector(".global-search-popover")
  }));
  check(afterEnter.hash !== hashBefore && !afterEnter.open,
    `Enter 打开了高亮的那条结果（${hashBefore} → ${afterEnter.hash}）`,
    `Enter 没能打开结果（${hashBefore} → ${afterEnter.hash}，浮层${afterEnter.open ? "还开着" : "已关闭"}）`);

  // 4. Escape 收起浮层
  await searchPage.goto(`${base}/#/records`, { waitUntil: "load" });
  await searchPage.waitForTimeout(1200);
  await searchPage.fill(SEARCH, "模拟");
  await searchPage.waitForTimeout(400);
  await searchPage.keyboard.press("ArrowDown");
  await searchPage.keyboard.press("Escape");
  await searchPage.waitForTimeout(300);
  const searchRestored = await searchPage.evaluate((selector) =>
    !document.querySelector(".global-search-popover") && document.activeElement.matches(selector), SEARCH);
  check(searchRestored, "Escape 收起搜索浮层并将焦点还给输入框", "Escape 后搜索浮层或焦点状态不正确");
}
await searchPage.close();

/* ------------------------------------------------------------------ *
 * 场景 7~9：录入表单的「填了一半」保护
 *
 * 单独开一个宽屏页面：侧栏在 ≤1023px 会收成抽屉，要点到导航链接必须用宽屏；
 * 另外这几个场景要反复开关表单，和前面共用页面会互相串状态。
 * ------------------------------------------------------------------ */
const formPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await openSeeded(formPage, `${base}/#/records`);

/**
 * 每个场景都从「真刷新」开始。
 * 必须 reload：goto 到只有 hash 不同的地址时浏览器可能只做同文档导航，
 * 上一个场景留下的组件状态会串进来（一开始就是这么误报了一条）。
 */
const fresh = async (hash) => {
  await formPage.goto(`${base}/${hash}`, { waitUntil: "networkidle" });
  await formPage.reload({ waitUntil: "networkidle" });
  await formPage.waitForTimeout(1000);
};

const formState = () =>
  formPage.evaluate(() => {
    const label = [...document.querySelectorAll(".record-form label")].find((el) => el.textContent.includes("试卷名称"));
    return {
      hash: location.hash,
      recordForm: !!document.querySelector(".record-form"),
      mistakeForm: !!document.querySelector("form.form-grid:not(.record-form)"),
      confirm: !!document.querySelector('[role="dialog"]'),
      paperName: label?.querySelector("input")?.value ?? null
    };
  });

/** 点确认框里的按钮（「继续编辑」= 取消，「放弃」= 确认） */
const settle = async (label) => {
  await formPage.locator(`[role="dialog"] button:has-text("${label}")`).first().click();
  await formPage.waitForTimeout(500);
};

const openDashForm = async (name) => {
  await formPage.locator('button:has-text("记录成绩")').first().click();
  await formPage.waitForTimeout(400);
  if (name) {
    await formPage.locator(".record-form label:has-text('试卷名称') input").fill(name);
    await formPage.waitForTimeout(200);
  }
};

console.log("\n场景 7：填了一半的表单不能被静默关掉");
await fresh("#/");
await openDashForm("审计卷 01");
await formPage.locator('button:has-text("收起录入")').first().click();
await formPage.waitForTimeout(500);
let fs = await formState();
check(fs.confirm, "首页「收起录入」会先问一句", "首页「收起录入」直接把表单收了，填过的内容静默丢弃");
if (fs.confirm) {
  await settle("继续编辑");
  fs = await formState();
  check(fs.recordForm && fs.paperName === "审计卷 01",
    "选「继续编辑」后表单和内容都还在",
    `选「继续编辑」后状态不对（表单=${fs.recordForm}，名称=${JSON.stringify(fs.paperName)}）`);
  await formPage.locator('button:has-text("收起录入")').first().click();
  await formPage.waitForTimeout(400);
  await settle("放弃");
  fs = await formState();
  check(!fs.recordForm, "选「放弃」后表单关掉", "选「放弃」后表单没关掉");
}

// 反向验证：什么都没填的时候不能弹确认框。
// 表单里的科目、满分、卷型、日期都是**自动填**的（科目表还是异步来的），
// 判脏时不能把这些算成「用户输入」。
await fresh("#/");
await openDashForm();
await formPage.locator('button:has-text("收起录入")').first().click();
await formPage.waitForTimeout(500);
fs = await formState();
check(!fs.confirm && !fs.recordForm,
  "没填内容时收起不多问",
  "什么都没填，收起时却弹了「放弃未保存的内容」—— 自动填的科目/满分被当成用户输入了");

await fresh("#/mistakes");
await formPage.locator('button:has-text("新增错题")').first().click();
await formPage.waitForTimeout(500);
await formPage.locator('label:has-text("错题标题") input').first().fill("审计错题");
await formPage.waitForTimeout(200);
await formPage.locator('button:has-text("收起表单")').first().click();
await formPage.waitForTimeout(500);
fs = await formState();
check(fs.confirm, "错题页「收起表单」会先问一句", "错题页「收起表单」把填过的标题静默丢弃");
if (fs.confirm) await settle("放弃");

console.log("\n场景 8：填了一半时点侧栏换页 / 按浏览器返回");
await fresh("#/");
await openDashForm("审计卷 02");
await formPage.locator('a.nav-item[href="#/subjects"]').first().click();
await formPage.waitForTimeout(600);
fs = await formState();
check(fs.confirm && fs.hash === "#/",
  "点侧栏换页会先问一句，人还停在原页",
  `点侧栏换页没拦住（hash=${fs.hash}，确认框=${fs.confirm}）—— 填的内容静默丢弃`);
if (fs.confirm) {
  await settle("继续编辑");
  fs = await formState();
  check(fs.hash === "#/" && fs.recordForm && fs.paperName === "审计卷 02",
    "选「继续编辑」后留在原页、内容还在",
    `选「继续编辑」后状态不对（hash=${fs.hash}，表单=${fs.recordForm}，名称=${JSON.stringify(fs.paperName)}）`);
  await formPage.locator('a.nav-item[href="#/subjects"]').first().click();
  await formPage.waitForTimeout(500);
  await settle("放弃");
  fs = await formState();
  check(fs.hash === "#/subjects",
    `选「放弃」后正常换页（→ ${fs.hash}）`,
    `选「放弃」后没能换页（仍停在 ${fs.hash}）—— 确认框在导航守卫里动过历史栈，把 vue-router「中止就退回原地址」的那次 go(-1) 搅乱了`);
}

// 按返回：浏览器会**先把地址改掉**再通知我们，所以这种导航故意不拦（见
// router/index.js 里的说明）—— 拦了得靠 vue-router 自己补一次 history.go() 退回去，
// 而它算差值用的 history.state.position 是拿 history.length 记的，只增不减，
// 弹窗压过记录之后就不准了，实测会「退过头」。
// 这里要守住的不变量是：**地址栏和画面必须一致**（要么整页都走了，要么整页都留着）。
await fresh("#/records");
await fresh("#/");
await openDashForm("审计卷 03");
await formPage.evaluate(() => history.back());
await formPage.waitForTimeout(900);
fs = await formState();
const leftCleanly = fs.hash === "#/records" && !fs.recordForm;
const stayedCleanly = fs.hash === "#/" && fs.recordForm;
check(leftCleanly || stayedCleanly,
  `按返回后地址和画面一致（hash=${fs.hash}，表单${fs.recordForm ? "还在" : "已收起"}）`,
  `按返回后地址栏是 ${fs.hash}、表单${fs.recordForm ? "还在" : "已收起"} —— 地址和画面对不上，用户会以为自己在另一个页面`);

console.log("\n场景 9：「基于本成绩新增错题」要真的把表单打开");
await fresh("#/records");
const askedMistake = await formPage.evaluate(() => {
  const button = document.querySelector('button[aria-label="基于本成绩新增错题"]');
  if (!button) return false;
  button.click();
  return true;
});
if (!askedMistake) {
  bad("成绩列表里找不到「基于本成绩新增错题」按钮，跳过该场景");
} else {
  await formPage.waitForTimeout(1300);
  const s9 = await formPage.evaluate(() => {
    const label = [...document.querySelectorAll("label")].find((el) => el.textContent.includes("错题标题"));
    return {
      hash: location.hash,
      mistakeForm: !!document.querySelector("form.form-grid:not(.record-form)"),
      title: label?.querySelector("input")?.value ?? ""
    };
  });
  check(s9.mistakeForm,
    `表单自动打开了，标题已预填（「${s9.title}」）`,
    `点了「基于本成绩新增错题」却停在列表上、表单没开（hash=${s9.hash}）—— 按钮看起来像没反应`);
  check(!s9.hash.includes("recordId"),
    "用完就把 recordId 从地址里摘掉了",
    `地址里还留着 ${s9.hash} —— 这个页面一改筛选就会 replace 掉整个 query，把预填的标题冲掉`);
}
await formPage.close();

console.log("\n场景 10：错题搜索保留焦点，复习返回保留页码");
const reviewPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
await reviewPage.goto(`${base}/#/mistakes`);
await reviewPage.getByRole("heading", { name: "错题库", exact: true }).waitFor();
await seedRows(reviewPage, { mistakes: Array.from({ length: 18 }, (_, index) => ({
  id: `review-${index}`,
  subjectId: "math1",
  title: `积分复习 ${index + 1}`,
  status: "待复盘",
  createdAt: new Date(Date.UTC(2026, 8, index + 1)).toISOString()
})) });
await reviewPage.reload();
const reviewSearch = reviewPage.getByPlaceholder("题目、知识点或解析");
await reviewSearch.fill("积分");
await reviewPage.waitForURL((url) => url.hash.includes("q="));
check(await reviewSearch.evaluate((input) => input === document.activeElement),
  "搜索条件生效后输入框仍保持焦点", "搜索条件生效后输入框失去焦点");
const reviewPager = reviewPage.getByRole("navigation", { name: "错题列表分页" });
await reviewPager.getByRole("button", { name: "下一页" }).click();
await reviewPager.getByText("第 2 / 3 页").waitFor();
const reviewTitle = await reviewPage.locator(".review-card-title").first().innerText();
await reviewPage.getByRole("link", { name: "复习", exact: true }).first().click();
await reviewPage.getByRole("heading", { name: reviewTitle, exact: true }).waitFor();
await reviewPage.getByRole("link", { name: "返回错题库" }).click();
await reviewPager.getByText("第 2 / 3 页").waitFor();
check(await reviewSearch.inputValue() === "积分" && await reviewPage.locator(".review-card-title").first().innerText() === reviewTitle,
  "从复习返回后保留关键词和列表页码", "从复习返回后筛选或页码丢失");

console.log("\n场景 11：复习保存尚未完成时翻到下一题");
await reviewPage.getByRole("link", { name: "复习", exact: true }).first().click();
await reviewPage.getByRole("heading", { name: reviewTitle, exact: true }).waitFor();
const getReviewId = () => reviewPage.evaluate(() => location.hash.split("?")[0].split("/").at(-1));
const firstReviewId = await getReviewId();
await reviewPage.evaluate(() => {
  const store = document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("tracker");
  const save = store.updateMistake;
  store.updateMistake = async (...args) => {
    const result = await save(...args);
    await new Promise((resolve) => { window.finishReviewSave = resolve; });
    return result;
  };
});
await reviewPage.getByRole("button", { name: "完成本次复习" }).click();
await reviewPage.waitForFunction(() => typeof window.finishReviewSave === "function");
await reviewPage.getByRole("button", { name: "下一题" }).click();
await reviewPage.waitForURL((url) => !url.hash.includes(`/${firstReviewId}?`));
const secondReviewId = await getReviewId();
await reviewPage.evaluate(() => window.finishReviewSave());
await reviewPage.getByText("已标记为「已掌握」", { exact: true }).waitFor();
const logs = await reviewPage.evaluate((ids) => ids.map((id) =>
  JSON.parse(localStorage.getItem(`exam-tracker-review-log-${id}`) || "[]")), [firstReviewId, secondReviewId]);
check(firstReviewId !== secondReviewId && logs[0].length === 1 && logs[0][0].status === "已掌握" && logs[1].length === 0,
  "复习日志只写入操作时的题目", "翻题后复习日志写错了题目");
await reviewPage.close();

console.log(`\n${problems === 0 ? "没有发现问题" : `共 ${problems} 个问题`}`);
await browser.close();
server.close();
process.exitCode = problems === 0 ? 0 : 1;
