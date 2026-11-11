import { normalizeReadingParts } from "../utils/recordDisplay.js";

export const BACKUP_VERSION = 3;
export const BACKUP_TABLE_LABELS = {
  subjects: "科目",
  records: "成绩",
  mistakes: "错题",
  images: "图片"
};
export const BACKUP_TABLES = Object.keys(BACKUP_TABLE_LABELS);
export const BACKUP_FILE_LIMIT = 96 * 1024 * 1024;
const IMAGE_LIMIT = 12 * 1024 * 1024;
const TOTAL_IMAGE_LIMIT = 64 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/avif",
  "image/bmp", "image/heic", "image/heif"
]);

export class BackupImportError extends Error {
  constructor(message, code = "INVALID_BACKUP") {
    super(message);
    this.name = "BackupImportError";
    this.code = code;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function isId(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    !/[/?#%\\\x00-\x1f]/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
}

function textFields(source, keys) {
  const values = {};
  for (const key of keys) {
    const value = source[key];
    if (value == null) continue;
    if (typeof value !== "string") throw new BackupImportError(`${key} 应为文本`);
    values[key] = value;
  }
  return values;
}

function numberField(value, label) {
  const number = typeof value === "string" && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value.trim())
    ? Number(value)
    : value;
  if (!Number.isFinite(number) || number < 0) throw new BackupImportError(`${label} 应为非负数字`);
  return number;
}

function normalizeSubject(row) {
  if (typeof row.name !== "string" || !row.name.trim()) throw new BackupImportError("缺少科目名称");
  if (row.hidden != null && typeof row.hidden !== "boolean") throw new BackupImportError("隐藏状态应为布尔值");
  return {
    id: row.id,
    name: row.name,
    fullScore: numberField(row.fullScore, "科目满分"),
    ...textFields(row, ["color", "createdAt"]),
    ...(row.hidden == null ? {} : { hidden: row.hidden }),
    ...(row.sortOrder == null ? {} : { sortOrder: numberField(row.sortOrder, "科目顺序") })
  };
}

function normalizeRecord(row) {
  if (!isId(row.subjectId)) throw new BackupImportError("缺少有效的科目 ID");
  const record = {
    id: row.id,
    subjectId: row.subjectId,
    paperName: "",
    date: "",
    ...textFields(row, ["paperName", "date", "createdAt", "updatedAt", "note", "recordType",
      "paperVariant", "exerciseBookName", "exercisePage", "exerciseQuestion"]),
    score: numberField(row.score, "得分"),
    fullScore: numberField(row.fullScore, "满分")
  };
  if (row.durationMinutes != null) {
    record.durationMinutes = row.durationMinutes === "" ? "" : numberField(row.durationMinutes, "用时");
  }
  if (row.readingParts != null) {
    if (!Array.isArray(row.readingParts) || row.readingParts.length > 4 || row.readingParts.some((part) =>
      part != null && part !== "" && (!Number.isInteger(numberField(part, "阅读分篇")) || Number(part) > 5)
    )) throw new BackupImportError("阅读分篇格式无效");
    record.readingParts = normalizeReadingParts(row.readingParts);
  }
  if (row.compositeSourceIds != null) {
    if (!Array.isArray(row.compositeSourceIds) || !row.compositeSourceIds.every(isId)) {
      throw new BackupImportError("合成来源 ID 格式无效");
    }
    record.compositeSourceIds = [...new Set(row.compositeSourceIds)];
  }
  if (row.compositeSources != null) {
    if (!Array.isArray(row.compositeSources) || row.compositeSources.some((source) => !isObject(source) || !isId(source.id))) {
      throw new BackupImportError("合成来源格式无效");
    }
    record.compositeSources = row.compositeSources.map((source) => {
      const result = { id: source.id, ...textFields(source, ["subjectId", "paperName", "recordType", "paperVariant", "date"]) };
      for (const key of ["score", "fullScore", "originalScore", "originalFullScore", "durationMinutes", "originalDurationMinutes"]) {
        if (source[key] != null) result[key] = source[key] === "" ? "" : numberField(source[key], "合成来源数值");
      }
      return result;
    });
  }
  return record;
}

function normalizeMistake(row) {
  if (!isId(row.subjectId)) throw new BackupImportError("缺少有效的科目 ID");
  if (typeof row.title !== "string" || !row.title.trim()) throw new BackupImportError("缺少错题标题");
  return {
    id: row.id,
    subjectId: row.subjectId,
    title: row.title,
    ...textFields(row, ["knowledgePoint", "reason", "difficulty", "status", "sourceRecordId",
      "questionText", "analysis", "nextReviewAt", "reviewedAt", "createdAt", "updatedAt"])
  };
}

function decodeImage(value, budget) {
  if (value == null) return null;
  if (typeof value !== "string") throw new BackupImportError("图片内容应为 Data URL");
  const comma = value.indexOf(",");
  const type = /^data:(image\/[\w.+-]+);base64$/i.exec(value.slice(0, comma))?.[1]?.toLowerCase();
  if (!type || !IMAGE_TYPES.has(type)) throw new BackupImportError("图片内容应为支持的图片 Data URL");
  const encoded = value.slice(comma + 1);
  const size = encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : Number(encoded.endsWith("=")));
  if (!encoded.length || encoded.length % 4 || size <= 0 || /[^A-Za-z0-9+/=]|=[^=]|={3,}/.test(encoded)) {
    throw new BackupImportError("图片 Base64 格式无效");
  }
  if (size > IMAGE_LIMIT) throw new BackupImportError("单张图片超过 12 MiB");
  if (budget.used + size > TOTAL_IMAGE_LIMIT) throw new BackupImportError("图片合计超过 64 MiB");
  let binary;
  try {
    binary = atob(encoded);
  } catch {
    throw new BackupImportError("图片 Base64 格式无效");
  }
  if (!hasImageHeader(type, binary)) throw new BackupImportError("图片内容与声明的格式不符");
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  budget.used += size;
  return new Blob([bytes], { type });
}

function hasImageHeader(type, bytes) {
  switch (type) {
    case "image/jpeg": return bytes.startsWith("\xff\xd8\xff");
    case "image/png": return bytes.startsWith("\x89PNG\r\n\x1a\n");
    case "image/webp": return bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
    case "image/gif": return /^GIF8[79]a/.test(bytes);
    case "image/bmp": return bytes.startsWith("BM");
    default: return bytes.slice(4, 8) === "ftyp";
  }
}

function normalizeImage(row, budget) {
  if (!isId(row.ownerId) || (row.ownerType != null && row.ownerType !== "mistake")) {
    throw new BackupImportError("缺少有效的错题归属");
  }
  const fields = textFields(row, ["name", "type", "url", "storageKey", "createdAt"]);
  const dimensions = {};
  for (const key of ["width", "height", "size"]) {
    if (row[key] != null) dimensions[key] = numberField(row[key], "图片尺寸");
  }
  if (fields.url) {
    try {
      const url = new URL(fields.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch {
      throw new BackupImportError("图片链接不是有效的 HTTP 或 HTTPS 地址");
    }
  }
  if (row.blob == null && !fields.url) throw new BackupImportError("缺少图片内容或链接");
  const blob = decodeImage(row.blob, budget);
  return {
    id: row.id,
    ownerType: "mistake",
    ownerId: row.ownerId,
    name: "错题图片",
    ...fields,
    ...dimensions,
    blob,
    ...(blob ? { size: blob.size, type: blob.type } : {})
  };
}

const normalizers = { subjects: normalizeSubject, records: normalizeRecord, mistakes: normalizeMistake, images: normalizeImage };

export function inspectBackupPayload(payload) {
  if (!isObject(payload)) throw new BackupImportError("备份文件应为 JSON 对象。");
  if (Object.hasOwn(payload, "version") && payload.version !== BACKUP_VERSION) {
    throw new BackupImportError("此备份版本暂不支持，请用可读取该备份的版本重新导出。");
  }
  const present = BACKUP_TABLES.filter((table) => Object.hasOwn(payload, table));
  if (!present.length) throw new BackupImportError("文件里没有可识别的备份表。");

  const data = {};
  const rejected = {};
  const issues = [];
  const budget = { used: 0 };
  for (const table of present) {
    const rows = payload[table];
    const label = BACKUP_TABLE_LABELS[table];
    if (!Array.isArray(rows)) throw new BackupImportError(`备份里的「${label}」应为数组。`);
    const ids = new Set();
    data[table] = [];
    rejected[table] = 0;
    for (const [index, row] of rows.entries()) {
      const prefix = `第 ${index + 1} 条${label}`;
      if (isObject(row) && isId(row.id)) {
        if (ids.has(row.id)) throw new BackupImportError(`${prefix}的 ID 在文件中重复，请修正后重试。`);
        ids.add(row.id);
      }
      try {
        if (!isObject(row) || !isId(row.id)) throw new BackupImportError("缺少有效的 ID");
        data[table].push(normalizers[table](row, budget));
      } catch (error) {
        if (!(error instanceof BackupImportError)) throw error;
        rejected[table] += 1;
        if (issues.length < 5) issues.push(`${prefix}：${error.message}`);
      }
    }
  }
  return { version: payload.version ?? null, data, rejected, issues };
}

export function backupTimestamp(row) {
  const value = row.updatedAt || row.createdAt;
  if (typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return null;
  const day = value.slice(0, 10);
  const date = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}
