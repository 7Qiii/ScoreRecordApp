/**
 * 交互回归检查。
 *
 * 为什么单独一个脚本：
 *   这几条都是「功能看起来做了，实际在真机上不工作」的问题，静态检查
 *   （绑定、类型、CSS 死代码）一条都抓不到：
 *     · 科目排序用的是 HTML5 拖放 —— 触摸设备根本不派发 dragstart，
 *       而目标设备就是 iPad。
 *     · <main tabindex="-1"> 换页后被程序化聚焦，浏览器默认画一圈焦点环，
 *       表现为「每次进页面都有一圈蓝框」。
 *     · 「最近删除」面板的显示条件里带了 `|| deletedRecords.length > 0`，
 *       于是只要还剩一条，折叠按钮就永远不起作用。
 *   所以这里用真实的浏览器事件把它们钉住。
 *
 * 用法：node scripts/check-interactions.mjs
 */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { listenSafe } from "./lib/safe-listen.mjs";

const WORKSPACE = "C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace";
const chromium = createRequire(`${WORKSPACE}/package.json`)("playwright-core").chromium;

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");
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

const browser = await chromium.launch({ channel: "chrome" });

let problems = 0;
function check(ok, okMessage, failMessage) {
  if (ok) {
    console.log(`  ok   ${okMessage}`);
  } else {
    problems += 1;
    console.log(`  失败 ${failMessage}`);
  }
}

/** 一页一 context，互不干扰。 */
async function open(path, { deletedRecords } = {}) {
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  if (deletedRecords) {
    await context.addInitScript(
      ([key, value]) => window.localStorage.setItem(key, value),
      ["exam-tracker-deleted-records", JSON.stringify(deletedRecords)]
    );
  }
  const page = await context.newPage();
  await page.goto(`${base}${path}`, { waitUntil: "load" });
  await page.waitForTimeout(1100);
  return { context, page };
}

/** 读科目列表当前的名称顺序。 */
const subjectOrder = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-subject-id]")].map(
      (row) => row.querySelector("input")?.value ?? ""
    )
  );

// ---------------------------------------------------------------------------
console.log("\n焦点环（每次进页面的那圈蓝框）");

{
  const { context, page } = await open("/#/records");
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { tag: "BODY" };
    const cs = getComputedStyle(el);
    return { tag: el.tagName, outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth };
  });

  check(
    focused.tag === "MAIN",
    "换页后焦点仍然移到正文（键盘用户不用从侧栏重新 Tab）",
    `焦点没有落在 <main> 上，而是 ${focused.tag} —— 换页后的焦点管理坏了`
  );
  check(
    focused.outlineStyle === "none" || focused.outlineWidth === "0px",
    "程序化聚焦的 <main> 不画焦点环（那圈蓝框没了）",
    `<main> 仍在画焦点环：outline=${focused.outlineStyle} ${focused.outlineWidth} —— 用户会看到一圈蓝框`
  );
  await context.close();
}

// ---------------------------------------------------------------------------
console.log("\n科目拖拽排序（触摸路径）");

{
  const { context, page } = await open("/#/subjects");
  const before = await subjectOrder(page);
  check(before.length >= 3, `科目列表读到 ${before.length} 行`, `只读到 ${before.length} 行，没法测拖拽`);

  if (before.length >= 3) {
    // 科目列表在页面靠下的位置。不先滚进视口的话，落点坐标会落在视口外，
    // elementFromPoint 返回 null —— 那是测试自己的问题，不是功能的问题。
    await page.locator("[data-subject-id]").first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    // 用合成的 PointerEvent 走 touch 路径 —— 这正是 HTML5 拖放做不到的那条。
    //
    // 分步派发、每步之间让出一帧：合成事件是同步的，而 Vue 把状态刷到 DOM
    // 是异步的。一口气把 down/move/up 全派完，中间态（拖拽中、落点高亮）
    // 永远观察不到 —— 那是测试的错觉，不是功能的问题。
    const geometry = await page.evaluate(({ fromIndex, toIndex }) => {
      const handle = document.querySelectorAll("[data-drag-handle]")[fromIndex];
      const target = document.querySelectorAll("[data-subject-id]")[toIndex];
      if (!handle || !target) return null;
      const hb = handle.getBoundingClientRect();
      const tb = target.getBoundingClientRect();
      const ex = tb.left + tb.width / 2;
      const ey = tb.top + tb.height / 2;
      return {
        sx: hb.left + hb.width / 2,
        sy: hb.top + hb.height / 2,
        ex,
        ey,
        // 先确认落点真的打在目标行上，否则后面的失败没法归因
        hitId: document.elementFromPoint(ex, ey)?.closest("[data-subject-id]")?.getAttribute("data-subject-id") || "",
        targetId: target.getAttribute("data-subject-id")
      };
    }, { fromIndex: 0, toIndex: 2 });

    const dispatchPointer = (type, x, y) =>
      page.evaluate(({ type, x, y }) => {
        document.querySelector("[data-drag-handle]")?.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 1,
            pointerType: "touch",
            isPrimary: true,
            clientX: x,
            clientY: y,
            buttons: type === "pointerup" ? 0 : 1
          })
        );
      }, { type, x, y });

    const hasClass = (name) =>
      page.evaluate((cls) => !!document.querySelector(`.subject-editor.${cls}`), name);

    check(
      !!geometry && geometry.hitId === geometry.targetId,
      "落点确实打在目标行上（测试自身可信）",
      `落点没命中目标行：hit=${geometry?.hitId || "(空)"} target=${geometry?.targetId || "?"}`
    );

    await dispatchPointer("pointerdown", geometry.sx, geometry.sy);
    await page.waitForTimeout(150);
    check(await hasClass("is-dragging"), "按下手柄后进入拖拽态", "按下手柄后没有进入拖拽态 —— pointerdown 没生效");

    for (let step = 1; step <= 5; step += 1) {
      const t = step / 5;
      await dispatchPointer(
        "pointermove",
        geometry.sx + (geometry.ex - geometry.sx) * t,
        geometry.sy + (geometry.ey - geometry.sy) * t
      );
    }
    await page.waitForTimeout(150);
    check(await hasClass("is-drop-target"), "移动时高亮出落点行", "移动时没有落点高亮 —— pointermove 没生效");

    await dispatchPointer("pointerup", geometry.ex, geometry.ey);
    await page.waitForTimeout(900);
    check(!(await hasClass("is-dragging")), "松手后拖拽态清干净", "松手后还留着拖拽态");

    await page.waitForTimeout(900);
    const after = await subjectOrder(page);
    check(
      JSON.stringify(after) !== JSON.stringify(before),
      `拖拽改变了顺序：${before[0]} → 落到了第 ${after.indexOf(before[0]) + 1} 位`,
      `拖拽后顺序没变（还是 ${before.join(" / ")}）—— 触摸拖拽仍然不工作`
    );

    // 方向键是键盘/读屏用户的路径，也必须真的能排序
    const kbBefore = await subjectOrder(page);
    await page.evaluate(() => document.querySelector("[data-drag-handle]")?.focus());
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(700);
    const kbAfter = await subjectOrder(page);
    check(
      JSON.stringify(kbAfter) !== JSON.stringify(kbBefore),
      "方向键也能调整顺序（键盘用户的路径）",
      "按 ArrowDown 后顺序没变 —— 键盘排序不工作"
    );
    const stillFocused = await page.evaluate(
      () => document.activeElement?.hasAttribute("data-drag-handle") ?? false
    );
    check(
      stillFocused,
      "按完方向键焦点还在手柄上（可以连按）",
      "按完方向键焦点丢了，连按第二下会断"
    );
  }
  await context.close();
}

// ---------------------------------------------------------------------------
console.log("\n最近删除面板的折叠");

{
  const deleted = [
    {
      id: "check-del-1",
      deletedAt: new Date().toISOString(),
      record: { id: "check-del-1", subjectId: "chinese", score: 88, fullScore: 100, date: "2026-10-04", pendingSync: false }
    }
  ];
  const { context, page } = await open("/#/records", { deletedRecords: deleted });

  const panelVisible = () =>
    page.evaluate(() => !!document.querySelector(".record-restore-panel"));

  check(
    !(await panelVisible()),
    "有已删记录时，面板默认是收起的（不再一直占着列表上方）",
    "面板默认就展开了 —— 用户会一直看到一长串已删记录"
  );

  const toggle = page.locator("button", { hasText: "最近删除" }).first();
  await toggle.click();
  await page.waitForTimeout(400);
  check(await panelVisible(), "点「最近删除」能展开", "点了按钮面板没展开");

  await toggle.click();
  await page.waitForTimeout(400);
  check(!(await panelVisible()), "再点一次能收起", "再点按钮面板没收起 —— 折叠还是不起作用");

  await context.close();
}

// ---------------------------------------------------------------------------
console.log("\n保存成绩后不该再问「放弃未保存的内容」");

{
  // 成绩页的录入面板以前把「保存成功」和「关闭面板」走了同一个函数，
  // 而那个函数会 confirmDiscardChanges()。实测保存一条成绩就会弹出
  // 「放弃未保存的内容？」—— 用户看到的是「明明存好了还问我要不要放弃」，
  // 关掉之后成绩又确实在。这里把它钉住。
  const { context, page } = await open("/#/records");

  const askedDiscard = () => page.evaluate(() => /放弃未保存的内容/.test(document.body.innerText));

  await page.locator('button:has-text("新增成绩")').first().click();
  await page.waitForTimeout(600);
  await page.locator("form.record-form").getByLabel("试卷名称", { exact: true }).fill("回归测试卷");
  await page.locator('form.record-form input[type="number"]').first().fill("120");
  await page.waitForTimeout(250);
  await page.locator('form.record-form button[type="submit"]').first().click();
  await page.waitForTimeout(1200);

  check(
    !(await askedDiscard()),
    "成绩页保存成功后不再弹「放弃未保存的内容？」",
    "保存成功后仍然弹了放弃确认 —— 刚存完却问要不要放弃"
  );
  check(
    !(await page.evaluate(() => Boolean(document.querySelector("form.record-form")))),
    "保存成功后录入面板正常收起",
    "保存成功后表单还开着"
  );

  // 反向：填了一半不保存就关闭，**必须**仍然问一句。
  // 少了这条，把确认整个删掉也能让上面通过。
  await page.locator('button:has-text("新增成绩")').first().click();
  await page.waitForTimeout(600);
  await page.locator("form.record-form").getByLabel("试卷名称", { exact: true }).fill("填了一半就关");
  await page.waitForTimeout(250);
  await page.locator('button:has-text("关闭")').first().click();
  await page.waitForTimeout(800);
  check(
    await askedDiscard(),
    "填了一半直接关闭时仍然会问一句（保护没被一起删掉）",
    "填了一半关闭却不再问了 —— 未保存内容会被静默丢掉"
  );

  await context.close();
}

// ---------------------------------------------------------------------------
console.log("\n英语阅读的分篇对错");

{
  // 用户原来把「5545」手打进复盘备注里 —— 纯文本，不能统计也看不出哪篇弱。
  // 现在拆成 4 个格子。这里钉住三件事：
  //   1. 连续敲 5 5 4 5 要能自动跳格（不然 4 个格子比打字还慢）；
  //   2. 结构化数据不能漏进备注和导出（它是挂在备注里的隐藏块）；
  //   3. 只对英语出现，别的科目不能被带上。
  const { context, page } = await open("/#/records");

  const boxes = () =>
    page.evaluate(() => [...document.querySelectorAll(".reading-part input")].map((el) => el.value));
  const summary = () => page.evaluate(() => document.querySelector(".reading-summary")?.textContent?.trim() || "");

  await page.locator('button:has-text("新增成绩")').first().click();
  await page.waitForTimeout(600);

  await page.locator("form.record-form select").first().selectOption("math1");
  await page.waitForTimeout(300);
  check(
    (await page.locator(".reading-parts").count()) === 0,
    "数学科目不显示阅读分篇",
    "数学科目也显示了阅读分篇 —— 阅读结果会跟着存进数学成绩"
  );

  await page.locator("form.record-form select").first().selectOption("english1");
  await page.waitForTimeout(300);
  check(
    (await page.locator(".reading-part input").count()) === 4,
    "英一显示 4 个阅读格子",
    `英一只显示了 ${await page.locator(".reading-part input").count()} 个格子`
  );

  // 连续输入，靠的是「填完一格自动跳下一格」
  await page.locator(".reading-part input").first().click();
  await page.keyboard.type("5545", { delay: 60 });
  await page.waitForTimeout(300);
  check(
    JSON.stringify(await boxes()) === JSON.stringify(["5", "5", "4", "5"]),
    "连着敲 5545 能填满 4 个格子（自动跳格）",
    `连续输入后是 ${JSON.stringify(await boxes())} —— 没有自动跳格，用户还是得逐个点`
  );
  check(
    (await summary()).includes("19/20"),
    `摘要算对了：${await summary()}`,
    `摘要不对：${await summary()}`
  );

  // 越界的数字要丢掉，不能悄悄改成 5
  await page.locator(".reading-part input").nth(3).fill("");
  await page.locator(".reading-part input").nth(3).click();
  await page.keyboard.type("9", { delay: 60 });
  await page.waitForTimeout(250);
  check(
    (await boxes())[3] === "",
    "填 9 这种越界值不会被悄悄存成别的数",
    `填 9 之后第 4 格变成了 ${(await boxes())[3]} —— 越界值被篡改了`
  );
  await page.locator(".reading-part input").nth(3).click();
  await page.keyboard.type("5", { delay: 60 });
  await page.waitForTimeout(200);

  await page.locator("form.record-form").getByLabel("试卷名称", { exact: true }).fill("阅读回归卷");
  await page.locator('form.record-form input[type="number"]').first().fill("82");
  await page.waitForTimeout(200);
  await page.locator('form.record-form button[type="submit"]').first().click();
  await page.waitForTimeout(1300);

  check(
    (await page.locator(".reading-pill").first().innerText().catch(() => "")).includes("5545"),
    "保存后列表里能看到「阅读 5545」",
    "保存后列表里没有阅读结果 —— 填了等于没填"
  );

  const href = await page.locator("tbody tr a").first().getAttribute("href");
  await page.goto(`${base}/${href}`, { waitUntil: "load" });
  await page.waitForTimeout(1000);

  check(
    (await page.locator(".reading-detail-item").count()) === 4,
    "详情页展示 4 篇的结果",
    "详情页没有阅读分篇 —— 结果只存了看不见"
  );
  check(
    !(await page.evaluate(() => document.body.innerText.includes("exam-tracker"))),
    "备注和页面上看不到隐藏的元数据块",
    "页面上露出了 exam-tracker 元数据 —— 备注里那坨编码跑到界面上了"
  );

  await page.locator('button:has-text("编辑")').first().click();
  await page.waitForTimeout(700);
  check(
    JSON.stringify(await boxes()) === JSON.stringify(["5", "5", "4", "5"]),
    "重新编辑时阅读结果能读回来",
    `编辑时读回的是 ${JSON.stringify(await boxes())} —— 存进去没读出来`
  );

  // 判脏：阅读格也是用户填的内容，改了就该拦一下
  const askedDiscard = () => page.evaluate(() => /放弃未保存的内容/.test(document.body.innerText));
  await page.locator(".reading-part input").first().click();
  await page.keyboard.type("3", { delay: 60 });
  await page.waitForTimeout(250);
  await page.locator('button:has-text("关闭")').first().click();
  await page.waitForTimeout(900);
  check(
    await askedDiscard(),
    "只改了阅读格子，关闭时也会问一句（算未保存内容）",
    "改了阅读格子却被静默丢弃 —— 判脏没覆盖这个字段"
  );

  // 反向：问过之后选择继续编辑并保存，保存成功就**不该**再问。
  // 成绩列表页上一轮就是在这里翻的车（保存和关闭走了同一个函数）。
  await page.getByRole("button", { name: "继续编辑" }).click();
  await page.waitForTimeout(400);
  await page.locator('form.record-form button[type="submit"]').first().click();
  await page.waitForTimeout(1300);
  check(
    !(await askedDiscard()),
    "详情页保存成功后不再问「放弃未保存的内容」",
    "详情页刚保存完又弹了放弃确认 —— 保存成功走了「用户取消」那条路径"
  );
  check(
    !(await page.evaluate(() => Boolean(document.querySelector("form.record-form")))),
    "详情页保存成功后退出编辑态",
    "详情页保存成功后表单还开着"
  );

  await context.close();
}

await browser.close();
server.close();

console.log(problems ? `\n共 ${problems} 个问题` : "\n全部通过");
process.exit(problems ? 1 : 0);
