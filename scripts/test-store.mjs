/**
 * tracker store 的行为回归测试。
 *
 * 为什么值得测：src/stores/tracker.js 有 1354 行，是全项目最大的一个文件，
 * 而它此前零测试。里面大量逻辑是「静默失败」型的 —— 卷子类型判定错了、
 * 合成成绩的元信息没塞进备注、回收站时间算错，界面上都不会报错，
 * 只会让数据看起来不对，甚至悄悄丢数据。
 *
 * 为什么能直接在 Node 里跑：
 * 源码是给 Vite 写的（相对导入不带扩展名、用 import.meta.env），
 * scripts/lib/vite-shim.mjs 把这两点在加载阶段补上；
 * scripts/lib/browser-env.mjs 铺一层最小的浏览器环境。
 * 不需要 jsdom，也不需要 IndexedDB —— Dexie 是懒的，不写就不开库，
 * 测试里把 db 的表方法换成内存桩，要测的是 store 的逻辑，不是 Dexie 的持久化。
 *
 * 跑法：node scripts/test-store.mjs
 */
import "./lib/node-runner.mjs";
import { installBrowserEnv, stubDatabase } from "./lib/browser-env.mjs";

const env = installBrowserEnv();

const { createPinia, setActivePinia } = await import("pinia");
const { db } = await import("../src/services/storage.js");
const dbStub = stubDatabase(db);
const { useTrackerStore } = await import("../src/stores/tracker.js");

const RECORD_TRASH_KEY = "exam-tracker-deleted-records";

let failed = 0;
let passed = 0;

function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) console.log(`      实际 ${JSON.stringify(actual)}  期望 ${JSON.stringify(expected)}`);
}

function checkDeep(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  const ok = a === b;
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) console.log(`      实际 ${a}\n      期望 ${b}`);
}

/**
 * 期望某个 async 函数抛出指定错误。
 * 必须 await —— addCompositeRecord 是 async 的，同步 try/catch 抓不到它，
 * 只会拿到一个 rejected promise，然后被当成「没抛错」而误报失败。
 */
async function checkThrows(label, fn, expectedMessage) {
  let actual = null;
  try {
    await fn();
  } catch (error) {
    actual = error.message;
  }
  const ok = actual === expectedMessage;
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) console.log(`      实际 ${JSON.stringify(actual)}  期望 ${JSON.stringify(expectedMessage)}`);
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

/** 新建一个 store 实例。defineStore 是按 pinia 缓存的，换 pinia 就是换实例。 */
function freshStore() {
  setActivePinia(createPinia());
  return useTrackerStore();
}

const store = freshStore();

// ---------------------------------------------------------------------------
section("成绩归一化：分数与用时");
// ---------------------------------------------------------------------------

const base = { subjectId: "math1", paperName: "2026模拟一", date: "2026-10-02" };

const r1 = await store.addRecord({ ...base, score: "120.5", fullScore: "150", durationMinutes: "90" });
check("字符串分数转成数字", r1.score, 120.5);
check("满分同样转数字", r1.fullScore, 150);
check("用时字符串转成数字", r1.durationMinutes, 90);
check("新记录标记待同步", r1.pendingSync, true);
check("recordType 默认是 paper", r1.recordType, "paper");
check("未知 recordType 退回 paper", (await store.addRecord({ ...base, recordType: "wat" })).recordType, "paper");

// 用时为空的四种写法都必须落成 ""，否则「用时」的记录率统计会被算错。
for (const [label, value] of [["空串", ""], ["null", null], ["undefined", undefined]]) {
  const record = await store.addRecord({ ...base, durationMinutes: value });
  check(`用时 ${label} → 空`, record.durationMinutes, "");
}
check("用时负数 → 空（不是 0）", (await store.addRecord({ ...base, durationMinutes: -5 })).durationMinutes, "");
check("用时非数字 → 空", (await store.addRecord({ ...base, durationMinutes: "abc" })).durationMinutes, "");
check("用时 0 是合法值，不能当空", (await store.addRecord({ ...base, durationMinutes: 0 })).durationMinutes, 0);
check("用时小数四舍五入", (await store.addRecord({ ...base, durationMinutes: 89.6 })).durationMinutes, 90);

// ---------------------------------------------------------------------------
section("卷子类型判定：只有数一才分模拟/真题");
// ---------------------------------------------------------------------------

async function variantOf(subjectId, paperName, paperVariant) {
  const record = await store.addRecord({ subjectId, paperName, paperVariant, score: 100, fullScore: 150 });
  return record.paperVariant;
}

check("数一 + 模拟卷 → mock", await variantOf("math1", "2026张八模拟卷"), "mock");
check("数一 + 模考 → mock", await variantOf("math1", "第一次模考"), "mock");
check("数一 + 真题 → true", await variantOf("math1", "09真题"), "true");
check("数一 + 历年 → true", await variantOf("math1", "历年真题精选"), "true");
check("数一 + 普通卷名 → 空", await variantOf("math1", "强化阶段测试"), "");
check("408 + 模拟卷 → 空（不是数一就不判）", await variantOf("cs408", "模拟卷"), "");
check("英语 + 真题 → 空", await variantOf("english1", "真题"), "");
check("显式 mock 优先于卷名", await variantOf("math1", "09真题", "mock"), "mock");
check("显式 true 大小写不敏感", await variantOf("math1", "模拟卷", "TRUE"), "true");
check("显式空串回落到卷名推导", await variantOf("math1", "模拟卷", ""), "mock");

// ---------------------------------------------------------------------------
section("习题记录：卷名由书/页/题拼出来");
// ---------------------------------------------------------------------------

const exercise = await store.addRecord({
  subjectId: "math1",
  recordType: "exercise",
  exerciseBookName: "880题",
  exercisePage: "12",
  exerciseQuestion: "3",
  score: 10,
  fullScore: 10
});
check("拼出完整习题名", exercise.paperName, "880题 · P12 · 第 3 题");
check("习题不判模拟/真题", exercise.paperVariant, "");
check("习题保留书名", exercise.exerciseBookName, "880题");

const bareExercise = await store.addRecord({ subjectId: "math1", recordType: "exercise", score: 0, fullScore: 10 });
check("三要素全空时兜底名", bareExercise.paperName, "数一习题");

const paperWithExerciseFields = await store.addRecord({
  subjectId: "math1",
  recordType: "paper",
  paperName: "2026模拟一",
  exerciseBookName: "不该被保留",
  exercisePage: "9",
  score: 100,
  fullScore: 150
});
check("试卷记录不保留习题字段(书名)", paperWithExerciseFields.exerciseBookName, "");
check("试卷记录不保留习题字段(页码)", paperWithExerciseFields.exercisePage, "");

// ---------------------------------------------------------------------------
section("合成成绩：元信息写进备注再读回来");
// ---------------------------------------------------------------------------

const compositeStore = freshStore();
const srcA = await compositeStore.addRecord({ subjectId: "math1", paperName: "26张八1", score: 120, fullScore: 150, durationMinutes: 90, date: "2026-09-01" });
const srcB = await compositeStore.addRecord({ subjectId: "math1", paperName: "26张八2", score: 130, fullScore: 150, durationMinutes: 80, date: "2026-09-08" });

const composite = await compositeStore.addCompositeRecord([srcA.id, srcB.id], { note: "两份合起来看" });
check("合成记录类型", composite.recordType, "composite");
check("合成分数是来源之和", composite.score, 250);
check("合成满分是来源之和", composite.fullScore, 300);
check("两份都有用时就相加", composite.durationMinutes, 170);
check("没给卷名时按来源自动起名", composite.paperName, "2026 26张八1 + 26张八2");
check("日期取最新的一份", composite.date, "2026-09-08");

check("界面上看到的备注不含元信息", compositeStore.displayRecordNote(composite), "两份合起来看");
check("备注原文被写进存储时带了元信息", composite.note.startsWith("两份合起来看\n\n<!-- exam-tracker-composite:"), true);
checkDeep("读回来的来源是两条", compositeStore.compositeSourcesForRecord(composite).map((s) => s.paperName), ["26张八1", "26张八2"]);
checkDeep("来源里保留了原始分数", compositeStore.compositeSourcesForRecord(composite).map((s) => s.originalScore), [120, 130]);

// 合成时可以覆盖分数/用时，覆盖值要进 compositeSources，原始值另存一份
const overridden = await compositeStore.addCompositeRecord([srcA.id, srcB.id], {
  score: 260,
  fullScore: 300,
  durationMinutes: 100,
  sources: [{ id: srcA.id, score: 130, durationMinutes: 60 }]
});
check("覆盖后的合成分", overridden.score, 260);
check("覆盖后的用时", overridden.durationMinutes, 100);
const overriddenSources = compositeStore.compositeSourcesForRecord(overridden);
check("被覆盖那条的来源分是新值", overriddenSources[0].score, 130);
check("被覆盖那条的原始分仍保留", overriddenSources[0].originalScore, 120);
check("被覆盖那条的来源用时是新值", overriddenSources[0].durationMinutes, 60);
check("没被覆盖那条不受影响", overriddenSources[1].score, 130);

// 来源里只要有一条没填用时，合成结果就不能瞎猜成「另一条的用时」
const srcNoDuration = await compositeStore.addRecord({ subjectId: "math1", paperName: "26张八3", score: 100, fullScore: 150, date: "2026-09-15" });
const partial = await compositeStore.addCompositeRecord([srcA.id, srcNoDuration.id]);
check("有一条没填用时就整体留空", partial.durationMinutes, "");

check("不同年份的来源不硬编年份", (await compositeStore.addCompositeRecord([srcA.id, srcNoDuration.id])).paperName.includes("2026"), true);

// 备注里已经有元信息时，重新合成不能把旧的元信息套进去
const reNote = compositeStore.displayRecordNote(overridden);
check("重复剥离不会残留标记", reNote.includes("exam-tracker-composite"), false);

// ---------------------------------------------------------------------------
section("合成成绩：非法输入的拦截");
// ---------------------------------------------------------------------------

await checkThrows("少于两条要报错", () => compositeStore.addCompositeRecord([srcA.id]), "请至少选择两条成绩进行合成。");
await checkThrows("查不到的 id 等于没选", () => compositeStore.addCompositeRecord(["不存在", "也不存在"]), "请至少选择两条成绩进行合成。");

const otherSubject = await compositeStore.addRecord({ subjectId: "cs408", paperName: "408模拟", score: 100, fullScore: 150 });
await checkThrows("跨科目合成要报错", () => compositeStore.addCompositeRecord([srcA.id, otherSubject.id]), "只能合成同一科目的成绩。");

// 同一个 id 传两次：id 列表要去重，否则恢复/对比逻辑会拿重复项去匹配
const duplicated = await compositeStore.addCompositeRecord([srcA.id, srcA.id, srcB.id]);
checkDeep("compositeSourceIds 去重", duplicated.compositeSourceIds, [srcA.id, srcB.id]);

// ---------------------------------------------------------------------------
section("回收站：24 小时 TTL");
// ---------------------------------------------------------------------------

const trashStore = freshStore();
const doomed = await trashStore.addRecord({ subjectId: "math1", paperName: "待删除", score: 100, fullScore: 150, date: "2026-10-01" });
check("删除前回收站是空的", trashStore.deletedRecords.length, 0);

await trashStore.removeRecord(doomed.id);
check("删除后不在列表里", trashStore.records.some((r) => r.id === doomed.id), false);
check("删除后进了回收站", trashStore.deletedRecords.length, 1);
check("剩余可恢复时间刚删完是 24 小时", trashStore.deletedRecordRemainingHours(trashStore.deletedRecords[0]), 24);

await trashStore.restoreDeletedRecord(doomed.id);
check("恢复后回到列表", trashStore.records.some((r) => r.id === doomed.id), true);
check("恢复后回收站清空", trashStore.deletedRecords.length, 0);

const hours = (ms) => new Date(Date.now() - ms).toISOString();
check("23 小时前删的还剩 1 小时", trashStore.deletedRecordRemainingHours({ deletedAt: hours(23 * 3600e3) }), 1);
check("25 小时前删的已经过期", trashStore.deletedRecordRemainingHours({ deletedAt: hours(25 * 3600e3) }), 0);
check("没有 deletedAt 时算 0", trashStore.deletedRecordRemainingHours({}), 0);
check("没有参数时算 0", trashStore.deletedRecordRemainingHours(undefined), 0);

// 旧版回收站迁移有效条目。新表会继续保留已经过期但尚未送达云端的删除。
env.storage.setItem(
  RECORD_TRASH_KEY,
  JSON.stringify([
    { id: "fresh", deletedAt: hours(1 * 3600e3), record: { id: "fresh", subjectId: "math1", paperName: "新鲜" } },
    { id: "stale", deletedAt: hours(30 * 3600e3), record: { id: "stale", subjectId: "math1", paperName: "过期" } }
  ])
);
const reloaded = freshStore();
await db.deletedRecords.bulkPut([
  { id: "queued", deletedAt: hours(30 * 3600e3), pendingSync: true, userId: "user-1", record: { id: "queued" } },
  { id: "expired", deletedAt: hours(30 * 3600e3), pendingSync: false, record: { id: "expired" } }
]);

await reloaded.load();
checkDeep("迁移后回收站只显示未过期的成绩", reloaded.deletedRecords.map((entry) => entry.id), ["fresh"]);
check("迁移后旧存储已清理", env.storage.getItem(RECORD_TRASH_KEY), null);
checkDeep("过期的待同步删除仍保留", dbStub.read("deletedRecords").map((entry) => entry.id).sort(), ["fresh", "queued"]);

// ---------------------------------------------------------------------------
section("科目名兜底");
// ---------------------------------------------------------------------------

check("没有科目数据时兜底文案", store.subjectName("math1"), "未分类");
check("未知科目 id 同样兜底", store.subjectName("不存在的科目"), "未分类");
check("默认科目色", store.subjectColor("math1"), "#177ddc");

// ---------------------------------------------------------------------------
section("写入落到存储层");
// ---------------------------------------------------------------------------

const persisted = dbStub.read("records");
check("addRecord 确实写进了 db", persisted.length > 0, true);
check("写进去的记录和内存里一致", persisted.some((row) => row.id === r1.id), true);

const trashPersisted = await (async () => {
  const s = freshStore();
  const rec = await s.addRecord({ subjectId: "math1", paperName: "落盘检查", score: 1, fullScore: 2, date: "2026-10-03" });
  await s.removeRecord(rec.id);
  return dbStub.read("deletedRecords");
})();
check("移入回收站会写 IndexedDB", trashPersisted.some((e) => e.record.paperName === "落盘检查"), true);

// ---------------------------------------------------------------------------
section("测试桩自检：write() 必须对 db.<table> 可见");
// ---------------------------------------------------------------------------
// 这一节存在的理由：下面「演示数据」那节曾经失败，但错的不是源码，是桩。
// stubDatabase 的 write() 当时用 rows.set(name, [...values]) 换掉了数组，
// 而各表方法是闭包捕获的旧数组 —— 于是 db.records.count() 和
// dbStub.read() 各看各的，「种子灌没灌进去」实际是在一个幻影数据库上断言。
// 桩是测试的地基，地基错了，上面所有结论都不可信，所以先钉住它。
//
// 注意这里复用外层那个 dbStub、跑完把原数据写回去 —— 不能在这里再调一次
// stubDatabase(db)：那会把 db.records 重新指向一张新表，外层 dbStub 就悬空了。
{
  const original = dbStub.read("records");
  const originalMistakes = dbStub.read("mistakes");

  dbStub.write("records", [{ id: "probe-a" }]);
  check("write() 之后 count() 立刻看得到", await db.records.count(), 1);

  await db.records.bulkPut([{ id: "probe-b" }]);
  check("write() 之后 bulkPut 落在同一张表（count）", await db.records.count(), 2);
  checkDeep(
    "write() 之后 bulkPut 落在同一张表（read）",
    dbStub.read("records").map((r) => r.id).sort(),
    ["probe-a", "probe-b"]
  );

  dbStub.write("records", []);
  check("write([]) 之后 count() 也归零", await db.records.count(), 0);

  dbStub.write("records", original);
  dbStub.write("mistakes", originalMistakes);
  checkDeep(
    "自检结束后原数据原样还回去",
    dbStub.read("records").map((r) => r.id).sort(),
    original.map((r) => r.id).sort()
  );
}

// ---------------------------------------------------------------------------
section("演示数据：不能自己长出来，也不能被同步到云端");
// ---------------------------------------------------------------------------
// 起因：用户反馈「每次同步都会出现四条自己从没记过的成绩」。链路是
//   seedIfEmpty() 往空库灌演示数据
//   → mergeCloudEntries 把「本地有、云端没有」的条目标成待同步
//   → retryUnsyncedData 把它们上传
//   → 从此每台设备、每次同步都拉回来。
// 下面把「灌」和「认」两头都钉住。

const { seedIfEmpty, isDemoRecord, isDemoMistake, createDemoRecords, createDemoMistakes } = await import(
  "../src/services/storage.js"
);

const demoRecord = createDemoRecords()[0];
const demoMistake = createDemoMistakes()[0];

// —— 识别 ——
check("演示成绩能被认出来", isDemoRecord(demoRecord), true);
check("演示错题能被认出来", isDemoMistake(demoMistake), true);

// 老版本用随机 UUID 生成的、已经漏进云端的那批，只能靠内容认
check(
  "老演示成绩（随机 UUID）也能靠内容认出来",
  isDemoRecord({ ...demoRecord, id: "6f1c2b8e-0000-4000-8000-000000000001" }),
  true
);
check(
  "真实成绩不会被误判",
  isDemoRecord({
    id: "real-1",
    subjectId: "math1",
    paperName: "25超越2",
    score: 119,
    fullScore: 150,
    durationMinutes: 170,
    note: "最后一道大题没做完。"
  }),
  false
);
check(
  "改过备注的演示成绩不再算演示数据（改过的应该能正常同步）",
  isDemoRecord({ ...demoRecord, note: "我自己写的备注" }),
  false
);

// —— 灌种子 ——
function resetDemoTables() {
  dbStub.write("records", []);
  dbStub.write("mistakes", []);
  env.storage.removeItem("exam-tracker-demo-seeded");
}

resetDemoTables();
await seedIfEmpty();
check("默认不灌演示数据（空库也不灌）", dbStub.read("records").length, 0);

await seedIfEmpty({ seedDemo: true });
check("显式开启后灌入 4 条演示成绩", dbStub.read("records").length, 4);
check("同时灌入 2 道演示错题", dbStub.read("mistakes").length, 2);

// 用户把它们删光 —— 再空库也不能重新长出来
dbStub.write("records", []);
dbStub.write("mistakes", []);
await seedIfEmpty({ seedDemo: true });
check("灌过一次之后再空库也不会重新灌", dbStub.read("records").length, 0);

// 只删错题、成绩还在：以前两个表各自判断，会补两道错题进来
env.storage.removeItem("exam-tracker-demo-seeded");
dbStub.write("records", [{ id: "real-1" }]);
dbStub.write("mistakes", []);
await seedIfEmpty({ seedDemo: true });
check("成绩还在时不会补种错题", dbStub.read("mistakes").length, 0);

resetDemoTables();

// ---------------------------------------------------------------------------

const cleared = env.cleanup();
console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败（清理了 ${cleared} 个定时器）`);
process.exit(failed === 0 ? 0 : 1);
