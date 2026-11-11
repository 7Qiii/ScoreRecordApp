import assert from "node:assert/strict";
import { installBrowserEnv, stubDatabase } from "./lib/browser-env.mjs";

const env = installBrowserEnv();
const { db, clearLocalArchive, importPortableData, previewPortableImport } = await import("../src/services/storage.js");
const { inspectBackupPayload, backupTimestamp } = await import("../src/services/backup.js");
const mock = stubDatabase(db);
const timestamp = (day) => `2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z`;
const score = (id, value, day = 10, fields = {}) => ({
  id, subjectId: "math1", paperName: "复习卷", date: "2026-09-10", createdAt: timestamp(1),
  updatedAt: timestamp(day), score: value, fullScore: 150, ...fields
});
const snapshot = (fields = {}) => ({ version: 3, subjects: [], records: [], mistakes: [], images: [], ...fields });
const importBackup = (payload, options) => importPortableData(inspectBackupPayload(payload), options);
const preview = (payload, options) => previewPortableImport(inspectBackupPayload(payload), options);

assert.throws(() => inspectBackupPayload({}), /没有可识别/);
assert.throws(() => inspectBackupPayload({ records: {} }), /成绩.*数组/);
assert.throws(() => inspectBackupPayload({ subjects: "x" }), /科目.*数组/);
assert.throws(() => inspectBackupPayload(snapshot({ version: 4 })), /版本暂不支持/);
assert.throws(() => inspectBackupPayload({ records: [score("dup", 1), score("dup", 2)] }), /ID.*重复/);
assert.equal(backupTimestamp(score("invalid", 88, 10, { updatedAt: "2026-02-31" })), null);
assert.equal(backupTimestamp(score("local-time", 88, 10, { updatedAt: "2026-09-10T10:00:00" })), null);
assert.equal(backupTimestamp(score("offset-time", 88, 10, { updatedAt: "2026-09-10T18:00:00.000001+08:00" })), Date.parse(timestamp(10)));
assert.equal(backupTimestamp(score("missing", 88, 10, { updatedAt: "" })), Date.parse(timestamp(1)));
const legacy = inspectBackupPayload({ records: [score("legacy", "0", 10, { fullScore: "0", durationMinutes: "" })] });
assert.equal(legacy.version, null);
assert.equal(legacy.data.records[0].score, 0);
assert.equal(legacy.data.records[0].fullScore, 0);
assert.equal(legacy.data.records[0].durationMinutes, "");
console.log("PASS format, compatibility, duplicate IDs and timestamp validation");

mock.write("subjects", [{ id: "math1", name: "数一", fullScore: 150, hidden: true, sortOrder: 9 }]);
mock.write("records", [score("old", 120, 20), score("newer", 40, 1), score("equal", 112, 10), score("bad-time", 108, 10, { updatedAt: "unknown" })]);
const combined = {
  records: [
    score("old", 88, 5), score("newer", 90), score("equal", 55), score("bad-time", 30),
    score("new", 101, 10, { pendingSync: true, restoredFromBackup: true, readingParts: [5, 0, null, 4], note: "笔记" }),
    { subjectId: "math1" }, score("bad-number", "abc"), "坏行"
  ]
};
const estimated = await preview(combined);
assert.deepEqual([estimated.added, estimated.updated, estimated.skipped, estimated.invalid], [1, 1, 6, 3]);
await assert.rejects(importBackup(combined), /确认跳过/);
assert.equal(mock.read("records").length, 4);
const result = await importBackup(combined, { allowPartial: true });
assert.deepEqual([result.added, result.updated, result.skipped], [1, 1, 6]);
const actual = new Map(mock.read("records").map((row) => [row.id, row]));
assert.deepEqual(["old", "newer", "equal", "bad-time", "new"].map((id) => actual.get(id).score), [120, 90, 112, 108, 101]);
assert.equal(actual.get("new").pendingSync, undefined);
assert.equal(actual.get("new").restoredFromBackup, undefined);
assert.deepEqual(actual.get("new").readingParts, [5, 0, null, 4]);
assert.equal(actual.get("new").note, "笔记");
assert.equal(mock.read("subjects")[0].sortOrder, 9);
assert.equal(mock.read("subjects")[0].hidden, true);
assert.equal((await importBackup(combined, { allowPartial: true })).skipped, 8);
console.log("PASS explicit partial import, no rollback, subject preferences and idempotency");

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI9kAAAAASUVORK5CYII=";
const mistake = { id: "mistake", title: "积分复盘", subjectId: "math1" };
const images = [
  { id: "blob", ownerId: "mistake", ownerType: "mistake", blob: png, pendingUpload: true, uploadError: "旧设备" },
  { id: "remote", ownerId: "mistake", blob: null, url: "https://example.invalid/image.png" },
  { id: "fetch", ownerId: "mistake", blob: "https://example.invalid/image.png" },
  { id: "garbage", ownerId: "mistake", blob: "data:image/png;base64,YWJj" },
  { id: "orphan", ownerId: "missing", blob: png }
];
const savedFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("Backup import must not fetch a URL"); };
try {
  const imageResult = await importBackup({ mistakes: [mistake], images }, { allowPartial: true });
  assert.deepEqual([imageResult.added, imageResult.invalid, imageResult.remoteOnly], [3, 3, 1]);
  const stored = mock.read("images").find((row) => row.id === "blob");
  assert.equal(stored.blob.type, "image/png");
  assert.equal(stored.pendingUpload, undefined);
  assert.equal(stored.uploadError, undefined);
} finally {
  globalThis.fetch = savedFetch;
}
console.log("PASS offline image decoding, malformed data, missing owner and remote-only preview");

const deleted = { id: "trash", userId: "owner", operationId: "op", deletedAt: timestamp(12), pendingSync: true, record: score("trash", 100) };
mock.write("deletedRecords", [deleted]);
const recovery = { records: [score("trash", 91)] };
assert.equal((await importBackup(recovery, { userId: "owner" })).skipped, 1);
assert.equal((await importBackup(recovery, { userId: "other", restoreDeleted: true })).skipped, 1);
assert.equal(mock.read("deletedRecords").length, 1);
const pendingPreview = await preview(recovery, { userId: "owner", restoreDeleted: true });
mock.write("deletedRecords", [{ ...deleted, operationId: "new-op" }]);
await assert.rejects(importBackup(recovery, {
  userId: "owner", restoreDeleted: true, expectedRestoration: pendingPreview.restorationRevision
}), (error) => error.code === "STALE_PREVIEW");
assert.equal(mock.read("deletedRecords").length, 1);
const restored = await importBackup(recovery, { userId: "owner", restoreDeleted: true });
assert.equal(restored.restored, 1);
assert.equal(mock.read("records").find((row) => row.id === "trash").pendingSync, true);
assert.equal(mock.read("deletedRecords").length, 0);
console.log("PASS default skip, explicit account-scoped recovery and stale deletion protection");

const replace = snapshot({ records: [score("replacement", 105)] });
await assert.rejects(importBackup({ subjects: [] }, { merge: false }), /完整备份/);
await assert.rejects(importBackup(snapshot({ records: [{ id: "invalid" }] }), { merge: false }), /每条数据有效/);
const replacePreview = await preview(replace, { merge: false });
await db.records.put(score("late-edit", 110));
await assert.rejects(importBackup(replace, { merge: false, expectedRevision: replacePreview.revision }), (error) => error.code === "STALE_PREVIEW");
assert.equal(mock.read("records").some((row) => row.id === "late-edit"), true);
await importBackup(replace, { merge: false });
assert.deepEqual(mock.read("records").map((row) => row.id), ["replacement"]);
mock.write("deletedRecords", [deleted, { ...deleted, id: "done", pendingSync: false }]);
await clearLocalArchive();
assert.equal(mock.read("records").length, 0);
assert.equal(mock.read("subjects").length, 4);
assert.deepEqual(mock.read("deletedRecords"), [{ ...deleted, record: null }]);
env.cleanup();
console.log("PASS full snapshot guard, stale overwrite confirmation and safe local clear");
