import Dexie from "dexie";
import { BACKUP_TABLES, BACKUP_VERSION, BackupImportError, backupTimestamp } from "./backup.js";

export const db = new Dexie("exam-tracker-v3");

db.version(1).stores({
  subjects: "id, name",
  records: "id, subjectId, date, createdAt",
  mistakes: "id, subjectId, status, sourceRecordId, createdAt, updatedAt",
  images: "id, ownerType, ownerId, createdAt"
});

db.version(2).stores({ deletedRecords: "id" });

export const defaultSubjects = [
  { id: "math1", name: "数一", fullScore: 150, color: "#177ddc", sortOrder: 0, hidden: false },
  { id: "cs408", name: "408", fullScore: 150, color: "#7a5af8", sortOrder: 1, hidden: false },
  { id: "english1", name: "英一", fullScore: 100, color: "#12b76a", sortOrder: 2, hidden: false },
  { id: "politics", name: "政治", fullScore: 100, color: "#f79009", sortOrder: 3, hidden: false }
];

const subjectBlueprints = new Map(defaultSubjects.map((subject) => [subject.id, { ...subject }]));

export function isDefaultSubject(id) {
  return subjectBlueprints.has(id);
}

export function normalizeSubjects(subjects = []) {
  const merged = new Map(defaultSubjects.map((subject) => [subject.id, { ...subject }]));

  subjects.forEach((subject) => {
    const blueprint = subjectBlueprints.get(subject.id);
    merged.set(subject.id, {
      ...subject,
      sortOrder: Number.isFinite(Number(subject.sortOrder)) ? Number(subject.sortOrder) : blueprint?.sortOrder ?? Number.MAX_SAFE_INTEGER,
      hidden: Boolean(subject.hidden),
      ...(blueprint ? { name: blueprint.name, fullScore: blueprint.fullScore, color: subject.color || blueprint.color } : {})
    });
  });

  return [...merged.values()].sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder) || a.name.localeCompare(b.name, "zh-Hans-CN"));
}

export function createDemoRecords() {
  return [
    sampleRecord("cs408", "408 综合模拟 01", -8, 86, 150, 180, "操作系统和计网选择题丢分明显。"),
    sampleRecord("math1", "数一 模拟 01", -6, 92, 150, 170, "后两道大题节奏偏慢。"),
    sampleRecord("english1", "英一 阅读专项", -4, 68, 100, 70, "阅读细节题需要标定位句。"),
    sampleRecord("politics", "政治 选择题套卷", -2, 63, 100, 60, "马原概念要回炉。")
  ];
}

export function createDemoMistakes() {
  // 难度和创建时间都要给全。之前这两条种子错题既没有 difficulty，
  // createdAt 又都是「当前毫秒」（两条完全相同），结果是：
  //   - 列表里两条都显示「难度未填」，像是应用有数据质量问题；
  //   - 时间戳一样，排序分不出先后，列表顺序每次刷新都可能变。
  // 演示数据应该是「正常用起来的样子」，不是边界情况的样本。
  return [
    sampleMistake("cs408", "进程调度周转时间计算", "操作系统", "concept", "待复盘", -1, "中等"),
    sampleMistake("math1", "二重积分换元边界", "高等数学", "method", "已整理", -3, "困难")
  ];
}

/**
 * 种子数据的「指纹」。
 *
 * 判定只用内容指纹，**不看 id**：老版本用 crypto.randomUUID() 生成 id，
 * 那批已经漏进云端的记录认不出来，得靠内容兜住。而如果拿 id 前缀当标记，
 * 用户改过一条演示数据之后它仍然是「demo-」，就永远不会被同步 ——
 * 改过的数据反而丢了。只看内容就没这个问题：改过就不再算演示数据，
 * 会正常参与同步。
 *
 * 这几条的科目、名称、分数、用时、备注都是写死的常量，真实数据撞不上。
 */
function recordFingerprint(record) {
  return [record.subjectId, record.paperName, record.score, record.fullScore, record.durationMinutes, record.note].join("|");
}

function mistakeFingerprint(mistake) {
  return [mistake.subjectId, mistake.title, mistake.knowledgePoint, mistake.reason].join("|");
}

const DEMO_RECORD_FINGERPRINTS = new Set(createDemoRecords().map(recordFingerprint));
const DEMO_MISTAKE_FINGERPRINTS = new Set(createDemoMistakes().map(mistakeFingerprint));

export function isDemoRecord(record) {
  return Boolean(record) && DEMO_RECORD_FINGERPRINTS.has(recordFingerprint(record));
}

export function isDemoMistake(mistake) {
  return Boolean(mistake) && DEMO_MISTAKE_FINGERPRINTS.has(mistakeFingerprint(mistake));
}

const DEMO_SEEDED_KEY = "exam-tracker-demo-seeded";

function hasSeededDemo() {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(DEMO_SEEDED_KEY) === "1";
  } catch {
    return false;
  }
}

function markDemoSeeded() {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(DEMO_SEEDED_KEY, "1");
  } catch {
    /* 存不进去就退化成「空库时还可能再种一次」，不影响主流程 */
  }
}

/**
 * 补齐默认科目，并在明确允许时灌一次演示数据。
 *
 * 演示数据以前是**无条件**灌的：只要 records / mistakes 表为空就写 4 条成绩
 * 加 2 道错题。后果是它会被同步当成「本地新增」上传到云端，从此每台设备、
 * 每次同步都会把它拉回来 —— 用户看到的就是「几条自己从没记过的成绩」。
 * 所以现在改成三条约束：
 *   1. 默认**不灌**，seedDemo 由调用方显式开启（只在纯本地模式开）；
 *   2. 只在 records 和 mistakes **都**为空时灌 —— 以前各自独立判断，
 *      把错题删光也会被重新塞两道进来；
 *   3. 灌过一次就不再灌，否则用户删掉之后下次空库又冒出来。
 */
export async function seedIfEmpty({ seedDemo = false } = {}) {
  const subjectCount = await db.subjects.count();
  if (!subjectCount) {
    await db.subjects.bulkPut(defaultSubjects);
  } else {
    await db.subjects.bulkPut(normalizeSubjects(await db.subjects.toArray()));
  }

  if (!seedDemo || hasSeededDemo()) return;

  const recordCount = await db.records.count();
  const mistakeCount = await db.mistakes.count();
  if (recordCount || mistakeCount) return;

  await db.records.bulkPut(createDemoRecords());
  await db.mistakes.bulkPut(createDemoMistakes());
  markDemoSeeded();
}

export async function loadAllData(options = {}) {
  // Dexie 首次打开失败后会记住失败状态，用户重试时需要显式再次打开。
  await db.open();
  await seedIfEmpty(options);
  return readLocalData();
}

export async function readLocalData() {
  return db.transaction("r", db.subjects, db.records, db.mistakes, db.images, async () => {
    const [subjects, records, mistakes, images] = await Promise.all(BACKUP_TABLES.map((table) => db[table].toArray()));
    return { subjects: normalizeSubjects(subjects), records, mistakes, images };
  });
}

export async function replaceAllData(payload) {
  await db.transaction("rw", db.subjects, db.records, db.mistakes, db.images, async () => {
    await Promise.all([db.subjects.clear(), db.records.clear(), db.mistakes.clear(), db.images.clear()]);
    await db.subjects.bulkPut(normalizeSubjects(toPlainEntries(payload.subjects || defaultSubjects)));
    await db.records.bulkPut(toPlainEntries(payload.records || []));
    await db.mistakes.bulkPut(toPlainEntries(payload.mistakes || []));
    await db.images.bulkPut(toPlainEntries(payload.images || []));
  });
}

export async function addImages(ownerType, ownerId, files) {
  const entries = await Promise.all(
    [...files].map(async (file) => ({
      id: crypto.randomUUID(),
      ownerType,
      ownerId,
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      blob: file,
      createdAt: new Date().toISOString()
    }))
  );

  if (entries.length) {
    await db.images.bulkPut(entries);
  }

  return entries;
}

export async function addImageEntries(entries) {
  if (entries.length) {
    await db.images.bulkPut(toPlainEntries(entries));
  }
  return entries;
}

export async function exportPortableData() {
  const data = await readLocalData();
  const images = await Promise.all(
    data.images.map(async ({ restoredFromBackup, pendingUpload, uploadError, ...image }) => ({
      ...image, blob: image.blob ? await blobToDataUrl(image.blob) : null
    }))
  );
  const withoutLocalState = (rows) => rows.map(({ restoredFromBackup, pendingSync, ...row }) => row);
  return {
    subjects: withoutLocalState(data.subjects),
    records: withoutLocalState(data.records),
    mistakes: withoutLocalState(data.mistakes),
    images,
    exportedAt: new Date().toISOString(),
    version: BACKUP_VERSION
  };
}

function backupTables() {
  return [...BACKUP_TABLES.map((table) => db[table]), db.deletedRecords];
}

export function previewPortableImport(backup, options = {}) {
  return db.transaction("r", ...backupTables(), async () => {
    const { summary } = await planPortableImport(backup, options);
    return summary;
  });
}

export async function importPortableData(backup, options = {}) {
  const { merge = true, allowPartial = false, expectedRevision, expectedRestoration, expectedInvalid } = options;
  const result = await db.transaction("rw", ...backupTables(), async () => {
    const { summary, writes, restoredIds, trash } = await planPortableImport(backup, options);
    if (!merge && expectedRevision !== undefined && expectedRevision !== summary.revision) {
      throw new BackupImportError("预览后，本机数据发生了变化。请重新核对覆盖范围。", "STALE_PREVIEW");
    }
    if ((expectedRestoration !== undefined && expectedRestoration !== summary.restorationRevision) ||
      (expectedInvalid !== undefined && summary.invalid > expectedInvalid)) {
      throw new BackupImportError("预览后，可恢复或需跳过的数据发生了变化。请重新确认。", "STALE_PREVIEW");
    }
    if (summary.blockingMessage) throw new BackupImportError(summary.blockingMessage);
    if (summary.invalid && !allowPartial) throw new BackupImportError("请确认跳过无效条目后再合并。");

    if (!merge) {
      await replaceAllData(writes);
      await dropTrashSnapshots(trash, restoredIds);
    } else {
      for (const table of BACKUP_TABLES) {
        if (writes[table].length) await db[table].bulkPut(writes[table]);
      }
      if (restoredIds.size) await db.deletedRecords.bulkDelete([...restoredIds]);
    }
    return summary;
  });
  if (!merge) markDemoSeeded();
  return result;
}

export async function clearLocalArchive() {
  const pending = await db.transaction("rw", db.records, db.mistakes, db.images, db.deletedRecords, async () => {
    const trash = await db.deletedRecords.toArray();
    await Promise.all([db.records.clear(), db.mistakes.clear(), db.images.clear()]);
    return dropTrashSnapshots(trash, new Set());
  });
  markDemoSeeded();
  return pending;
}

async function dropTrashSnapshots(trash, restoredIds) {
  // 删除仍需送达云端时，保留身份、版本和回执所需的信息，清掉可恢复的内容。
  const pending = trash.filter((entry) => entry.pendingSync && !restoredIds.has(entry.id))
    .map((entry) => ({ ...entry, record: null }));
  await db.deletedRecords.clear();
  if (pending.length) await db.deletedRecords.bulkPut(pending);
  return pending;
}

async function planPortableImport(backup, { merge = true, restoreDeleted = false, userId, cloudConfigured = false } = {}) {
  const { data, rejected, issues } = backup;
  const complete = BACKUP_TABLES.every((table) => Object.hasOwn(data, table));
  if (!merge && !complete) throw new BackupImportError("覆盖恢复需要包含科目、成绩、错题和图片的完整备份。");
  if (!merge && issues.length) throw new BackupImportError(`覆盖恢复要求每条数据有效。${issues[0]}`);

  const imageOwnerIds = (data.images || []).map((image) => image.ownerId);
  const reads = BACKUP_TABLES.map((table) => {
    if (!merge) return db[table].toArray();
    const ids = (data[table] || []).map((row) => row.id);
    if (table === "mistakes") ids.push(...imageOwnerIds);
    return db[table].bulkGet([...new Set(ids)]).then((rows) => rows.filter(Boolean));
  });
  const [existingRows, trash] = await Promise.all([
    Promise.all(reads),
    merge ? db.deletedRecords.bulkGet((data.records || []).map((row) => row.id)).then((rows) => rows.filter(Boolean))
      : db.deletedRecords.toArray()
  ]);
  const trashById = new Map(trash.map((entry) => [entry.id, entry]));
  const existingByTable = Object.fromEntries(BACKUP_TABLES.map((table, index) => [table, existingRows[index]]));
  const restoredIds = new Set();
  const writes = {};
  const tables = {};
  const details = [...issues];
  let blockedDeleted = 0;
  const mistakeIds = new Set(merge ? existingByTable.mistakes.map((row) => row.id) : []);

  for (const table of BACKUP_TABLES) {
    const existing = new Map(existingByTable[table].map((row) => [row.id, row]));
    const stats = { added: 0, updated: 0, skipped: 0, invalid: rejected[table] || 0,
      deleted: 0, restorable: 0, restored: 0, remoteOnly: 0, current: merge ? null : existing.size };
    writes[table] = [];
    tables[table] = stats;
    for (const row of data[table] || []) {
      if (table === "images" && !mistakeIds.has(row.ownerId)) {
        stats.invalid += 1;
        if (details.length < 5) details.push("有图片找不到关联的错题。");
        continue;
      }
      const local = existing.get(row.id);
      if (merge && local && !canUpdateFromBackup(table, local, row)) {
        stats.skipped += 1;
        continue;
      }
      const deleted = table === "records" ? trashById.get(row.id) : undefined;
      if (deleted) {
        const canRestore = !deleted.userId || deleted.userId === userId;
        if (canRestore) stats.restorable += 1;
        if (!canRestore || !restoreDeleted) {
          stats.deleted += 1;
          stats.skipped += 1;
          blockedDeleted += Number(!canRestore);
          continue;
        }
        stats.restored += 1;
        restoredIds.add(row.id);
      }
      if (table === "mistakes") mistakeIds.add(row.id);
      if (table === "images" && !row.blob) stats.remoteOnly += 1;
      stats[merge && local ? "updated" : "added"] += 1;
      const next = { ...row };
      if (cloudConfigured) next.restoredFromBackup = true;
      if (deleted?.userId && deleted.userId === userId) {
        // 恢复是一次新的显式操作，上传要排在同一账号已发出的删除之后。
        next.pendingSync = true;
        next.updatedAt = new Date().toISOString();
      }
      writes[table].push(next);
    }
  }
  const totals = Object.values(tables);
  const count = (key) => totals.reduce((sum, table) => sum + table[key], 0);
  let blockingMessage = "";
  if (!merge && count("invalid")) blockingMessage = "覆盖恢复要求每条数据有效，当前备份里有图片缺少关联错题。";
  else if (!merge && blockedDeleted) blockingMessage = "备份包含其他账号尚有删除记录的成绩，无法覆盖恢复。";
  else if (!merge && count("deleted")) blockingMessage = "请先确认恢复备份中曾删除的成绩。";
  else if (merge && !count("added") && !count("updated") && !count("skipped") && count("invalid")) {
    blockingMessage = "备份里没有可导入的有效条目。";
  }
  const summary = {
    tables, details, blockingMessage,
    added: count("added"), updated: count("updated"), skipped: count("skipped") + count("invalid"),
    invalid: count("invalid"), restored: count("restored"), restorable: count("restorable"),
    remoteOnly: count("remoteOnly"),
    restorationRevision: JSON.stringify([...restoredIds].map((id) => [id, trashById.get(id).operationId || trashById.get(id).deletedAt])),
    revision: merge ? null : JSON.stringify([existingRows, trash], (_key, value) =>
      value instanceof Blob ? { size: value.size, type: value.type } : value)
  };
  return { summary, writes, restoredIds, trash };
}

function canUpdateFromBackup(table, local, incoming) {
  if (table !== "records" && table !== "mistakes") return false;
  const current = backupTimestamp(local);
  const next = backupTimestamp(incoming);
  return current !== null && next !== null && next > current;
}

function sampleRecord(subjectId, paperName, daysAgo, score, fullScore, durationMinutes, note, paperVariant = "") {
  const date = new Date();
  date.setDate(date.getDate() + daysAgo);
  return {
    id: `demo-record-${subjectId}`,
    subjectId,
    paperName,
    paperVariant,
    score,
    fullScore,
    durationMinutes,
    date: date.toISOString().slice(0, 10),
    note,
    createdAt: date.toISOString()
  };
}

function sampleMistake(subjectId, title, knowledgePoint, reason, status, daysAgo, difficulty) {
  // 创建时间用「几天前」，和 sampleRecord 一样 —— 真实数据本来就有先后，
  // 两条种子错题都取当前毫秒的话时间戳会完全相同，排序只能靠 id 兜底。
  const created = new Date();
  created.setDate(created.getDate() + daysAgo);
  const now = created.toISOString();
  return {
    id: `demo-mistake-${subjectId}`,
    subjectId,
    title,
    knowledgePoint,
    reason,
    difficulty,
    status,
    sourceRecordId: "",
    questionText: "",
    analysis: "先把题目截图或关键步骤补进来，复盘时再完善解析。",
    nextReviewAt: "",
    createdAt: now,
    updatedAt: now
  };
}

function toPlainEntries(entries) {
  return entries.map((entry) => {
    const plain = {};
    Object.entries(entry || {}).forEach(([key, value]) => {
      if (value !== undefined) {
        plain[key] = value;
      }
    });
    return plain;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
