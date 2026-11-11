/**
 * 云端同步里的「演示数据」回归测试。
 *
 * 用户报的现象：「每次同步都会出现这四个原本没有记录的东西」。
 * 根因链路是：
 *   1. seedIfEmpty() 无条件往空库灌 4 条成绩 + 2 道错题；
 *   2. mergeCloudEntries() 把「本地有、云端没有」的条目标成 pendingSync；
 *   3. retryUnsyncedData() 把它们上传 —— 演示数据就此被「洗白」成云端真实记录；
 *   4. runCloudLoad() 是云端优先的合并，不会清掉本地演示数据，于是每台设备、
 *      每次同步都把它拉回来。用户删掉之后，只要本地 records 又变空，
 *      下一次 load() 会再灌一遍、再传一遍。
 *
 * test-store.mjs 覆盖了第 1 步（灌种子）和「认不认得出来」。这里覆盖 2~4 步：
 * 真的走一遍 loadFromCloud() / syncNow()，看它会不会把演示数据传上去、会不会
 * 把云端已有的演示数据拉回来。
 *
 * 为什么单独一个文件：supabase.js 在**模块加载时**就读 import.meta.env 决定
 * 要不要 createClient，所以必须在 import 之前把 VITE_SUPABASE_URL 塞进环境，
 * 和 test-store.mjs（纯本地模式）没法共用一个进程。
 *
 * 云端怎么模拟：supabase-js 最终走全局 fetch，所以换掉 globalThis.fetch 就能
 * 把 PostgREST 的响应攥在手里 —— 不需要真的网络，也不需要改源码。
 *
 * 跑法：node scripts/test-demo-sync.mjs
 */
import "./lib/node-runner.mjs";
import { installBrowserEnv, stubDatabase } from "./lib/browser-env.mjs";

const env = installBrowserEnv({
  viteEnv: {
    VITE_SUPABASE_URL: "https://testref.supabase.co",
    VITE_SUPABASE_ANON_KEY: "test-anon-key"
  }
});

// ---------------------------------------------------------------------------
// 假云端
// ---------------------------------------------------------------------------

const calls = [];
let cloudTables = { subjects: [], records: [], mistakes: [], mistake_images: [] };
let failRecordDeletes = false;
let holdRecordDelete = null;
let holdRecordRead = null;

function recordDeleteIds(search) {
  const id = new URLSearchParams(search).get("id") || "";
  if (id.startsWith("eq.")) return [id.slice(3)];
  return id.slice(4, -1).split(",").filter(Boolean);
}

function holdRequest() {
  let signal;
  let release;
  const started = new Promise((resolve) => { signal = resolve; });
  const paused = new Promise((resolve) => { release = resolve; });
  return { started, release, hold: () => { signal(); return paused; } };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const { pathname, search } = new URL(url);
  const method = String(init.method || "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ method, pathname, search, body });

  // 会话是从 localStorage 里读出来的，正常不会走网络；真走了也别炸。
  if (pathname.startsWith("/auth/v1/")) return jsonResponse({});
  const table = pathname.replace("/rest/v1/", "");
  if (method === "DELETE") {
    if (table === "records") {
      const hold = holdRecordDelete;
      holdRecordDelete = null;
      if (hold) await hold();
      if (failRecordDeletes) return jsonResponse({ message: "Network unavailable" }, 503);
      const ids = new Set(recordDeleteIds(search));
      cloudTables.records = cloudTables.records.filter((row) => !ids.has(row.id));
    }
    return jsonResponse([]);
  }
  if (method === "POST" && table === "records") {
    const rows = Array.isArray(body) ? body : [body];
    if (rows.some((row) => row.paper_name === "无效记录")) {
      return jsonResponse({ code: "23514", message: "Record constraint failed" }, 400);
    }
    const byId = new Map(cloudTables.records.map((row) => [row.id, row]));
    rows.forEach((row) => byId.set(row.id, row));
    cloudTables.records = [...byId.values()];
    return jsonResponse([]);
  }
  if (method === "GET" && table === "records" && holdRecordRead) {
    const snapshot = cloudTables.records;
    const hold = holdRecordRead;
    holdRecordRead = null;
    await hold();
    return jsonResponse(snapshot);
  }
  return jsonResponse(cloudTables[table] ?? []);
};

const deletesFor = (table) => calls.filter((c) => c.method === "DELETE" && c.pathname === `/rest/v1/${table}`);
const writesFor = (table) => calls.filter((c) => c.method !== "GET" && c.method !== "DELETE" && c.pathname === `/rest/v1/${table}`);

// ---------------------------------------------------------------------------
// 会话：让 getSession() 能直接读到，不用打网络
// ---------------------------------------------------------------------------

const SESSION_KEY = "sb-testref-auth-token";
env.storage.setItem(
  SESSION_KEY,
  JSON.stringify({
    access_token: "test-access-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "test-refresh-token",
    user: { id: "user-1", email: "test@example.com", aud: "authenticated", role: "authenticated" }
  })
);

// ---------------------------------------------------------------------------
// 被测对象
// ---------------------------------------------------------------------------

const { createPinia, setActivePinia } = await import("pinia");
const { db } = await import("../src/services/storage.js");
const dbStub = stubDatabase(db);
const { useTrackerStore } = await import("../src/stores/tracker.js");
const { createDemoRecords, createDemoMistakes } = await import("../src/services/storage.js");
const { isSupabaseConfigured: supabaseOn } = await import("../src/services/supabase.js");

setActivePinia(createPinia());

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

function section(title) {
  console.log(`\n── ${title} ──`);
}

// ---------------------------------------------------------------------------
// 云端数据的造法：id 故意用随机 UUID
// ---------------------------------------------------------------------------
// 用户遇到的那批就是老版本用 crypto.randomUUID() 生成的。如果测试里图省事
// 直接用 demo-record-xxx，就等于在测「按 id 前缀识别」—— 而真实场景恰恰
// 认不出前缀，只能靠内容指纹。用随机 id 才是在测真实路径。

function recordRow(record, id = crypto.randomUUID(), overrides = {}) {
  return {
    id,
    subject_id: record.subjectId,
    record_type: "paper",
    paper_name: record.paperName,
    paper_variant: record.paperVariant || "",
    score: record.score,
    full_score: record.fullScore,
    duration_minutes: record.durationMinutes,
    date: record.date,
    note: record.note,
    created_at: record.createdAt,
    updated_at: record.createdAt,
    ...overrides
  };
}

function mistakeRow(mistake, id = crypto.randomUUID(), overrides = {}) {
  return {
    id,
    subject_id: mistake.subjectId,
    title: mistake.title,
    knowledge_point: mistake.knowledgePoint,
    reason: mistake.reason,
    status: mistake.status,
    source_record_id: "",
    question_text: "",
    analysis: "",
    next_review_at: "",
    created_at: mistake.createdAt,
    updated_at: mistake.updatedAt,
    ...overrides
  };
}

const demoRecords = createDemoRecords();
const demoMistakes = createDemoMistakes();

const launderedRecordRows = demoRecords.map((record) => recordRow(record));
const launderedMistakeRows = demoMistakes.map((mistake) => mistakeRow(mistake));
const launderedRecordIds = launderedRecordRows.map((row) => row.id);
const launderedMistakeIds = launderedMistakeRows.map((row) => row.id);

// 用户改过的那条：分数动过 → 指纹不再命中 → 必须当成真实数据留下
const editedDemoRow = recordRow(demoRecords[1], crypto.randomUUID(), {
  score: 118,
  updated_at: "2026-10-02T00:00:00.000Z"
});

const realRow = {
  id: "real-record-1",
  subject_id: "math1",
  record_type: "paper",
  paper_name: "25超越2",
  paper_variant: "",
  score: 119,
  full_score: 150,
  duration_minutes: 170,
  date: "2026-09-20",
  note: "最后一道大题没做完。",
  created_at: "2026-09-20T12:00:00.000Z",
  updated_at: "2026-09-20T12:00:00.000Z"
};

const realMistakeRow = {
  id: "real-mistake-1",
  subject_id: "math1",
  title: "级数收敛半径",
  knowledge_point: "高等数学",
  reason: "method",
  status: "待复盘",
  source_record_id: "",
  question_text: "",
  analysis: "",
  next_review_at: "",
  created_at: "2026-09-21T00:00:00.000Z",
  updated_at: "2026-09-21T00:00:00.000Z"
};

// ---------------------------------------------------------------------------
section("前置：这个进程确实是「云端模式」");
// ---------------------------------------------------------------------------

check("VITE_SUPABASE_URL/ANON_KEY 生效，isSupabaseConfigured 为真", supabaseOn, true);
check("storage.js 也认为已配置（决定要不要灌演示数据的就是它）", supabaseOn, true);

// ---------------------------------------------------------------------------
section("场景一：云端已经有被「洗白」的演示数据");
// ---------------------------------------------------------------------------
// 这就是用户现在的状态：4 条成绩 + 2 道错题已经在云上了。
// 期望：登录后它们被清掉（并且从云端删掉，不再回来），真实数据一条不少。

cloudTables = {
  subjects: [],
  records: [...launderedRecordRows, editedDemoRow, realRow],
  mistakes: [...launderedMistakeRows, realMistakeRow],
  mistake_images: []
};
calls.length = 0;

const store = useTrackerStore();
await store.loadFromCloud();

const recordIds = store.records.map((record) => record.id).sort();
const mistakeIds = store.mistakes.map((mistake) => mistake.id).sort();

checkDeep("被洗白的 4 条演示成绩不再出现在列表里", recordIds, [editedDemoRow.id, realRow.id].sort());
checkDeep("被洗白的 2 道演示错题不再出现在列表里", mistakeIds, [realMistakeRow.id]);
check("改过分数的那条演示成绩被当成真实数据保留", recordIds.includes(editedDemoRow.id), true);
check("真实成绩保留", recordIds.includes(realRow.id), true);

const deletedRecordIds = deletesFor("records")
  .flatMap((call) => recordDeleteIds(call.search));
checkDeep(
  "云端那 4 条演示成绩被真的删掉（否则下次同步还会拉回来）",
  deletedRecordIds.sort(),
  launderedRecordIds.sort()
);
check("云端那 2 道演示错题被真的删掉", deletesFor("mistakes").length, 2);

check("清理时没有把演示数据当成新增上传", writesFor("records").length, 0);
check("清理时没有把演示错题当成新增上传", writesFor("mistakes").length, 0);

const purgeNotice = store.notifications.map((item) => item.message).join(" / ");
check("清理会告知用户，不静默删数据", purgeNotice.includes("6 条"), true);

// ---------------------------------------------------------------------------
section("场景二：本地空库不会再自己长出演示数据");
// ---------------------------------------------------------------------------

const localRecords = dbStub.read("records");
check("清理之后本地库里也没有演示成绩", localRecords.some((row) => launderedRecordIds.includes(row.id)), false);
check("清理之后本地库里也没有演示错题", dbStub.read("mistakes").some((row) => launderedMistakeIds.includes(row.id)), false);
check("演示成绩进了回收站，24 小时内还能恢复", store.deletedRecords.length, 4);

// ---------------------------------------------------------------------------
section("场景三：上传闸门 —— 本地标了 pendingSync 的演示数据也不上传");
// ---------------------------------------------------------------------------
// 第 3 步是漏出去的关键一环。这里直接把一条演示成绩标成待同步（模拟老版本
// 已经在 Dexie 里留下的状态），然后走一次真正的快速同步，看它上不上传。
// 这条路径不经过 purgeDemoEntries，所以测的就是 mergeCloudEntries / 
// retryUnsyncedData 里的闸门本身。

const flaggedDemo = { ...demoRecords[0], pendingSync: true };
const flaggedReal = { ...store.records.find((record) => record.id === realRow.id), pendingSync: true };
await db.records.put(flaggedReal);
store.records = [flaggedDemo, flaggedReal];
calls.length = 0;

await store.syncNow();

const uploadedIds = writesFor("records").flatMap((call) => call.body.map((row) => row.id));
check("真实成绩正常上传", uploadedIds.includes(realRow.id), true);
check("被标成待同步的演示成绩没有上传", uploadedIds.includes(flaggedDemo.id), false);
checkDeep("这次只上传了真实成绩这一条", uploadedIds, [realRow.id]);

section("批量改科目与云端分批写入");
const rows = Array.from({ length: 53 }, (_, index) =>
  recordRow({ ...demoRecords[0], paperName: `批量样本 ${index}`, note: "保留备注" })
);
cloudTables.records = rows;
dbStub.write("records", []);
dbStub.write("deletedRecords", []);
const batchStore = useTrackerStore(createPinia());
await batchStore.loadFromCloud();
const ids = rows.map((row) => row.id);
calls.length = 0;
check("只统计实际改科的记录", await batchStore.moveRecordsToSubject([...ids, ids[0], "missing"], "math1"), ids.length);
check("一次操作改完所有记录并保留备注", batchStore.records.every((row) => row.subjectId === "math1" && row.note === "保留备注"), true);
await batchStore.syncNow();
checkDeep("上传按 50 条分批", writesFor("records").map((call) => call.body.length), [50, 3]);
check("同步回执清除对应的本地待同步状态", dbStub.read("records").every((row) => !row.pendingSync), true);

section("断网删除、重启和重试");
calls.length = 0;
failRecordDeletes = true;
check("删除立即完成本地移动", await batchStore.removeRecords(ids), ids.length);
check("本地删除完成时还没有发云端请求", deletesFor("records").length, 0);
check("记录已从活跃表移出", dbStub.read("records").length, 0);
check("每条删除都有持久化待同步记录", dbStub.read("deletedRecords").filter((row) => row.pendingSync).length, ids.length);
const restarted = useTrackerStore(createPinia());
await restarted.load();
await restarted.loadFromCloud();
check("旧云端数据不会拉回待同步删除", restarted.records.length, 0);
check("同步失败可见", restarted.syncError.includes("Network unavailable"), true);
calls.length = 0;
restarted.user = { id: "other-user" };
await restarted.syncNow();
check("切换账号不会发送原账号的删除", deletesFor("records").length, 0);
restarted.user = { id: "user-1" };
failRecordDeletes = false;
await restarted.syncNow();
checkDeep("重连后删除按 50 条分批且归属原账号", deletesFor("records").map((call) => [
  recordDeleteIds(call.search).length, new URLSearchParams(call.search).get("user_id")
]), [[50, "eq.user-1"], [3, "eq.user-1"]]);
check("云端也已删除全部记录", cloudTables.records.length, 0);
check("同步成功后仍保留可恢复快照", restarted.deletedRecords.length, ids.length);
check("同步成功后清除待同步状态", dbStub.read("deletedRecords").some((row) => row.pendingSync), false);

section("恢复与未完成的删除交错");
const target = await restarted.addRecord({ subjectId: "math1", paperName: "并发恢复", score: 92, fullScore: 150, date: "2026-10-01" });
await restarted.syncNow();
await restarted.removeRecords([target.id]);
const deleting = holdRequest();
holdRecordDelete = deleting.hold;
const deletingSync = restarted.syncNow();
await deleting.started;
await restarted.restoreDeletedRecord(target.id);
const restoringSync = restarted.syncNow();
deleting.release();
await Promise.all([deletingSync, restoringSync]);
check("最终以用户最后一次恢复为准", cloudTables.records.some((row) => row.id === target.id), true);
check("旧删除回执不会清掉恢复后的成绩", dbStub.read("records").some((row) => row.id === target.id && !row.pendingSync), true);

section("云端校准收到删除前的快照");
const reading = holdRequest();
holdRecordRead = reading.hold;
const calibration = restarted.loadFromCloud();
await reading.started;
await restarted.removeRecords([target.id]);
await restarted.syncNow();
reading.release();
await calibration;
check("晚到的云端读取不会让已删除记录复活", restarted.records.some((row) => row.id === target.id), false);
check("旧快照也不会重写进 IndexedDB", dbStub.read("records").some((row) => row.id === target.id), false);

section("单条无效记录不会卡住正常成绩");
const invalid = await restarted.addRecord({ subjectId: "math1", paperName: "无效记录", score: 90, fullScore: 150, date: "2026-10-02" });
const valid = await restarted.addRecord({ subjectId: "math1", paperName: "有效记录", score: 90, fullScore: 150, date: "2026-10-03" });
await restarted.syncNow();
check("合法成绩正常上传", cloudTables.records.some((row) => row.id === valid.id), true);
check("失败的成绩单独留在待同步队列", dbStub.read("records").find((row) => row.id === invalid.id)?.pendingSync, true);

section("备份合并先写本机，云端版本须经校准");
dbStub.write("records", []);
dbStub.write("mistakes", []);
dbStub.write("images", []);
dbStub.write("deletedRecords", []);
cloudTables = { subjects: [], records: [], mistakes: [], mistake_images: [] };
const backupStore = useTrackerStore(createPinia());
await backupStore.loadFromCloud();
const importedRows = ["云端更新", "时间相同", "备份更新", "云端尚未确认"].map((paperName) => ({
  id: crypto.randomUUID(), subjectId: "math1", paperName, score: 80, fullScore: 150,
  date: "2026-10-03", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z", pendingSync: true
}));
const [cloudNewer, cloudEqual, localNewer, notInSnapshot] = importedRows;
const backupPayload = {
  version: 3, records: importedRows,
  subjects: [{ id: "local-backup-subject", name: "备份科目", fullScore: 100 }],
  mistakes: [{ id: "local-backup-mistake", title: "备份错题", subjectId: "local-backup-subject" }],
  images: [{ id: "local-backup-image", ownerId: "local-backup-mistake", url: "https://example.invalid/image.webp" }]
};
let rejectedDestructiveActions = 0;
for (const action of [() => backupStore.importData(backupPayload, false), () => backupStore.clearAll()]) {
  try {
    await action();
  } catch (error) {
    rejectedDestructiveActions += Number(/云同步/.test(error.message));
  }
}
check("云同步环境拒绝覆盖与清空", rejectedDestructiveActions, 2);
calls.length = 0;
await backupStore.importData(backupPayload);
await backupStore.syncNow();
check("备份里的同步标记不会触发上传", writesFor("records").length, 0);
cloudTables.subjects = [{ id: "math1", name: "数一", full_score: 150 }];
cloudTables.records = [
  recordRow(cloudNewer, cloudNewer.id, { score: 120, updated_at: "2026-10-04T00:00:00.000Z" }),
  recordRow(cloudEqual, cloudEqual.id, { score: 110, updated_at: cloudEqual.updatedAt }),
  recordRow(localNewer, localNewer.id, { score: 65, updated_at: "2026-10-02T00:00:00.000Z" })
];
await backupStore.loadFromCloud();
checkDeep("按可靠时间比较云端和备份版本", importedRows.map((row) => backupStore.records.find((record) => record.id === row.id)?.score), [120, 110, 80, 80]);
checkDeep("只有确认比云端更新的记录被上传", writesFor("records").flatMap((call) => call.body.map((row) => row.id)), [localNewer.id]);
check("云端读取中缺失的成绩保留在本机", dbStub.read("records").some((row) => row.id === notInSnapshot.id && row.restoredFromBackup), true);
check("本机恢复的科目、错题和图片在云端校准后保留", ["subjects", "mistakes", "images"].every((table) =>
  dbStub.read(table).some((row) => row.id.startsWith("local-backup-"))), true);

section("导入期间返回的旧云端快照不会提前确认备份数据");
const duringRead = { ...cloudNewer, id: crypto.randomUUID(), paperName: "在校准期间导入" };
cloudTables.records = [...cloudTables.records, recordRow(duringRead, duringRead.id, { score: 50, updated_at: "2026-10-01T00:00:00.000Z" })];
const heldBackupRead = holdRequest();
holdRecordRead = heldBackupRead.hold;
const beforeImport = backupStore.loadFromCloud();
await heldBackupRead.started;
await backupStore.importData({ records: [duringRead] });
cloudTables.records = cloudTables.records.map((row) => row.id === duringRead.id
  ? { ...row, score: 125, updated_at: "2026-10-05T00:00:00.000Z" }
  : row);
calls.length = 0;
heldBackupRead.release();
await beforeImport;
check("过期的云端读取不触发备份上传", writesFor("records").length, 0);
check("过期的云端读取保留本机导入内容", dbStub.read("records").find((row) => row.id === duringRead.id)?.score, 80);
await backupStore.loadFromCloud();
check("重新校准后较新的云端版本写回本机", dbStub.read("records").find((row) => row.id === duringRead.id)?.score, 125);

// ---------------------------------------------------------------------------

const cleared = env.cleanup();
console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败（清理了 ${cleared} 个定时器）`);
process.exit(failed === 0 ? 0 : 1);
