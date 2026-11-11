import { paperGroupName, parsePaperIdentity } from "../utils/paperIdentity.js";
export { paperGroupName } from "../utils/paperIdentity.js";
// 带 .js 后缀：scripts/test-paper-group.mjs 直接用 node 加载这个文件，
// 裸模块路径在 Node 的 ESM 里解析不了（Vite 能，Node 不能）。
import { readingCellText, stripNoteMeta } from "../utils/recordDisplay.js";

export const exportColumnGroups = [
  {
    id: "basic",
    label: "基础信息",
    columns: [
      { id: "subject", label: "科目", width: 14 },
      { id: "year", label: "年份", width: 10 },
      { id: "record", label: "名称", width: 32 },
      { id: "date", label: "日期", width: 14 },
      { id: "type", label: "记录类型", width: 12 },
      { id: "variant", label: "真题/模拟", width: 12 }
    ]
  },
  {
    id: "score",
    label: "成绩信息",
    columns: [
      { id: "scoreText", label: "分数", width: 14 },
      { id: "score", label: "得分", width: 12 },
      { id: "fullScore", label: "满分", width: 12 },
      { id: "rate", label: "得分率", width: 12 }
    ]
  },
  {
    id: "exercise",
    label: "习题详情",
    columns: [
      { id: "exerciseBook", label: "习题册", width: 22 },
      { id: "exercisePage", label: "页码", width: 10 },
      { id: "exerciseQuestion", label: "题号", width: 10 }
    ]
  },
  {
    id: "review",
    label: "复盘信息",
    columns: [
      { id: "duration", label: "用时", width: 14 },
      { id: "reading", label: "阅读", width: 16 },
      { id: "sync", label: "同步状态", width: 14 },
      { id: "note", label: "备注", width: 38 }
    ]
  }
];

export const exportColumnOptions = exportColumnGroups.flatMap((group) => group.columns);

/**
 * 「按卷子分列」模式下，每一列里可以放哪些字段。
 * 只保留「同一条记录各不相同」的值字段 —— 科目 / 年份 / 卷型这类
 * 同组内基本一致的字段放进去只会重复占列。
 */
export const exportMatrixFieldOptions = [
  { id: "record", label: "名称", width: 22 },
  { id: "scoreText", label: "分数", width: 13 },
  { id: "score", label: "得分", width: 10 },
  { id: "fullScore", label: "满分", width: 10 },
  { id: "rate", label: "得分率", width: 10 },
  { id: "date", label: "日期", width: 12 },
  { id: "duration", label: "用时", width: 12 },
  { id: "note", label: "备注", width: 22 }
];

export const defaultMatrixFields = ["record", "scoreText"];

function paperGroupSource(record) {
  if (record?.recordType === "exercise") return record.exerciseBookName || record.paperName || "";
  return record.paperName || "";
}

function naturalCompare(a, b) {
  return String(a ?? "").localeCompare(String(b ?? ""), "zh-Hans-CN", { numeric: true, sensitivity: "base" });
}

/**
 * 把成绩摊成「一列一套卷子」的矩阵。预览和真正的 Excel 导出都调用它，
 * 保证所见即所得。
 *
 * 返回：
 *   fields  实际使用的子字段（按 exportMatrixFieldOptions 顺序）
 *   groups  每个卷子组，span = 该组占多少列
 *   rows    [{ index, cells: [{ fieldId, groupKey, text, value }] }]，cells 顺序与 groups 展开一致
 *   average 平均行，结构与 rows 相同（无数据时为 null）
 */
export function buildExportMatrix({ records = [], subjects = [], fields = defaultMatrixFields, mergeYears = false } = {}) {
  const subjectMap = new Map(subjects.map((subject) => [subject.id, subject]));
  const picked = exportMatrixFieldOptions.filter((field) => fields.includes(field.id));
  const usedFields = picked.length ? picked : exportMatrixFieldOptions.filter((field) => defaultMatrixFields.includes(field.id));

  const groupMap = new Map();
  records.forEach((record) => {
    const subject = subjectMap.get(record.subjectId);
    const label = paperGroupName(paperGroupSource(record), { mergeYears });
    const key = `${record.subjectId || "unknown"}::${record.recordType || "paper"}::${label}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        key,
        label,
        subjectName: subject?.name || "未分类",
        subjectColor: subject?.color || "",
        records: []
      });
    }
    groupMap.get(key).records.push(record);
  });

  const groups = [...groupMap.values()]
    .sort((a, b) => naturalCompare(a.subjectName, b.subjectName) || naturalCompare(a.label, b.label))
    .map((group) => {
      group.records.sort(
        (a, b) =>
          naturalCompare(parsePaperIdentity(paperGroupSource(a)).year, parsePaperIdentity(paperGroupSource(b)).year) ||
          (parsePaperIdentity(paperGroupSource(a)).sequence ?? -1) - (parsePaperIdentity(paperGroupSource(b)).sequence ?? -1) ||
          naturalCompare(recordTitle(a), recordTitle(b)) ||
          String(a.date || "").localeCompare(String(b.date || "")) ||
          String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
      );
      return { ...group, span: usedFields.length };
    });

  const rowCount = groups.reduce((max, group) => Math.max(max, group.records.length), 0);
  const rows = [];
  for (let index = 0; index < rowCount; index += 1) {
    const cells = [];
    groups.forEach((group) => {
      const record = group.records[index];
      usedFields.forEach((field) => {
        cells.push({
          fieldId: field.id,
          groupKey: group.key,
          text: record ? matrixCellText(field.id, record) : "",
          value: record ? matrixCellValue(field.id, record) : null
        });
      });
    });
    rows.push({ key: `matrix-row-${index}`, index: index + 1, cells });
  }

  return { fields: usedFields, groups, rows, average: buildMatrixAverage(groups, usedFields) };
}

function buildMatrixAverage(groups, usedFields) {
  if (!groups.length) return null;
  const cells = [];
  groups.forEach((group) => {
    const scored = group.records.filter((record) => numberOrZero(record.fullScore) > 0);
    const totalScore = scored.reduce((sum, record) => sum + numberOrZero(record.score), 0);
    const totalFullScore = scored.reduce((sum, record) => sum + numberOrZero(record.fullScore), 0);
    const divisor = scored.length || group.records.length;
    const avgScore = divisor ? totalScore / divisor : 0;
    const avgFullScore = divisor ? totalFullScore / divisor : 0;
    const avgRate = totalFullScore ? totalScore / totalFullScore : 0;

    usedFields.forEach((field) => {
      let text = "";
      if (field.id === "record") text = "平均分";
      else if (field.id === "score") text = formatScoreNumber(avgScore);
      else if (field.id === "fullScore") text = formatScoreNumber(avgFullScore);
      else if (field.id === "rate") text = totalFullScore ? `${Math.round(avgRate * 100)}%` : "—";
      else if (field.id === "scoreText") text = `${formatScoreNumber(avgScore)} / ${formatScoreNumber(avgFullScore)}`;
      else if (field.id === "note") text = `${group.records.length} 条`;
      cells.push({ fieldId: field.id, groupKey: group.key, text, value: null });
    });
  });
  return { key: "matrix-average", index: null, cells };
}

function matrixCellText(fieldId, record) {
  switch (fieldId) {
    case "record":
      return recordTitle(record);
    case "scoreText":
      return `${formatScoreNumber(record.score)} / ${formatScoreNumber(record.fullScore)}`;
    case "score":
      return formatScoreNumber(record.score);
    case "fullScore":
      return formatScoreNumber(record.fullScore);
    case "rate": {
      const full = numberOrZero(record.fullScore);
      return full ? `${Math.round((numberOrZero(record.score) / full) * 100)}%` : "—";
    }
    case "date":
      return record.date || "";
    case "duration":
      return formatDurationValue(record.durationMinutes);
    case "reading":
      return readingCellText(record);
    case "note":
      return stripNoteMeta(record.note);
    default:
      return "";
  }
}

function matrixCellValue(fieldId, record) {
  if (fieldId === "score") return numberOrZero(record.score);
  if (fieldId === "fullScore") return numberOrZero(record.fullScore);
  if (fieldId === "rate") {
    const full = numberOrZero(record.fullScore);
    return full ? numberOrZero(record.score) / full : null;
  }
  return null;
}

function formatDurationValue(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}小时${rest ? `${rest}分钟` : ""}` : `${minutes}分钟`;
}

export const exportThemeOptions = [
  { id: "ocean", label: "清爽蓝", header: "2563EB", accent: "DBEAFE", stripe: "F8FBFF" },
  { id: "forest", label: "森林绿", header: "047857", accent: "D1FAE5", stripe: "F7FCF9" },
  { id: "sunset", label: "暖橙色", header: "C2410C", accent: "FFEDD5", stripe: "FFFBF7" },
  { id: "graphite", label: "石墨灰", header: "344054", accent: "E4E7EC", stripe: "F8F9FB" }
];

export async function exportRecordsToExcel({
  records = [],
  subjects = [],
  columns = exportColumnOptions.map((column) => column.id),
  sheetMode = "single",
  layout = "rows",
  matrixFields = defaultMatrixFields,
  mergeYears = false,
  theme = "ocean",
  filename = "成绩导出",
  includeSummary = false
} = {}) {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const themeConfig = exportThemeOptions.find((item) => item.id === theme) || exportThemeOptions[0];
  const subjectMap = new Map(subjects.map((subject) => [subject.id, subject]));
  const selectedColumns = exportColumnOptions.filter((column) => columns.includes(column.id));
  const isMatrix = layout === "matrix";
  const safeRecords = isMatrix
    ? [...records]
    : [...records].sort((a, b) => compareExportRecordsByName(a, b, subjectMap));

  workbook.creator = "Score Record";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.properties.date1904 = false;

  let groups =
    sheetMode === "subject"
      ? groupRecordsBySubject(safeRecords, subjectMap)
      : [{ name: "成绩明细", records: safeRecords }];
  if (!groups.length) groups = [{ name: "成绩明细", records: [] }];

  groups.forEach((group) => {
    if (isMatrix) {
      addMatrixSheet(workbook, group.name, group.records, subjectMap, matrixFields, themeConfig, mergeYears);
    } else {
      addRecordSheet(workbook, group.name, group.records, subjectMap, selectedColumns, themeConfig);
    }
  });

  if (includeSummary) addSummarySheet(workbook, safeRecords, themeConfig);

  const buffer = await workbook.xlsx.writeBuffer();
  downloadBuffer(buffer, `${normalizeFilename(filename)}.xlsx`);
}

function addSummarySheet(workbook, records, theme) {
  const sheet = workbook.addWorksheet("导出概览");
  const scoredRecords = records.filter((record) => Number(record.fullScore) > 0);
  const totalScore = scoredRecords.reduce((sum, record) => sum + numberOrZero(record.score), 0);
  const totalFullScore = scoredRecords.reduce((sum, record) => sum + numberOrZero(record.fullScore), 0);
  const averageRate = totalFullScore ? totalScore / totalFullScore : 0;
  const subjectCount = new Set(records.map((record) => record.subjectId)).size;

  sheet.columns = [
    { header: "项目", key: "label", width: 22 },
    { header: "数值", key: "value", width: 32 }
  ];
  sheet.addRows([
    { label: "导出时间", value: new Date().toLocaleString("zh-CN") },
    { label: "成绩记录", value: records.length },
    { label: "科目数量", value: subjectCount },
    { label: "累计得分", value: totalScore },
    { label: "累计满分", value: totalFullScore },
    { label: "总体得分率", value: averageRate }
  ]);
  styleHeader(sheet.getRow(1), theme.header);
  sheet.getCell("B2").numFmt = "@";
  sheet.getCell("B7").numFmt = "0.0%";
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: "B7" };
}

function addRecordSheet(workbook, name, records, subjectMap, selectedColumns, theme) {
  const sheet = workbook.addWorksheet(normalizeSheetName(name, workbook));
  const headers = selectedColumns.map((column) => column.label);
  const keys = selectedColumns.map((column) => column.id);

  sheet.addRow(headers);
  records.forEach((record, index) => {
    const row = sheet.addRow(keys.map((key) => getCellValue(key, record, subjectMap)));
    styleRecordRow(row, record, subjectMap, theme, index, keys);
  });

  const averageRow = buildAverageRow(records, keys);
  if (averageRow) {
    const row = sheet.addRow(keys.map((key) => averageRow[key] ?? ""));
    styleAverageRow(row, theme, keys);
  }

  selectedColumns.forEach((column, index) => {
    sheet.getColumn(index + 1).width = column.width;
  });
  styleHeader(sheet.getRow(1), theme.header);
  sheet.getRow(1).height = 25;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: `${columnName(Math.max(selectedColumns.length, 1))}${records.length + 1}` };
  sheet.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalDpi: 200,
    verticalDpi: 200
  };
}

/**
 * 「按卷子分列」工作表：序号列 + 每个卷子组一列块。
 * 表头两行：第一行是组名（跨该组所有子列合并），第二行是子字段名。
 */
function addMatrixSheet(workbook, name, records, subjectMap, matrixFields, theme, mergeYears) {
  const sheet = workbook.addWorksheet(normalizeSheetName(name, workbook));
  const matrix = buildExportMatrix({ records, subjects: [...subjectMap.values()], fields: matrixFields, mergeYears });
  const { groups, fields } = matrix;

  if (!groups.length) {
    sheet.addRow(["没有可导出的成绩"]);
    sheet.getColumn(1).width = 28;
    return;
  }

  const topRow = sheet.addRow(["序号", ...groups.flatMap((group) => [group.label, ...Array(group.span - 1).fill("")])]);
  const subRow = sheet.addRow(["", ...groups.flatMap(() => fields.map((field) => field.label))]);
  topRow.height = 26;
  subRow.height = 20;

  // 序号列跨两行合并
  sheet.mergeCells(1, 1, 2, 1);

  let cursor = 2;
  groups.forEach((group) => {
    if (group.span > 1) sheet.mergeCells(1, cursor, 1, cursor + group.span - 1);
    const color = toArgb(group.subjectColor || theme.header);
    const master = topRow.getCell(cursor);
    master.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
    master.font = { name: "Microsoft YaHei UI", bold: true, size: 11, color: { argb: "FFFFFFFF" } };
    master.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    master.border = { bottom: { style: "thin", color: { argb: `FF${mixHex(color, "FFFFFF", 0.5)}` } } };
    cursor += group.span;
  });

  const indexHead = topRow.getCell(1);
  indexHead.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${theme.header}` } };
  indexHead.font = { name: "Microsoft YaHei UI", bold: true, size: 11, color: { argb: "FFFFFFFF" } };
  indexHead.alignment = { vertical: "middle", horizontal: "center" };

  subRow.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    if (columnNumber === 1) return;
    const groupIndex = groupIndexForColumn(groups, columnNumber);
    const group = groups[groupIndex];
    const color = toArgb(group?.subjectColor || theme.header);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${mixHex(color, "FFFFFF", 0.82)}` } };
    cell.font = { name: "Microsoft YaHei UI", bold: true, size: 10, color: { argb: color } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });

  const rowStyleByField = (cell, fieldId) => {
    cell.font = { name: "Microsoft YaHei UI", size: 11 };
    cell.alignment = { vertical: "middle", wrapText: fieldId === "record" || fieldId === "note" };
    cell.border = { bottom: { style: "hair", color: { argb: "FFE4E7EC" } } };
    if (fieldId === "score" || fieldId === "fullScore") cell.numFmt = "0.0";
    if (fieldId === "rate") cell.numFmt = "0%";
    if (fieldId === "record" || fieldId === "scoreText" || fieldId === "date" || fieldId === "duration") {
      cell.alignment = { vertical: "middle", horizontal: fieldId === "record" ? "left" : "center", wrapText: fieldId === "record" };
    }
  };

  matrix.rows.forEach((row, rowIndex) => {
    const sheetRow = sheet.addRow([row.index, ...row.cells.map((cell) => (cell.value === null ? cell.text : cell.value))]);
    sheetRow.height = 22;
    sheetRow.getCell(1).alignment = { vertical: "middle", horizontal: "center" };
    sheetRow.getCell(1).font = { name: "Microsoft YaHei UI", size: 10, color: { argb: "FF98A2B3" } };
    row.cells.forEach((cell, cellIndex) => {
      const target = sheetRow.getCell(cellIndex + 2);
      rowStyleByField(target, cell.fieldId);
      if (rowIndex % 2 === 1) {
        target.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${theme.stripe}` } };
      }
      if (cell.fieldId === "scoreText" || cell.fieldId === "score") {
        const group = groups[groupIndexForColumn(groups, cellIndex + 2)];
        const color = toArgb(group?.subjectColor || theme.header);
        target.font = { name: "Microsoft YaHei UI", bold: true, size: 11, color: { argb: color } };
      }
    });
  });

  if (matrix.average) {
    const sheetRow = sheet.addRow(["平均", ...matrix.average.cells.map((cell) => cell.text)]);
    sheetRow.height = 23;
    sheetRow.getCell(1).alignment = { vertical: "middle", horizontal: "center" };
    sheetRow.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      cell.font = { name: "Microsoft YaHei UI", bold: true, size: 11, color: { argb: `FF${theme.header}` } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${mixHex(toArgb(theme.header), "FFFFFF", 0.9)}` } };
      cell.border = { top: { style: "medium", color: { argb: `FF${theme.header}` } } };
      if (columnNumber === 1) return;
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });
  }

  sheet.getColumn(1).width = 6;
  let widthCursor = 2;
  groups.forEach((group) => {
    fields.forEach((field) => {
      sheet.getColumn(widthCursor).width = field.width;
      widthCursor += 1;
    });
  });

  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: 2 }];
  sheet.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalDpi: 200,
    verticalDpi: 200
  };
}

function groupIndexForColumn(groups, columnNumber) {
  let cursor = 2;
  for (let index = 0; index < groups.length; index += 1) {
    const next = cursor + groups[index].span;
    if (columnNumber >= cursor && columnNumber < next) return index;
    cursor = next;
  }
  return groups.length - 1;
}

function styleHeader(row, color) {
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${color}` } };
    cell.font = { name: "Microsoft YaHei UI", bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = { bottom: { style: "medium", color: { argb: `FF${color}` } } };
  });
}

function styleRecordRow(row, record, subjectMap, theme, index, keys) {
  const subject = subjectMap.get(record.subjectId);
  const subjectColor = toArgb(subject?.color || theme.header);
  row.height = 22;

  row.eachCell((cell) => {
    const key = keys[cell.column - 1];
    cell.font = { name: "Microsoft YaHei UI", size: 11 };
    cell.alignment = { vertical: "middle", wrapText: key === "record" || key === "note" };
    cell.border = { bottom: { style: "hair", color: { argb: "FFE4E7EC" } } };
    if (index % 2 === 1) {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${theme.stripe}` } };
    }
    if (key === "score" || key === "fullScore") cell.numFmt = "0.0";
    if (key === "year" || key === "scoreText") cell.alignment = { vertical: "middle", horizontal: "center", wrapText: false };
  });

  const subjectColumn = keys.indexOf("subject") + 1;
  if (subjectColumn > 0) {
    const cell = row.getCell(subjectColumn);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${mixHex(subjectColor, "FFFFFF", 0.82)}` } };
    cell.font = { name: "Microsoft YaHei UI", bold: true, size: 11, color: { argb: subjectColor } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  }

  const rateColumn = keys.indexOf("rate") + 1;
  if (rateColumn > 0) {
    const cell = row.getCell(rateColumn);
    cell.numFmt = "0%";
    cell.font = { name: "Microsoft YaHei UI", bold: true, size: 11, color: { argb: subjectColor } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${mixHex(subjectColor, "FFFFFF", 0.9)}` } };
  }

  const scoreTextColumn = keys.indexOf("scoreText") + 1;
  if (scoreTextColumn > 0) {
    const cell = row.getCell(scoreTextColumn);
    cell.font = { name: "Microsoft YaHei UI", bold: true, size: 11, color: { argb: subjectColor } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${mixHex(subjectColor, "FFFFFF", 0.91)}` } };
  }
}

function styleAverageRow(row, theme, keys) {
  row.height = 23;
  row.eachCell((cell) => {
    const key = keys[cell.column - 1];
    cell.font = { name: "Microsoft YaHei UI", bold: true, size: 11, color: { argb: "FF2563EB" } };
    cell.alignment = { vertical: "middle", wrapText: key === "record" || key === "note" };
    cell.border = {
      top: { style: "medium", color: { argb: `FF${theme.header}` } },
      bottom: { style: "hair", color: { argb: "FFE4E7EC" } }
    };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${mixHex(toArgb(theme.header), "FFFFFF", 0.9)}` } };
    if (key === "score" || key === "fullScore") cell.numFmt = "0.0";
    if (key === "rate") cell.numFmt = "0%";
    if (key === "subject" || key === "record" || key === "scoreText") {
      cell.font = { name: "Microsoft YaHei UI", bold: true, size: 11, color: { argb: toArgb(theme.header) } };
    }
    if (key === "subject") cell.alignment = { vertical: "middle", horizontal: "center" };
    if (key === "scoreText") cell.alignment = { vertical: "middle", horizontal: "center" };
  });
}

function buildAverageRow(records, keys) {
  const scoredRecords = records.filter((record) => Number(record.fullScore) > 0);
  if (!records.length) return null;
  const totalScore = scoredRecords.reduce((sum, record) => sum + numberOrZero(record.score), 0);
  const totalFullScore = scoredRecords.reduce((sum, record) => sum + numberOrZero(record.fullScore), 0);
  const divisor = scoredRecords.length || records.length;
  const averageScore = divisor ? totalScore / divisor : 0;
  const averageFullScore = divisor ? totalFullScore / divisor : 0;
  const averageRate = totalFullScore ? totalScore / totalFullScore : 0;
  const row = Object.fromEntries(keys.map((key) => [key, ""]));
  row.subject = "平均";
  row.record = "平均分";
  row.scoreText = `${formatScoreNumber(averageScore)} / ${formatScoreNumber(averageFullScore)}`;
  row.score = averageScore;
  row.fullScore = averageFullScore;
  row.rate = averageRate;
  row.note = `共 ${records.length} 条`;
  return row;
}

function getCellValue(key, record, subjectMap) {
  const subject = subjectMap.get(record.subjectId);
  switch (key) {
    case "subject":
      return subject?.name || "未分类";
    case "year":
      return getYear(record);
    case "date":
      return record.date || "";
    case "record":
      return recordTitle(record);
    case "type":
      return recordTypeLabel(record);
    case "variant":
      return recordVariantLabel(record);
    case "scoreText":
      return `${formatScoreNumber(record.score)} / ${formatScoreNumber(record.fullScore)}`;
    case "score":
      return numberOrZero(record.score);
    case "fullScore":
      return numberOrZero(record.fullScore);
    case "rate":
      return numberOrZero(record.fullScore) ? numberOrZero(record.score) / numberOrZero(record.fullScore) : 0;
    case "exerciseBook":
      return record.exerciseBookName || "";
    case "exercisePage":
      return record.exercisePage || "";
    case "exerciseQuestion":
      return record.exerciseQuestion || "";
    case "duration":
      return formatDuration(record.durationMinutes);
    case "reading":
      return readingCellText(record);
    case "sync":
      return record.pendingSync ? "待同步" : "已同步";
    case "note":
      return stripNoteMeta(record.note);
    default:
      return "";
  }
}

function groupRecordsBySubject(records, subjectMap) {
  const groups = new Map();
  records.forEach((record) => {
    const name = subjectMap.get(record.subjectId)?.name || "未分类";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(record);
  });
  return [...groups.entries()].map(([name, groupedRecords]) => ({ name, records: groupedRecords }));
}

function recordTitle(record) {
  if (record.recordType !== "exercise") return record.paperName || "未命名成绩";
  return [record.exerciseBookName || record.paperName, record.exercisePage ? `P${record.exercisePage}` : "", record.exerciseQuestion ? `第 ${record.exerciseQuestion} 题` : ""]
    .filter(Boolean)
    .join(" · ");
}

function recordTypeLabel(record) {
  if (record.recordType === "composite") return "合成";
  return record.recordType === "exercise" ? "习题" : "试卷";
}

function recordVariantLabel(record) {
  if (record.recordType !== "paper" || record.subjectId !== "math1") return "";
  const raw = String(record.paperVariant || "").toLowerCase();
  if (raw === "true") return "真题";
  if (raw === "mock") return "模拟卷";
  return "";
}

function getYear(record) {
  const dateYear = String(record.date || "").match(/\d{4}/)?.[0];
  if (dateYear) return Number(dateYear);
  const titleYear = String(record.paperName || "").match(/(?:19|20)\d{2}/)?.[0];
  return titleYear ? Number(titleYear) : "";
}

function formatDuration(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return "未记录";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}小时${rest ? `${rest}分钟` : ""}` : `${minutes}分钟`;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function formatScoreNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Number.isInteger(number) ? String(number) : number.toFixed(1).replace(/\.0$/, "");
}

function compareExportRecordsByName(a, b, subjectMap) {
  return (
    String(recordTitle(a) || "").localeCompare(String(recordTitle(b) || ""), "zh-Hans-CN", {
      numeric: true,
      sensitivity: "base"
    }) ||
    String(subjectMap.get(a.subjectId)?.name || "").localeCompare(String(subjectMap.get(b.subjectId)?.name || ""), "zh-Hans-CN", {
      numeric: true,
      sensitivity: "base"
    }) ||
    String(getYear(a) || "").localeCompare(String(getYear(b) || "")) ||
    String(a.date || "").localeCompare(String(b.date || "")) ||
    String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
  );
}

function normalizeFilename(value) {
  return String(value || "成绩导出").trim().replace(/[\\/:*?"<>|]+/g, "_") || "成绩导出";
}

function normalizeSheetName(value, workbook) {
  const base = String(value || "成绩明细").replace(/[\\/*?:[\]]/g, "").slice(0, 31) || "成绩明细";
  let name = base;
  let index = 2;
  while (workbook.worksheets.some((sheet) => sheet.name === name)) {
    const suffix = `-${index}`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    index += 1;
  }
  return name;
}

function columnName(index) {
  let name = "";
  let value = index;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function toArgb(color) {
  const value = String(color || "").replace("#", "").trim();
  return `FF${/^[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : "2563EB"}`;
}

function mixHex(firstArgb, secondHex, amount) {
  const first = firstArgb.slice(2);
  const second = secondHex.replace("#", "");
  const channel = (offset) =>
    Math.round(parseInt(first.slice(offset, offset + 2), 16) * (1 - amount) + parseInt(second.slice(offset, offset + 2), 16) * amount)
      .toString(16)
      .padStart(2, "0");
  return `${channel(0)}${channel(2)}${channel(4)}`.toUpperCase();
}

function downloadBuffer(buffer, filename) {
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
