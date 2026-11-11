import { defineStore } from "pinia";
import { computed, ref, toRaw } from "vue";
import {
  addImageEntries,
  clearLocalArchive,
  db,
  exportPortableData,
  importPortableData,
  isDemoMistake,
  isDemoRecord,
  loadAllData,
  normalizeSubjects,
  previewPortableImport,
  readLocalData,
  replaceAllData
} from "../services/storage";
import { BackupImportError, backupTimestamp, inspectBackupPayload } from "../services/backup";
import { compressImage } from "../services/imageTools";
import { compareByTimeThenId } from "../utils/sorting";
import { appendNoteMeta, normalizeReadingParts, readingPartsFromRecord, recordTitle, stripNoteMeta } from "../utils/recordDisplay";
import { uploadMistakeImage } from "../services/r2";
import {
  deleteMistakeCloud,
  deleteMistakeImageCloud,
  deleteRecordsCloud,
  deleteSubjectCloud,
  getSession,
  isSupabaseConfigured,
  isSupabaseProxyEnabled,
  loadCloudData,
  onAuthStateChange,
  signInWithPassword,
  signOut,
  signUpWithPassword,
  subscribeCloudChanges,
  supabase,
  upsertMistake,
  upsertMistakeImage,
  upsertRecords,
  upsertSubject
} from "../services/supabase";

const FALLBACK_SYNC_INTERVAL = 5 * 60 * 1000;
const ACTIVE_FALLBACK_THROTTLE = 60 * 1000;
const CLOUD_CALIBRATION_INTERVAL = 24 * 60 * 60 * 1000;
const COMPOSITE_NOTE_META_PREFIX = "\n\n<!-- exam-tracker-composite:";
const COMPOSITE_NOTE_META_SUFFIX = " -->";
const RECORD_TRASH_KEY = "exam-tracker-deleted-records";
const RECORD_TRASH_TTL = 24 * 60 * 60 * 1000;
const RECORD_SYNC_BATCH_SIZE = 50;

export const useTrackerStore = defineStore("tracker", () => {
  const subjects = ref([]);
  const records = ref([]);
  const deletedRecords = ref([]);
  const mistakes = ref([]);
  const images = ref([]);
  const isReady = ref(false);
  const user = ref(null);
  const syncMode = ref(isSupabaseConfigured ? "cloud-ready" : "local");
  const syncError = ref("");
  const isSyncing = ref(false);
  const lastSyncedAt = ref("");
  const realtimeStatus = ref("idle");
  const realtimeError = ref("");
  const notifications = ref([]);
  const deviceId = ref(getOrCreateDeviceId());
  const deviceName = ref(getDeviceName());
  const lastBackupAt = ref(readLocalValue("exam-tracker-last-backup", ""));
  let lastCloudSignature = "";
  let cloudLoadPromise = null;
  let autoSyncTimer = null;
  let autoSyncStarted = false;
  let lastAutoSyncAt = 0;
  let pendingFallbackTimer = null;
  let cloudCalibrationTimer = null;
  let unsubscribeRealtime = null;
  let realtimeReconnectTimer = null;
  let recordWrites = Promise.resolve();
  let recordSyncPromise = null;
  let recordSyncRequested = false;
  let recordSyncError = "";
  let backupImportRevision = 0;

  const subjectMap = computed(() => new Map(subjects.value.map((subject) => [subject.id, subject])));
  const recordMap = computed(() => new Map(records.value.map((record) => [record.id, record])));
  const deletedRecordMap = computed(() => new Map(deletedRecords.value.map((entry) => [entry.id, entry])));
  const visibleSubjects = computed(() => subjects.value.filter((subject) => !subject.hidden));
  const canReplaceBackup = !isSupabaseConfigured;
  const restorableDeletedRecords = computed(() => deletedRecords.value.filter(canRestoreDeletedRecord));
  const imageStorageStats = computed(() => {
    const totalBytes = images.value.reduce((sum, image) => sum + Number(image.size || image.blob?.size || 0), 0);
    const cloudCount = images.value.filter((image) => image.url || image.storageKey).length;
    return {
      count: images.value.length,
      cloudCount,
      totalBytes,
      label: formatBytes(totalBytes)
    };
  });
  const pendingImages = computed(() => images.value.filter((image) => image.pendingUpload));
  const failedImages = computed(() => images.value.filter((image) => image.uploadError));
  const autoSyncState = computed(() => {
    if (!user.value) return "未登录";
    if (!isSupabaseConfigured) return "本地模式";
    if (isSupabaseProxyEnabled) return "兼容同步已开启";
    if (realtimeStatus.value === "connected") return "实时同步已连接";
    if (realtimeStatus.value === "connecting") return "实时同步连接中";
    if (realtimeStatus.value === "error") return "实时同步异常，快速兜底中";
    return autoSyncStarted ? "后台同步已开启" : "同步待启动";
  });

  async function load() {
    syncError.value = "";
    // 只有纯本地模式才灌演示数据。
    // 云端模式下用户的数据在云上，本地灌进去的假数据会被同步当成「本地新增」
    // 上传，从此每台设备每次同步都拉回来 —— 就是用户看到的「从没记过的成绩」。
    await reloadLocalData({ seedDemo: !isSupabaseConfigured });
    syncMode.value = isSupabaseConfigured ? "signed-out" : "local";
    isReady.value = true;
    subscribeAuth();

    if (isSupabaseConfigured) {
      try {
        const session = await getSession();
        user.value = session?.user || null;
        if (user.value) startCloudSync();
      } catch {
        syncError.value = "本机档案已读取，暂时无法确认云端登录状态。";
      }
    }
  }

  let unsubscribeAuth = null;

  function subscribeAuth() {
    if (unsubscribeAuth || !isSupabaseConfigured) return;
    unsubscribeAuth = onAuthStateChange(async (session, event) => {
      if (event === "INITIAL_SESSION") return;
      user.value = session?.user || null;
      if (user.value) {
        startCloudSync();
      } else {
        stopAutoSync();
        await reloadLocalData();
        syncMode.value = "signed-out";
      }
    });
  }

  function writeRecordChanges(action) {
    const result = recordWrites.then(action);
    recordWrites = result.catch(() => {});
    return result;
  }

  function reloadLocalData(options) {
    return writeRecordChanges(async () => {
      await applyLocalSnapshot(loadAllData(options));
    });
  }

  async function applyLocalSnapshot(dataPromise) {
    const [data, trash] = await Promise.all([dataPromise, loadDeletedRecords()]);
    subjects.value = data.subjects;
    records.value = data.records;
    deletedRecords.value = trash;
    mistakes.value = data.mistakes;
    images.value = data.images;
  }

  async function loadFromCloud() {
    if (cloudLoadPromise) return cloudLoadPromise;
    cloudLoadPromise = runCloudLoad();
    try {
      return await cloudLoadPromise;
    } finally {
      cloudLoadPromise = null;
    }
  }

  async function runCloudLoad() {
    isSyncing.value = true;
    const startedAt = Date.now();
    const sessionUserId = user.value?.id;
    const requestedBackupRevision = backupImportRevision;
    try {
      const data = await loadCloudData();
      if (!data) return;
      const demoMistakeIds = await writeRecordChanges(async () => {
        if (user.value?.id !== sessionUserId && user.value?.id !== data.user.id) return null;
        user.value = data.user;
        const reconcileRestored = requestedBackupRevision === backupImportRevision;
        const cloudRecords = data.records.filter((record) => {
          const entry = deletedRecordMap.value.get(record.id);
          return entry?.userId !== data.user.id || (!entry.pendingSync && entry.syncedAt < startedAt);
        });
        const cloudSubjects = new Map(data.subjects.map((subject) => [subject.id, subject]));
        for (const subject of subjects.value) {
          if (subject.restoredFromBackup && (!reconcileRestored || !cloudSubjects.has(subject.id))) cloudSubjects.set(subject.id, subject);
        }
        subjects.value = normalizeSubjects(data.subjects.length ? [...cloudSubjects.values()] : subjects.value);
        records.value = mergeCloudEntries(cloudRecords, records.value, isSameRecord, isDemoRecord, reconcileRestored);
        mistakes.value = mergeCloudEntries(data.mistakes, mistakes.value, isSameMistake, isDemoMistake, reconcileRestored);
        images.value = mergeCloudImages(data.images, reconcileRestored);
        markSyncHeartbeat();
        const removedMistakeIds = await purgeDemoEntries();
        const payload = { subjects: subjects.value, records: records.value, mistakes: mistakes.value, images: images.value };
        const signature = dataSignature(payload);
        if (signature !== lastCloudSignature) {
          await replaceAllData(payload);
          lastCloudSignature = signature;
        }
        return removedMistakeIds;
      });
      if (demoMistakeIds && user.value?.id === data.user.id) {
        await Promise.all(demoMistakeIds.map((id) => safeCloud(() => deleteMistakeCloud(id))));
        await retryUnsyncedData();
      }
    } finally {
      isSyncing.value = false;
    }
  }

  async function syncNow() {
    if (!user.value || !supabase) {
      throw new Error("请先登录账号后再同步。");
    }
    syncError.value = "";
    await syncPendingQueues(true);
    if (syncError.value) notify("部分更改等待同步，恢复网络后会重试。", "error", 5200);
    else notify("快速同步已完成。", "success");
  }

  async function calibrateCloud() {
    if (!user.value || !supabase) {
      throw new Error("请先登录账号后再校准云端数据。");
    }
    syncError.value = "";
    await loadFromCloud();
    writeLocalValue(cloudCalibrationKey(), String(Date.now()));
    notify("云端校准已完成。", "success");
  }

  function markBackupExported() {
    lastBackupAt.value = new Date().toISOString();
    writeLocalValue("exam-tracker-last-backup", lastBackupAt.value);
    notify("备份时间已记录。", "success");
  }

  async function login(email, password) {
    const session = await signInWithPassword(email, password);
    user.value = session?.user || null;
    startCloudSync();
  }

  async function register(email, password) {
    const session = await signUpWithPassword(email, password);
    user.value = session?.user || null;
    if (user.value) {
      startCloudSync();
      await seedCloudDefaults();
      await syncPendingQueues(true);
    }
  }

  async function logout() {
    await signOut();
    user.value = null;
    syncMode.value = "signed-out";
    stopAutoSync();
  }

  async function seedCloudDefaults() {
    await Promise.all(subjects.value.map((subject) => upsertSubject(subject)));
  }

  function startCloudSync() {
    startAutoSync();
    syncPendingQueues(true);
    scheduleCloudCalibrationIfNeeded();
  }

  async function addRecord(payload) {
    const now = new Date().toISOString();
    const normalized = normalizeRecordPayload(payload);
    const record = {
      id: crypto.randomUUID(),
      ...normalized,
      score: Number(normalized.score),
      fullScore: Number(normalized.fullScore),
      durationMinutes: normalizeDuration(normalized.durationMinutes),
      pendingSync: true,
      createdAt: now,
      updatedAt: now
    };
    await writeRecordChanges(async () => {
      await db.records.put(record);
      records.value.push(record);
    });
    scheduleAutoSync(250, true);
    notify("成绩已保存。", "success");
    return record;
  }

  async function updateRecord(id, patch) {
    const normalized = normalizeRecordPayload(patch);
    const next = {
      ...normalized,
      score: Number(normalized.score),
      fullScore: Number(normalized.fullScore),
      updatedAt: new Date().toISOString()
    };
    if ("durationMinutes" in normalized) {
      next.durationMinutes = normalizeDuration(normalized.durationMinutes);
    }
    next.pendingSync = true;
    const updated = await writeRecordChanges(async () => {
      if (!(await db.records.update(id, next))) return false;
      records.value = records.value.map((record) => (record.id === id ? { ...record, ...next } : record));
      return true;
    });
    if (!updated) return;
    scheduleAutoSync(250, true);
    notify("成绩已更新。", "success");
  }

  async function moveRecordsToSubject(ids, subjectId) {
    if (!subjectMap.value.has(subjectId)) throw new Error("请选择有效的科目。");
    const recordIds = normalizeIdList(ids);
    if (!recordIds.length) return 0;

    const count = await writeRecordChanges(async () => {
      const changed = await db.transaction("rw", db.records, async () => {
        const now = new Date().toISOString();
        const current = await db.records.bulkGet(recordIds);
        const updates = current.filter((record) =>
          record && record.subjectId !== subjectId && record.recordType !== "composite"
        ).map((record) => {
          const convertExercise = subjectId !== "math1" && record.recordType === "exercise";
          const recordType = convertExercise ? "paper" : record.recordType || "paper";
          return {
            ...record,
            subjectId,
            recordType,
            ...(convertExercise ? { paperName: recordTitle(record), exerciseBookName: "", exercisePage: "", exerciseQuestion: "" } : {}),
            paperVariant: subjectId === "math1" && recordType === "paper"
              ? normalizePaperVariant(record.paperVariant, record.paperName)
              : "",
            pendingSync: true,
            updatedAt: now
          };
        });
        if (updates.length) await db.records.bulkPut(updates);
        return updates;
      });
      applyRecordUpdates(changed);
      return changed.length;
    });
    if (count) scheduleAutoSync(250, true);
    return count;
  }

  async function addCompositeRecord(sourceIds, payload = {}) {
    const sourceRecords = sourceIds.map((id) => recordMap.value.get(id)).filter(Boolean);
    if (sourceRecords.length < 2) {
      throw new Error("请至少选择两条成绩进行合成。");
    }
    const subjectId = sourceRecords[0].subjectId;
    if (sourceRecords.some((record) => record.subjectId !== subjectId)) {
      throw new Error("只能合成同一科目的成绩。");
    }
    const rawScore = sourceRecords.reduce((sum, record) => sum + Number(record.score || 0), 0);
    const rawFullScore = sourceRecords.reduce((sum, record) => sum + Number(record.fullScore || 0), 0);
    const durations = sourceRecords.map((record) => normalizeDuration(record.durationMinutes));
    const rawDurationMinutes = durations.every((value) => value !== "") ? durations.reduce((sum, value) => sum + Number(value), 0) : "";
    const score = normalizeOptionalNumber(payload.score, rawScore);
    const fullScore = normalizeOptionalNumber(payload.fullScore, rawFullScore);
    const durationMinutes = normalizeOptionalDuration(payload.durationMinutes, rawDurationMinutes);
    const latestDate = sourceRecords.map((record) => record.date).filter(Boolean).sort().at(-1) || new Date().toISOString().slice(0, 10);
    const title = cleanText(payload.paperName) || buildCompositeRecordName(sourceRecords);
    const compositeSources = buildCompositeSources(sourceRecords, payload.sources);
    const note = attachCompositeMeta(cleanText(payload.note) || `由 ${sourceRecords.map((record) => record.paperName).join("、")} 合成。`, compositeSources);

    return addRecord({
      subjectId,
      recordType: "composite",
      paperName: title,
      score,
      fullScore,
      durationMinutes,
      date: payload.date || latestDate,
      note,
      compositeSourceIds: sourceRecords.map((record) => record.id),
      compositeSources
    });
  }

  async function removeRecord(id) {
    if (await removeRecords([id])) {
      notify("成绩已移入回收站，24 小时内可恢复。", "success", 5200);
    }
  }

  async function removeRecords(ids) {
    const recordIds = normalizeIdList(ids);
    if (!recordIds.length) return 0;
    const userId = user.value?.id;
    const count = await writeRecordChanges(async () => {
      const entries = await db.transaction("rw", db.records, db.deletedRecords, async () => {
        const current = (await db.records.bulkGet(recordIds)).filter(Boolean);
        return persistRecordDeletions(current, userId);
      });
      applyRecordDeletions(entries);
      return entries.length;
    });
    if (count) scheduleAutoSync(250, true);
    return count;
  }

  async function restoreDeletedRecord(id) {
    const result = await writeRecordChanges(async () => {
      const restored = await db.transaction("rw", db.records, db.deletedRecords, async () => {
        const entry = await db.deletedRecords.get(id);
        if (!canRestoreDeletedRecord(entry)) return null;
        const current = await db.records.get(id);
        if (current) {
          await db.deletedRecords.delete(id);
          return { alreadyRestored: true };
        }
        const record = { ...entry.record, pendingSync: true, updatedAt: new Date().toISOString() };
        await db.records.put(record);
        await db.deletedRecords.delete(id);
        return { record };
      });
      if (!restored) return null;
      deletedRecords.value = deletedRecords.value.filter((entry) => entry.id !== id);
      if (restored.record) records.value = sortRecords(upsertById(records.value, restored.record));
      return restored;
    });
    if (!result) {
      notify("这条成绩已超过可恢复时间。", "error", 5200);
      return;
    }
    if (result.record) scheduleAutoSync(250, true);
    notify(result.alreadyRestored ? "这条成绩已在列表中。" : "成绩已恢复。", "success");
  }

  async function addMistake(payload, files = []) {
    const now = new Date().toISOString();
    const mistake = {
      id: crypto.randomUUID(),
      ...payload,
      sourceRecordId: payload.sourceRecordId || "",
      nextReviewAt: payload.nextReviewAt || "",
      pendingSync: true,
      createdAt: now,
      updatedAt: now
    };
    await db.mistakes.put(mistake);
    mistakes.value.unshift(mistake);
    const synced = await safeCloud(() => upsertMistake(mistake));
    if (synced) await markMistakeSynced(mistake.id);
    if (files.length) {
      const saved = await saveMistakeImages(mistake.id, files);
      images.value.push(...saved);
    }
    notify(files.length ? "错题已保存，图片正在后台同步。" : "错题已保存。", "success");
    return mistake;
  }

  async function updateMistake(id, patch, files = []) {
    const next = { ...patch, pendingSync: true, updatedAt: new Date().toISOString() };
    await db.mistakes.update(id, next);
    mistakes.value = mistakes.value.map((mistake) => (mistake.id === id ? { ...mistake, ...next } : mistake));
    const mistake = mistakes.value.find((item) => item.id === id);
    if (mistake) {
      const synced = await safeCloud(() => upsertMistake(mistake));
      if (synced) await markMistakeSynced(id);
    }
    if (files.length) {
      const saved = await saveMistakeImages(id, files);
      images.value.push(...saved);
    }
    notify(files.length ? "错题已保存，新增图片正在后台同步。" : "错题已保存。", "success");
  }

  async function removeMistake(id) {
    await db.transaction("rw", db.mistakes, db.images, async () => {
      await db.mistakes.delete(id);
      await db.images.where({ ownerType: "mistake", ownerId: id }).delete();
    });
    await safeCloud(() => deleteMistakeCloud(id));
    mistakes.value = mistakes.value.filter((mistake) => mistake.id !== id);
    images.value = images.value.filter((image) => !(image.ownerType === "mistake" && image.ownerId === id));
    notify("错题已删除。", "success");
  }

  async function removeImage(id) {
    await safeCloud(() => deleteMistakeImageCloud(id));
    await db.images.delete(id);
    images.value = images.value.filter((image) => image.id !== id);
    notify("图片已删除。", "success");
  }

  async function saveSubjects(nextSubjects) {
    const normalizedSubjects = normalizeSubjects(nextSubjects);
    await db.subjects.bulkPut(normalizedSubjects);
    await Promise.all(normalizedSubjects.map((subject) => safeCloud(() => upsertSubject(subject))));
    subjects.value = normalizedSubjects;
    notify("科目已保存。", "success");
  }

  async function addSubject(payload) {
    const subject = {
      id: `subject-${crypto.randomUUID()}`,
      name: payload.name.trim(),
      fullScore: Number(payload.fullScore),
      color: payload.color || "#177ddc",
      hidden: false,
      sortOrder: nextSubjectOrder(),
      createdAt: new Date().toISOString()
    };
    await saveSubjects([...subjects.value, subject]);
    return subject;
  }

  async function updateSubject(id, patch) {
    const nextSubjects = subjects.value.map((subject) =>
      subject.id === id
        ? {
            ...subject,
            ...patch,
            name: String(patch.name || subject.name).trim(),
            fullScore: Number(patch.fullScore ?? subject.fullScore),
            hidden: Boolean(patch.hidden ?? subject.hidden),
            sortOrder: Number.isFinite(Number(patch.sortOrder)) ? Number(patch.sortOrder) : subject.sortOrder
          }
        : subject
    );
    await saveSubjects(nextSubjects);
  }

  async function reorderSubjects(ids) {
    const orderMap = new Map(ids.map((id, index) => [id, index]));
    const nextSubjects = subjects.value.map((subject, index) => ({
      ...subject,
      sortOrder: orderMap.has(subject.id) ? orderMap.get(subject.id) : ids.length + index
    }));
    await saveSubjects(nextSubjects);
  }

  async function removeSubject(id) {
    const isUsed = records.value.some((record) => record.subjectId === id) || mistakes.value.some((mistake) => mistake.subjectId === id);
    if (isUsed) {
      throw new Error("这个科目已有成绩或错题记录，不能删除。");
    }
    await db.subjects.delete(id);
    await safeCloud(() => deleteSubjectCloud(id));
    subjects.value = normalizeSubjects(subjects.value.filter((subject) => subject.id !== id));
  }

  async function exportData() {
    return exportPortableData();
  }

  function backupImportOptions(options = {}) {
    if (options.merge === false && !canReplaceBackup) {
      throw new BackupImportError("当前环境已配置云同步，只支持合并导入。");
    }
    const userId = user.value?.id ?? null;
    if (options.expectedUserId !== undefined && options.expectedUserId !== userId) {
      throw new BackupImportError("账号状态已变化，请重新核对导入预览。", "STALE_PREVIEW");
    }
    return { ...options, userId, cloudConfigured: isSupabaseConfigured };
  }

  async function previewBackupImport(backup, options) {
    const scoped = backupImportOptions(options);
    return { ...await previewPortableImport(backup, scoped), userId: scoped.userId };
  }

  function applyBackupImport(backup, options) {
    return writeRecordChanges(async () => {
      const result = await importPortableData(backup, backupImportOptions(options));
      if (!result.added && !result.updated && options?.merge !== false) return result;
      backupImportRevision += 1;
      lastCloudSignature = "";
      try {
        // 写入已提交。刷新或登录失败不能让用户以为还需要再导一次。
        await applyLocalSnapshot(readLocalData());
      } catch (error) {
        console.error(error);
        return { ...result, refreshFailed: true };
      }
      if (result.restored) scheduleAutoSync(250, true);
      return result;
    });
  }

  function importData(payload, merge = true, options = {}) {
    return applyBackupImport(inspectBackupPayload(payload), { ...options, merge });
  }

  function clearAll() {
    return writeRecordChanges(async () => {
      if (!canReplaceBackup) throw new BackupImportError("当前环境已配置云同步，暂不支持清空档案。");
      const pending = await clearLocalArchive();
      records.value = [];
      mistakes.value = [];
      images.value = [];
      deletedRecords.value = pending;
    });
  }

  function subjectName(id) {
    return subjectMap.value.get(id)?.name || "未分类";
  }

  function subjectColor(id) {
    return subjectMap.value.get(id)?.color || "#177ddc";
  }

  function nextSubjectOrder() {
    return subjects.value.reduce((max, subject) => Math.max(max, Number(subject.sortOrder ?? -1)), -1) + 1;
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
  }

  function normalizeDuration(value) {
    if (value === "" || value === null || value === undefined) return "";
    const minutes = Number(value);
    return Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes) : "";
  }

  function normalizeOptionalNumber(value, fallback) {
    if (value === "" || value === null || value === undefined) return Number(fallback || 0);
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : Number(fallback || 0);
  }

  function normalizeOptionalDuration(value, fallback) {
    if (value === "" || value === null || value === undefined) return fallback;
    return normalizeDuration(value);
  }

  function normalizeRecordPayload(payload) {
    const recordType = payload.recordType === "exercise" || payload.recordType === "composite" ? payload.recordType : "paper";
    const exerciseBookName = cleanText(payload.exerciseBookName);
    const exercisePage = cleanText(payload.exercisePage);
    const exerciseQuestion = cleanText(payload.exerciseQuestion);
    const compositeSources = recordType === "composite" ? normalizeCompositeSources(Array.isArray(payload.compositeSources) && payload.compositeSources.length ? payload.compositeSources : payload.note) : [];
    const paperVariant = recordType === "paper" && cleanText(payload.subjectId) === "math1" ? normalizePaperVariant(payload.paperVariant, payload.paperName) : "";
    const paperName =
      recordType === "exercise"
        ? buildExerciseRecordName(exerciseBookName, exercisePage, exerciseQuestion)
        : cleanText(payload.paperName);
    const readingParts = recordType === "paper" ? normalizeReadingParts(payload.readingParts) : null;
    // 先把所有元数据块剥掉再按当前状态重挂。不这么做的话，「清空阅读结果」
    // 或「合成来源被清掉」之后旧块还留在备注里 —— 界面显示是空的，存的是旧的。
    const cleanNote = stripNoteMeta(payload.note);
    let note = recordType === "composite" ? attachCompositeMeta(cleanNote, compositeSources) : cleanNote;
    // 英语阅读的分篇对错没有自己的数据库列（云端按显式列同步），
    // 和合成来源一样挂在备注里，同步才不会丢。
    if (readingParts) note = appendNoteMeta(note, "reading", { parts: readingParts });

    return {
      ...payload,
      recordType,
      paperName,
      note,
      readingParts,
      paperVariant,
      exerciseBookName: recordType === "exercise" ? exerciseBookName : "",
      exercisePage: recordType === "exercise" ? exercisePage : "",
      exerciseQuestion: recordType === "exercise" ? exerciseQuestion : "",
      compositeSourceIds: recordType === "composite" ? normalizeIdList(payload.compositeSourceIds) : [],
      compositeSources
    };
  }

  function buildCompositeSources(sourceRecords, sourceDrafts = []) {
    const draftMap = new Map(
      (Array.isArray(sourceDrafts) ? sourceDrafts : [])
        .filter((item) => item?.id)
        .map((item) => [item.id, item])
    );
    return sourceRecords.map((record) => {
      const draft = draftMap.get(record.id) || {};
      return {
        id: record.id,
        subjectId: record.subjectId,
        paperName: record.paperName,
        recordType: record.recordType || "paper",
        paperVariant: normalizePaperVariant(record.paperVariant, record.paperName),
        score: normalizeOptionalNumber(draft.score, record.score),
        fullScore: normalizeOptionalNumber(draft.fullScore, record.fullScore),
        durationMinutes: normalizeOptionalDuration(draft.durationMinutes, normalizeDuration(record.durationMinutes)),
        originalScore: Number(record.score || 0),
        originalFullScore: Number(record.fullScore || 0),
        originalDurationMinutes: normalizeDuration(record.durationMinutes),
        date: record.date || ""
      };
    });
  }

  function normalizeCompositeSources(value) {
    if (Array.isArray(value) && value.length) {
      return value
        .filter((item) => item?.id)
        .map((item) => ({
          id: String(item.id),
          subjectId: cleanText(item.subjectId),
          paperName: cleanText(item.paperName),
          recordType: item.recordType === "exercise" || item.recordType === "composite" ? item.recordType : "paper",
          paperVariant: normalizePaperVariant(item.paperVariant, item.paperName),
          score: normalizeOptionalNumber(item.score, 0),
          fullScore: normalizeOptionalNumber(item.fullScore, 0),
          durationMinutes: normalizeOptionalDuration(item.durationMinutes, ""),
          originalScore: normalizeOptionalNumber(item.originalScore, item.score),
          originalFullScore: normalizeOptionalNumber(item.originalFullScore, item.fullScore),
          originalDurationMinutes: normalizeOptionalDuration(item.originalDurationMinutes, item.durationMinutes),
          date: cleanText(item.date)
        }));
    }
    const parsed = parseCompositeMeta(value?.note || value);
    return parsed.sources || [];
  }

  function attachCompositeMeta(note, sources) {
    if (!sources.length) return note;
    const cleanNote = stripCompositeMeta(note);
    return `${cleanNote}${COMPOSITE_NOTE_META_PREFIX}${encodeURIComponent(JSON.stringify({ sources }))}${COMPOSITE_NOTE_META_SUFFIX}`;
  }

  function parseCompositeMeta(note) {
    const text = String(note || "");
    const start = text.indexOf(COMPOSITE_NOTE_META_PREFIX);
    if (start < 0) return { note: text, sources: [] };
    const end = text.indexOf(COMPOSITE_NOTE_META_SUFFIX, start);
    if (end < 0) return { note: text, sources: [] };
    const encoded = text.slice(start + COMPOSITE_NOTE_META_PREFIX.length, end);
    try {
      const parsed = JSON.parse(decodeURIComponent(encoded));
      return { note: text.slice(0, start), sources: normalizeCompositeSources(parsed.sources) };
    } catch {
      return { note: text.slice(0, start), sources: [] };
    }
  }

  function stripCompositeMeta(note) {
    return parseCompositeMeta(note).note.trim();
  }

  function displayRecordNote(record) {
    // 备注里可能挂着合成来源、阅读分篇等结构化块，显示前统统剥掉。
    return stripNoteMeta(record?.note || "");
  }

  /**
   * 这条成绩的英语阅读分篇对错（4 个 0-5，没填的篇是 null），没有则 null。
   * 实现在 utils/recordDisplay.js —— 导出也要用，那边拿不到 store。
   */
  function readingPartsForRecord(record) {
    return readingPartsFromRecord(record);
  }

  function compositeSourcesForRecord(record) {
    if (!record || record.recordType !== "composite") return [];
    const savedSources = normalizeCompositeSources(Array.isArray(record.compositeSources) && record.compositeSources.length ? record.compositeSources : record.note);
    if (savedSources.length) return savedSources;
    return normalizeIdList(record.compositeSourceIds)
      .map((id) => records.value.find((item) => item.id === id))
      .filter(Boolean)
      .map((source) => ({
        id: source.id,
        subjectId: source.subjectId,
        paperName: source.paperName,
        recordType: source.recordType || "paper",
        paperVariant: normalizePaperVariant(source.paperVariant, source.paperName),
        score: Number(source.score || 0),
        fullScore: Number(source.fullScore || 0),
        durationMinutes: normalizeDuration(source.durationMinutes),
        originalScore: Number(source.score || 0),
        originalFullScore: Number(source.fullScore || 0),
        originalDurationMinutes: normalizeDuration(source.durationMinutes),
        date: source.date || ""
      }));
  }

  function buildCompositeRecordName(sourceRecords) {
    const datePrefix = commonYearLabel(sourceRecords);
    const suffix = sourceRecords.length ? sourceRecords.map((record) => record.paperName).join(" + ") : "合成成绩";
    return datePrefix ? `${datePrefix} ${suffix}` : suffix;
  }

  function commonYearLabel(sourceRecords) {
    const years = [...new Set(sourceRecords.map((record) => String(record.paperName || "").match(/\d{2,4}/)?.[0]).filter(Boolean))];
    if (years.length === 1) return years[0].length === 2 ? `20${years[0]}` : years[0];
    return "";
  }

  function normalizeIdList(value) {
    return Array.isArray(value) ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))] : [];
  }

  function buildExerciseRecordName(bookName, page, question) {
    return [bookName, page ? `P${page}` : "", question ? `第 ${question} 题` : ""].filter(Boolean).join(" · ") || "数一习题";
  }

  function cleanText(value) {
    return String(value ?? "").trim();
  }

  function normalizePaperVariant(value, paperName = "") {
    const raw = cleanText(value).toLowerCase();
    if (raw === "true" || raw === "mock") return raw;
    const name = cleanText(paperName).toLowerCase();
    if (/mock|模拟|模考/.test(name)) return "mock";
    if (/真题|历年|历届/.test(name)) return "true";
    return "";
  }

  async function saveMistakeImages(mistakeId, files) {
    const entries = await Promise.all(
      [...files].map(async (original) => {
        const compressed = await compressImage(original);
        return {
          id: crypto.randomUUID(),
          ownerType: "mistake",
          ownerId: mistakeId,
          name: compressed.file.name,
          type: compressed.file.type,
          size: compressed.file.size,
          blob: compressed.file,
          width: compressed.width,
          height: compressed.height,
          pendingUpload: Boolean(user.value && supabase),
          uploadError: "",
          createdAt: new Date().toISOString()
        };
      })
    );

    await addImageEntries(entries);

    if (!user.value || !supabase) {
      return entries;
    }

    const session = await getSession();
    const token = session?.access_token;
    if (!token) {
      await markImagesUploadFailed(entries, "登录状态已过期，请重新登录后再同步。");
      return entries.map((entry) => ({ ...entry, pendingUpload: false, uploadError: "登录状态已过期，请重新登录后再同步。" }));
    }

    window.setTimeout(() => {
      entries.forEach((entry) => {
        uploadImageInBackground(entry, mistakeId, token);
      });
    });

    return entries;
  }

  async function uploadImageInBackground(entry, mistakeId, token) {
    let next = null;
    try {
      if (await shouldWaitForMistakeSync(mistakeId)) {
        queueImageRetry(entry, "等待错题同步完成");
        return;
      }
      const upload = await uploadMistakeImage(entry.blob, mistakeId, token, entry.id);
      next = {
        ...entry,
        id: upload.imageId,
        storageKey: upload.storageKey,
        url: upload.publicUrl,
        pendingUpload: false,
        uploadError: ""
      };
      await upsertMistakeImage(next);
      syncError.value = "";
      await db.images.put(next);
      images.value = images.value.map((image) => (image.id === entry.id ? next : image));
      markSyncHeartbeat();
      notify("图片已同步到云端。", "success");
    } catch (error) {
      const uploadError = error.message || "图片上传失败";
      if (shouldRetryImageUpload(error)) {
        queueImageRetry(entry, uploadError);
        return;
      }
      if (next) {
        const failed = { ...next, pendingUpload: false, uploadError };
        await db.images.put(failed);
        images.value = images.value.map((image) => (image.id === entry.id ? failed : image));
      } else {
        await markImagesUploadFailed([entry], uploadError);
      }
      notify(`图片已本地保存，但云端上传失败：${uploadError}`, "error", 7000);
    }
  }

  async function shouldWaitForMistakeSync(mistakeId) {
    const mistake = mistakes.value.find((item) => item.id === mistakeId);
    if (!mistake?.pendingSync) return false;
    const synced = await safeCloud(() => upsertMistake(mistake));
    if (synced) {
      await markMistakeSynced(mistakeId);
      return false;
    }
    return true;
  }

  function shouldRetryImageUpload(error) {
    const message = `${error?.message || ""}`;
    return error?.status === 409 || /not ready|foreign key|violates foreign key|mistake/i.test(message);
  }

  async function queueImageRetry(entry, reason) {
    const next = { ...entry, pendingUpload: true, uploadError: "" };
    await db.images.put(next);
    images.value = images.value.map((image) => (image.id === entry.id ? next : image));
    window.setTimeout(() => retryPendingImageUploads(true).catch((error) => console.error(error)), 2500);
  }

  async function markImagesUploadFailed(entries, uploadError) {
    await Promise.all(entries.map((entry) => db.images.update(entry.id, { pendingUpload: false, uploadError })));
    const ids = new Set(entries.map((entry) => entry.id));
    images.value = images.value.map((image) => (ids.has(image.id) ? { ...image, pendingUpload: false, uploadError } : image));
  }

  async function safeCloud(action) {
    if (!user.value || !supabase) return false;
    try {
      await action();
      syncError.value = "";
      markSyncHeartbeat();
      return true;
    } catch (error) {
      syncError.value = error.message || "云端同步失败";
      console.error(error);
      return false;
    }
  }

  function notify(message, type = "info", timeout = 3200) {
    const id = crypto.randomUUID();
    notifications.value.push({ id, message, type, timeout });
    window.setTimeout(() => removeNotification(id), timeout);
  }

  function removeNotification(id) {
    notifications.value = notifications.value.filter((item) => item.id !== id);
  }

  function dataSignature(data) {
    return JSON.stringify({
      subjects: data.subjects.map((item) => [item.id, item.name, item.fullScore, item.color, item.hidden, item.sortOrder, item.restoredFromBackup]),
      records: data.records.map((item) => [
        item.id,
        item.subjectId,
        item.recordType,
        item.paperVariant,
        item.paperName,
        item.exerciseBookName,
        item.exercisePage,
        item.exerciseQuestion,
        item.score,
        item.fullScore,
        item.durationMinutes,
        item.date,
        item.note,
        item.createdAt,
        item.updatedAt,
        item.pendingSync,
        item.restoredFromBackup,
        normalizeIdList(item.compositeSourceIds).join(","),
        JSON.stringify(normalizeCompositeSources(item.compositeSources))
      ]),
      mistakes: data.mistakes.map((item) => [item.id, item.subjectId, item.title, item.knowledgePoint, item.analysis, item.updatedAt, item.pendingSync, item.restoredFromBackup]),
      images: data.images.map((item) => [item.id, item.ownerId, item.name, item.size, item.storageKey, item.url, item.pendingUpload, item.uploadError, item.restoredFromBackup])
    });
  }

  function mergeCloudImages(cloudImages, reconcileRestored) {
    const cloudIds = new Set(cloudImages.map((image) => image.id));
    const restored = new Map(images.value.filter((image) => image.restoredFromBackup).map((image) => [image.id, image]));
    const localPending = images.value.filter((image) => (image.restoredFromBackup || isLocalPendingImage(image)) && !cloudIds.has(image.id));
    const incoming = cloudImages.map((image) => {
      const local = restored.get(image.id);
      return !reconcileRestored && local ? local : keepRestoredImageBlob(local, image);
    });
    return [...incoming, ...localPending];
  }

  function keepRestoredImageBlob(local, remote) {
    if (!local?.restoredFromBackup || !local.blob || local.ownerId !== remote.ownerId) return remote;
    return { ...remote, blob: local.blob, restoredFromBackup: true };
  }

  function isRestoredBackupNewer(local, remote) {
    const localTime = backupTimestamp(local);
    const remoteTime = backupTimestamp(remote);
    return localTime !== null && remoteTime !== null && localTime > remoteTime;
  }

  function mergeCloudEntries(cloudEntries, localEntries, isSame, isDemo, reconcileRestored) {
    const merged = new Map(cloudEntries.map((entry) => [entry.id, { ...entry, pendingSync: false }]));
    localEntries.forEach((entry) => {
      const cloudEntry = merged.get(entry.id);
      if (entry.restoredFromBackup && !entry.pendingSync) {
        // 导入前发起的读取不能确认刚导入的版本。缺少同 ID 时也只保存在本机。
        if (!reconcileRestored || !cloudEntry) merged.set(entry.id, entry);
        else if (isRestoredBackupNewer(entry, cloudEntry)) {
          merged.set(entry.id, { ...entry, restoredFromBackup: false, pendingSync: !(isDemo && isDemo(entry)) });
        }
        return;
      }
      if (!cloudEntry) {
        // 本地有、云端没有 → 排队上传。
        // 但演示数据永远不上传：一旦上传，它就被「洗白」成真实的云端记录，
        // 之后每台设备、每次同步都会把它拉回来。
        merged.set(entry.id, {
          ...entry,
          pendingSync: Boolean(user.value && supabase) && !(isDemo && isDemo(entry))
        });
        return;
      }
      const localIsNewer = isNewerEntry(entry, cloudEntry, "updatedAt");
      const shouldPreserveDuration = isSame === isSameRecord && hasDuration(entry) && !hasDuration(cloudEntry);
      if (entry.pendingSync || localIsNewer || shouldPreserveDuration) {
        const needsCloudRetry = Boolean(user.value && supabase && (localIsNewer || shouldPreserveDuration) && isSame && !isSame(entry, cloudEntry));
        merged.set(entry.id, { ...entry, pendingSync: Boolean(entry.pendingSync || needsCloudRetry) });
      }
    });
    return [...merged.values()];
  }

  function isNewerEntry(localEntry, cloudEntry, stampField) {
    const localTime = new Date(localEntry[stampField] || localEntry.createdAt || 0).getTime();
    const cloudTime = new Date(cloudEntry[stampField] || cloudEntry.createdAt || 0).getTime();
    return localTime >= cloudTime;
  }

  async function syncPendingQueues(silent = false) {
    await retryUnsyncedData();
    await retryPendingImageUploads(silent);
    if (!syncError.value) markSyncHeartbeat();
  }

  async function retryUnsyncedData() {
    if (!user.value || !supabase) return;
    const mistakeQueue = mistakes.value.filter((mistake) => mistake.pendingSync && !isDemoMistake(mistake));
    const [recordError] = await Promise.all([
      syncRecordQueue(),
      Promise.all(mistakeQueue.map(async (mistake) => {
        const synced = await safeCloud(() => upsertMistake(mistake));
        if (synced) await markMistakeSynced(mistake.id);
      }))
    ]);
    if (recordError || syncError.value === recordSyncError) syncError.value = recordError;
    recordSyncError = recordError;
  }

  function syncRecordQueue() {
    recordSyncRequested = true;
    if (!recordSyncPromise) recordSyncPromise = drainRecordQueue();
    return recordSyncPromise;
  }

  async function drainRecordQueue() {
    // 让同时触发的手动同步、联网事件和自动同步共享一次队列。
    await Promise.resolve();
    let failure = "";
    try {
      while (recordSyncRequested) {
        recordSyncRequested = false;
        await recordWrites;
        const userId = user.value?.id;
        if (!userId || !supabase) break;
        failure = "";
        const deletions = deletedRecords.value.filter((entry) => entry.pendingSync && entry.userId === userId);
        const uploads = records.value.filter((record) => record.pendingSync && !isDemoRecord(record));
        if (!deletions.length && !uploads.length) continue;
        if (globalThis.navigator?.onLine === false) return "当前离线，成绩将在联网后同步。";

        for (let offset = 0; offset < deletions.length && user.value?.id === userId; offset += RECORD_SYNC_BATCH_SIZE) {
          const batch = deletions.slice(offset, offset + RECORD_SYNC_BATCH_SIZE).filter((entry) => deletedRecordMap.value.get(entry.id) === entry);
          if (!batch.length) continue;
          try {
            await deleteRecordsCloud(batch.map((entry) => entry.id), userId);
            await acknowledgeRecordDeletions(batch);
          } catch (error) {
            failure ||= error.message || "成绩删除同步失败";
          }
        }

        const uploaded = [];
        for (let offset = 0; offset < uploads.length && user.value?.id === userId; offset += RECORD_SYNC_BATCH_SIZE) {
          const batch = uploads.slice(offset, offset + RECORD_SYNC_BATCH_SIZE);
          const error = await syncRecordUploads(batch, userId, uploaded);
          failure ||= error;
        }
        if (uploaded.length) {
          try {
            await acknowledgeRecordUploads(uploaded, userId);
          } catch (error) {
            failure ||= error.message || "无法更新本地成绩同步状态";
          }
        }
        if (!failure && user.value?.id === userId) markSyncHeartbeat();
      }
      return failure;
    } finally {
      recordSyncPromise = null;
    }
  }

  async function syncRecordUploads(batch, userId, uploaded) {
    if (user.value?.id !== userId) return "";
    const current = batch.filter((record) => recordMap.value.get(record.id) === record);
    if (!current.length) return "";
    try {
      await upsertRecords(current, userId);
    } catch (error) {
      // 旧备份里的一条无效记录只影响自己，合法的记录仍可同步。
      if (current.length > 1 && /^2[23]/.test(error.code || "")) {
        const middle = Math.floor(current.length / 2);
        const first = await syncRecordUploads(current.slice(0, middle), userId, uploaded);
        const second = await syncRecordUploads(current.slice(middle), userId, uploaded);
        return first || second;
      }
      return error.message || "成绩同步失败";
    }
    uploaded.push(...current);
    return "";
  }

  function acknowledgeRecordUploads(sent, userId) {
    return writeRecordChanges(async () => {
      if (user.value?.id !== userId) return;
      const sentById = new Map(sent.map((record) => [record.id, record]));
      const updated = await db.transaction("rw", db.records, async () => {
        const rows = await db.records.bulkGet([...sentById.keys()]);
        const synced = rows.filter((record) => {
          if (!record?.pendingSync) return false;
          const original = sentById.get(record.id);
          return record.updatedAt === original.updatedAt && isSameRecord(record, original);
        }).map((record) => ({ ...record, pendingSync: false }));
        if (synced.length) await db.records.bulkPut(synced);
        return synced;
      });
      applyRecordUpdates(updated);
    });
  }

  function acknowledgeRecordDeletions(sent) {
    return writeRecordChanges(async () => {
      const sentById = new Map(sent.map((entry) => [entry.id, entry]));
      const updated = await db.transaction("rw", db.deletedRecords, async () => {
        const rows = await db.deletedRecords.bulkGet([...sentById.keys()]);
        const synced = rows.filter((entry) => entry?.pendingSync && entry.operationId === sentById.get(entry.id).operationId)
          .map((entry) => ({ ...entry, pendingSync: false, syncedAt: Date.now() }));
        if (synced.length) await db.deletedRecords.bulkPut(synced);
        return synced;
      });
      const syncedById = new Map(updated.map((entry) => [entry.id, entry]));
      deletedRecords.value = deletedRecords.value.map((entry) => syncedById.get(entry.id) || entry);
    });
  }

  /**
   * 清掉已经「洗白」进云端的演示数据。
   *
   * 光堵住源头（不再灌、不再上传）还不够：老版本已经把 4 条成绩 / 2 道错题
   * 同步上去了，它们在云端是真实记录。用户只要登录，runCloudLoad() 还是会
   * 把它们拉回来 —— 看起来就是「删了又出现，删不掉」。
   * 所以这里在云端加载之后主动清一次。
   *
   * 只删「指纹完全命中」的：用户改过的（改分数、改备注…）指纹不再匹配，
   * 一律当真实数据保留。删之前照例进回收站，24 小时内还能恢复。
   */
  async function purgeDemoEntries() {
    const demoRecords = records.value.filter(isDemoRecord);
    const demoMistakes = mistakes.value.filter(isDemoMistake);
    if (!demoRecords.length && !demoMistakes.length) return [];

    if (demoRecords.length) {
      const entries = await db.transaction("rw", db.records, db.deletedRecords, () =>
        persistRecordDeletions(demoRecords.map(toRaw), user.value.id)
      );
      applyRecordDeletions(entries);
    }
    const mistakeIds = demoMistakes.map((mistake) => mistake.id);
    if (mistakeIds.length) {
      const ids = new Set(mistakeIds);
      await db.mistakes.bulkDelete(mistakeIds);
      mistakes.value = mistakes.value.filter((mistake) => !ids.has(mistake.id));
      images.value = images.value.filter((image) => !(image.ownerType === "mistake" && ids.has(image.ownerId)));
    }

    const total = demoRecords.length + demoMistakes.length;
    notify(`已清理 ${total} 条旧版本自动生成的演示数据。`, "info", 5200);
    return mistakeIds;
  }

  async function markMistakeSynced(id) {
    await db.mistakes.update(id, { pendingSync: false });
    mistakes.value = mistakes.value.map((mistake) => (mistake.id === id ? { ...mistake, pendingSync: false } : mistake));
  }

  function isLocalPendingImage(image) {
    return Boolean(image?.blob && (image.pendingUpload || image.uploadError || !image.url));
  }

  async function retryPendingImageUploads(silent = false) {
    if (!user.value || !supabase) return;
    const pending = images.value.filter((image) => image.blob && (image.pendingUpload || image.uploadError));
    if (!pending.length) return;
    const session = await getSession();
    const token = session?.access_token;
    if (!token) return;
    await Promise.all(pending.map((image) => db.images.update(image.id, { pendingUpload: true, uploadError: "" })));
    const pendingIds = new Set(pending.map((image) => image.id));
    images.value = images.value.map((image) => (pendingIds.has(image.id) ? { ...image, pendingUpload: true, uploadError: "" } : image));
    if (!silent) notify(`正在重试 ${pending.length} 张图片同步。`, "info");
    pending.forEach((image) => {
      uploadImageInBackground({ ...image, pendingUpload: true, uploadError: "" }, image.ownerId, token);
    });
  }

  function startAutoSync() {
    if (!isSupabaseConfigured || typeof window === "undefined") return;
    if (!isSupabaseProxyEnabled) startRealtimeSync();
    if (autoSyncStarted) return;
    autoSyncStarted = true;
    autoSyncTimer = window.setInterval(() => syncPendingQueues(true), FALLBACK_SYNC_INTERVAL);
    window.addEventListener("focus", syncWhenActive);
    window.addEventListener("online", syncWhenOnline);
    document.addEventListener("visibilitychange", syncWhenVisible);
  }

  function stopAutoSync() {
    if (typeof window === "undefined") {
      stopRealtimeSync();
      return;
    }
    if (!autoSyncStarted) {
      stopRealtimeSync();
      return;
    }
    autoSyncStarted = false;
    if (autoSyncTimer) window.clearInterval(autoSyncTimer);
    if (pendingFallbackTimer) window.clearTimeout(pendingFallbackTimer);
    if (cloudCalibrationTimer) window.clearTimeout(cloudCalibrationTimer);
    autoSyncTimer = null;
    pendingFallbackTimer = null;
    cloudCalibrationTimer = null;
    window.removeEventListener("focus", syncWhenActive);
    window.removeEventListener("online", syncWhenOnline);
    document.removeEventListener("visibilitychange", syncWhenVisible);
    stopRealtimeSync();
  }

  function syncWhenVisible() {
    if (!document.hidden) syncWhenActive();
  }

  function syncWhenActive() {
    syncPendingQueues(true);
  }

  function syncWhenOnline() {
    syncPendingQueues(false);
  }

  function scheduleAutoSync(delay = 0, force = false) {
    if (!user.value) return;
    if (pendingFallbackTimer) window.clearTimeout(pendingFallbackTimer);
    pendingFallbackTimer = window.setTimeout(() => {
      pendingFallbackTimer = null;
      if (!user.value || document.hidden) return;
      const now = Date.now();
      if (!force && now - lastAutoSyncAt < ACTIVE_FALLBACK_THROTTLE) return;
      lastAutoSyncAt = now;
      syncPendingQueues(true).catch((error) => {
        syncError.value = error.message || "快速同步失败";
        console.error(error);
      });
    }, delay);
  }

  function scheduleCloudCalibrationIfNeeded() {
    if (typeof window === "undefined" || !user.value) return;
    const needsInitialData = !records.value.length && !mistakes.value.length && !images.value.length;
    const last = Number(readLocalValue(cloudCalibrationKey(), "0"));
    const now = Date.now();
    if (!needsInitialData && now - last < CLOUD_CALIBRATION_INTERVAL) return;
    if (cloudCalibrationTimer) window.clearTimeout(cloudCalibrationTimer);
    cloudCalibrationTimer = window.setTimeout(() => {
      cloudCalibrationTimer = null;
      if (!user.value || document.hidden) return;
      loadFromCloud()
        .then(() => writeLocalValue(cloudCalibrationKey(), String(Date.now())))
        .catch((error) => {
          syncError.value = error.message || "云端校准失败";
          console.error(error);
        });
    }, 1500);
  }

  function cloudCalibrationKey() {
    return `exam-tracker-last-cloud-calibration-${user.value?.id || "anonymous"}`;
  }

  function startRealtimeSync() {
    if (!user.value?.id || unsubscribeRealtime || !supabase) return;
    const userId = user.value.id;
    realtimeStatus.value = "connecting";
    realtimeError.value = "";
    unsubscribeRealtime = subscribeCloudChanges(userId, {
      subjects: {
        upsert: (subject) => applyRealtimeSubject(subject),
        delete: (id) => removeRealtimeSubject(id)
      },
      records: {
        upsert: (record) => applyRealtimeRecord(record, userId),
        delete: (id, old) => removeRealtimeRecord(id, userId, old)
      },
      mistakes: {
        upsert: (mistake) => applyRealtimeMistake(mistake),
        delete: (id) => removeRealtimeMistake(id)
      },
      images: {
        upsert: (image) => applyRealtimeImage(image),
        delete: (id) => removeRealtimeImage(id)
      },
      onStatus: (status, error) => {
        if (status === "SUBSCRIBED") {
          realtimeStatus.value = "connected";
          realtimeError.value = "";
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          realtimeStatus.value = "error";
          realtimeError.value = error?.message || "Realtime 连接失败";
          scheduleAutoSync(1500, true);
          reconnectRealtimeSoon();
          return;
        }
        if (status === "CLOSED") {
          realtimeStatus.value = "idle";
        }
      }
    });
  }

  function stopRealtimeSync() {
    if (unsubscribeRealtime) {
      unsubscribeRealtime();
      unsubscribeRealtime = null;
    }
    if (realtimeReconnectTimer && typeof window !== "undefined") {
      window.clearTimeout(realtimeReconnectTimer);
      realtimeReconnectTimer = null;
    }
    realtimeStatus.value = "idle";
    realtimeError.value = "";
  }

  function reconnectRealtimeSoon() {
    if (realtimeReconnectTimer || typeof window === "undefined") return;
    realtimeReconnectTimer = window.setTimeout(() => {
      realtimeReconnectTimer = null;
      if (!user.value?.id) return;
      if (unsubscribeRealtime) {
        unsubscribeRealtime();
        unsubscribeRealtime = null;
      }
      startRealtimeSync();
    }, 5000);
  }

  async function applyRealtimeSubject(subject) {
    const nextSubjects = normalizeSubjects([...subjects.value.filter((item) => item.id !== subject.id), subject]);
    subjects.value = nextSubjects;
    await db.subjects.bulkPut(nextSubjects);
    markSyncHeartbeat();
  }

  async function removeRealtimeSubject(id) {
    if (!id) return;
    const nextSubjects = normalizeSubjects(subjects.value.filter((subject) => subject.id !== id));
    subjects.value = nextSubjects;
    await db.transaction("rw", db.subjects, async () => {
      await db.subjects.delete(id);
      await db.subjects.bulkPut(nextSubjects);
    });
    markSyncHeartbeat();
  }

  function applyRealtimeRecord(record, userId) {
    return writeRecordChanges(async () => {
      if (user.value?.id !== userId) return;
      const entry = deletedRecordMap.value.get(record.id);
      if (entry?.userId === userId && (entry.pendingSync ||
        !(Date.parse(record.updatedAt || record.createdAt) > Date.parse(entry.record?.updatedAt || entry.record?.createdAt || entry.deletedAt)))) return;
      const incoming = { ...record, pendingSync: false };
      const local = recordMap.value.get(incoming.id);
      const restoredOnly = local?.restoredFromBackup && !local.pendingSync;
      if (restoredOnly && isRestoredBackupNewer(local, incoming)) return;
      // 批量上传由队列一次性确认，跳过 Realtime 回送的同版本记录。
      if (!restoredOnly && local && isSameRecord(local, incoming) &&
        (local.pendingSync || Date.parse(incoming.updatedAt) <= Date.parse(local.updatedAt))) return;
      if (!restoredOnly && local && shouldKeepLocalRecord(local, incoming)) {
        if (!local.pendingSync && hasDuration(local) && !hasDuration(incoming)) {
          await db.records.update(local.id, { pendingSync: true });
          applyRecordUpdates([{ ...local, pendingSync: true }]);
          scheduleAutoSync(0, true);
        }
        return;
      }
      const nextRecord = local?.pendingSync ? { ...toRaw(local), pendingSync: false } : incoming;
      await db.records.put(nextRecord);
      records.value = sortRecords(upsertById(records.value, nextRecord));
      markSyncHeartbeat();
    });
  }

  function removeRealtimeRecord(id, userId, old) {
    return writeRecordChanges(async () => {
      if (!id || user.value?.id !== userId) return;
      const local = recordMap.value.get(id);
      if (!local || local.pendingSync || (old?.updated_at && new Date(local.updatedAt) > new Date(old.updated_at))) return;
      await db.records.delete(id);
      records.value = records.value.filter((record) => record.id !== id);
      markSyncHeartbeat();
    });
  }

  async function applyRealtimeMistake(mistake) {
    const incoming = { ...mistake, pendingSync: false };
    const local = mistakes.value.find((item) => item.id === incoming.id);
    if (local?.restoredFromBackup && !local.pendingSync && isRestoredBackupNewer(local, incoming)) return;
    if (local?.pendingSync && !isSameMistake(local, incoming)) return;
    const nextMistake = local?.pendingSync ? { ...local, pendingSync: false } : incoming;
    mistakes.value = sortMistakes(upsertById(mistakes.value, nextMistake));
    await db.mistakes.put(nextMistake);
    markSyncHeartbeat();
  }

  async function removeRealtimeMistake(id) {
    if (!id) return;
    const local = mistakes.value.find((item) => item.id === id);
    if (local?.pendingSync) return;
    mistakes.value = mistakes.value.filter((mistake) => mistake.id !== id);
    images.value = images.value.filter((image) => image.ownerId !== id);
    await db.transaction("rw", db.mistakes, db.images, async () => {
      await db.mistakes.delete(id);
      await db.images.where({ ownerType: "mistake", ownerId: id }).delete();
    });
    markSyncHeartbeat();
  }

  async function applyRealtimeImage(image) {
    const incoming = { ...image, pendingUpload: false, uploadError: "" };
    const local = images.value.find((item) => item.id === incoming.id);
    const nextImage = local?.restoredFromBackup ? keepRestoredImageBlob(local, incoming)
      : local?.blob ? { ...local, ...incoming, blob: local.blob } : incoming;
    images.value = sortImages(upsertById(images.value, nextImage));
    await db.images.put(nextImage);
    markSyncHeartbeat();
  }

  async function removeRealtimeImage(id) {
    if (!id) return;
    const local = images.value.find((item) => item.id === id);
    if (isLocalPendingImage(local)) return;
    images.value = images.value.filter((image) => image.id !== id);
    await db.images.delete(id);
    markSyncHeartbeat();
  }

  function markSyncHeartbeat() {
    lastSyncedAt.value = new Date().toISOString();
    if (user.value) syncMode.value = "cloud";
  }

  function upsertById(entries, entry) {
    const exists = entries.some((item) => item.id === entry.id);
    return exists ? entries.map((item) => (item.id === entry.id ? entry : item)) : [entry, ...entries];
  }

  function sortRecords(entries) {
    return [...entries].sort((a, b) => {
      const dateDiff = new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
      if (dateDiff) return dateDiff;
      return compareByTimeThenId(
        new Date(a.updatedAt || a.createdAt || 0).getTime(),
        new Date(b.updatedAt || b.createdAt || 0).getTime(),
        a,
        b
      );
    });
  }

  function shouldKeepLocalRecord(local, incoming) {
    if (local.pendingSync && !isSameRecord(local, incoming)) return true;
    if (hasDuration(local) && !hasDuration(incoming)) return true;
    return isNewerEntry(local, incoming, "updatedAt") && !isSameRecord(local, incoming);
  }

  function hasDuration(record) {
    return record?.durationMinutes !== "" && record?.durationMinutes !== null && record?.durationMinutes !== undefined;
  }

  function applyRecordUpdates(updates) {
    if (!updates.length) return;
    const byId = new Map(updates.map((record) => [record.id, record]));
    records.value = records.value.map((record) => byId.get(record.id) || record);
  }

  async function persistRecordDeletions(recordsToDelete, userId) {
    if (!recordsToDelete.length) return [];
    const deletedAt = new Date().toISOString();
    const operationId = crypto.randomUUID();
    const entries = recordsToDelete.map((record) => {
      // 云端成绩主键是 UUID。旧版演示数据等本地专用 ID 仍能在本地删除和恢复。
      const owner = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(record.id) ? userId : null;
      return {
        id: record.id,
        deletedAt,
        operationId,
        userId: owner || "",
        pendingSync: Boolean(owner),
        record: { ...record, pendingSync: false }
      };
    });
    await db.deletedRecords.bulkPut(entries);
    await db.records.bulkDelete(entries.map((entry) => entry.id));
    return entries;
  }

  function applyRecordDeletions(entries) {
    if (!entries.length) return;
    const ids = new Set(entries.map((entry) => entry.id));
    records.value = records.value.filter((record) => !ids.has(record.id));
    deletedRecords.value = [...entries, ...deletedRecords.value.filter((entry) => !ids.has(entry.id))];
  }

  async function loadDeletedRecords() {
    let legacy = [];
    try {
      const parsed = JSON.parse(readLocalValue(RECORD_TRASH_KEY, "[]"));
      if (Array.isArray(parsed)) legacy = parsed.filter(isDeletedRecordRestorable);
    } catch {
      // 浏览器存储受限或旧回收站损坏时，仍可读取 IndexedDB。
    }
    const trash = await db.transaction("rw", db.deletedRecords, async () => {
      const persisted = await db.deletedRecords.toArray();
      const existing = new Set(persisted.map((entry) => entry.id));
      const migrated = legacy.filter((entry) => !existing.has(entry.id));
      const expired = persisted.filter((entry) => !entry.pendingSync && !isDeletedRecordRestorable(entry));
      if (migrated.length) await db.deletedRecords.bulkPut(migrated);
      if (expired.length) await db.deletedRecords.bulkDelete(expired.map((entry) => entry.id));
      return [...persisted.filter((entry) => entry.pendingSync || isDeletedRecordRestorable(entry)), ...migrated];
    });
    try {
      globalThis.localStorage?.removeItem(RECORD_TRASH_KEY);
    } catch {
      // 下次加载按 ID 去重。
    }
    return trash.sort((a, b) => compareByTimeThenId(Date.parse(a.deletedAt), Date.parse(b.deletedAt), a, b));
  }

  function isDeletedRecordRestorable(entry) {
    const deletedAt = new Date(entry?.deletedAt || 0).getTime();
    return Boolean(entry?.id && entry?.record?.id && deletedAt && Date.now() - deletedAt < RECORD_TRASH_TTL);
  }

  function canRestoreDeletedRecord(entry) {
    return isDeletedRecordRestorable(entry) && (!entry.userId || !user.value || entry.userId === user.value.id);
  }

  function deletedRecordRemainingHours(entry) {
    const deletedAt = new Date(entry?.deletedAt || 0).getTime();
    if (!deletedAt) return 0;
    return Math.max(0, Math.ceil((RECORD_TRASH_TTL - (Date.now() - deletedAt)) / (60 * 60 * 1000)));
  }

  function sortMistakes(entries) {
    return [...entries].sort((a, b) =>
      compareByTimeThenId(
        new Date(a.updatedAt || a.createdAt || 0).getTime(),
        new Date(b.updatedAt || b.createdAt || 0).getTime(),
        a,
        b
      )
    );
  }

  function sortImages(entries) {
    return [...entries].sort((a, b) =>
      compareByTimeThenId(new Date(b.createdAt || 0).getTime(), new Date(a.createdAt || 0).getTime(), a, b)
    );
  }

  function isSameRecord(a, b) {
    return (
      a.subjectId === b.subjectId &&
      (a.recordType || "paper") === (b.recordType || "paper") &&
      a.paperName === b.paperName &&
      normalizePaperVariant(a.paperVariant, a.paperName) === normalizePaperVariant(b.paperVariant, b.paperName) &&
      (a.exerciseBookName || "") === (b.exerciseBookName || "") &&
      (a.exercisePage || "") === (b.exercisePage || "") &&
      (a.exerciseQuestion || "") === (b.exerciseQuestion || "") &&
      Number(a.score) === Number(b.score) &&
      Number(a.fullScore) === Number(b.fullScore) &&
      String(a.durationMinutes ?? "") === String(b.durationMinutes ?? "") &&
      a.date === b.date &&
      (a.note || "") === (b.note || "") &&
      normalizeIdList(a.compositeSourceIds).join(",") === normalizeIdList(b.compositeSourceIds).join(",") &&
      JSON.stringify(normalizeCompositeSources(a.compositeSources)) === JSON.stringify(normalizeCompositeSources(b.compositeSources))
    );
  }

  function isSameMistake(a, b) {
    return (
      a.subjectId === b.subjectId &&
      a.title === b.title &&
      (a.knowledgePoint || "") === (b.knowledgePoint || "") &&
      (a.analysis || "") === (b.analysis || "") &&
      (a.sourceRecordId || "") === (b.sourceRecordId || "") &&
      (a.questionText || "") === (b.questionText || "")
    );
  }

  function getOrCreateDeviceId() {
    const key = "exam-tracker-device-id";
    const existing = readLocalValue(key, "");
    if (existing) return existing;
    const id = crypto.randomUUID();
    writeLocalValue(key, id);
    return id;
  }

  function getDeviceName() {
    const saved = readLocalValue("exam-tracker-device-name", "");
    if (saved) return saved;
    const platform = navigator.userAgentData?.platform || navigator.platform || "";
    const touch = navigator.maxTouchPoints > 1;
    if (/iPad|MacIntel/i.test(platform) && touch) return "iPad";
    if (/iPhone/i.test(platform)) return "iPhone";
    if (/Win/i.test(platform)) return "Windows";
    if (/Mac/i.test(platform)) return "Mac";
    if (/Android/i.test(navigator.userAgent)) return "Android";
    return "当前设备";
  }

  function readLocalValue(key, fallback) {
    try {
      return globalThis.localStorage?.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  }

  function writeLocalValue(key, value) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // 存储受限时仍允许本机档案加载。
    }
  }

  return {
    subjects,
    records,
    deletedRecords: restorableDeletedRecords,
    mistakes,
    images,
    isReady,
    user,
    syncMode,
    syncError,
    isSyncing,
    lastSyncedAt,
    realtimeStatus,
    realtimeError,
    notifications,
    deviceId,
    deviceName,
    lastBackupAt,
    subjectMap,
    recordMap,
    visibleSubjects,
    canReplaceBackup,
    imageStorageStats,
    pendingImages,
    failedImages,
    autoSyncState,
    load,
    login,
    register,
    logout,
    loadFromCloud,
    startAutoSync,
    syncNow,
    calibrateCloud,
    addRecord,
    addCompositeRecord,
    updateRecord,
    moveRecordsToSubject,
    removeRecord,
    removeRecords,
    restoreDeletedRecord,
    deletedRecordRemainingHours,
    addMistake,
    updateMistake,
    removeMistake,
    removeImage,
    saveSubjects,
    addSubject,
    updateSubject,
    reorderSubjects,
    removeSubject,
    exportData,
    importData,
    previewBackupImport,
    applyBackupImport,
    clearAll,
    markBackupExported,
    subjectName,
    subjectColor,
    displayRecordNote,
    readingPartsForRecord,
    compositeSourcesForRecord,
    notify,
    removeNotification,
    retryPendingImageUploads
  };
});
