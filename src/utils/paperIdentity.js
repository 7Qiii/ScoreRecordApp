const aliases = new Map([
  ["张八", "张宇八套卷"], ["张宇八套卷", "张宇八套卷"], ["张宇8套卷", "张宇八套卷"],
  ["张四", "张宇四套卷"], ["张宇四套卷", "张宇四套卷"], ["张宇4套卷", "张宇四套卷"],
  ["肖八", "肖秀荣八套卷"], ["肖秀荣八套卷", "肖秀荣八套卷"], ["肖秀荣8套卷", "肖秀荣八套卷"],
  ["肖四", "肖秀荣四套卷"], ["肖秀荣四套卷", "肖秀荣四套卷"], ["肖秀荣4套卷", "肖秀荣四套卷"]
]);

const sequenceRules = [
  /^(.*?)[\s\-_·#(]*第\s*([0-9]{1,2}|[一二三四五六七八九十百零〇两]+)\s*[套讲份次轮章册辑回]?\s*\)?$/,
  /^(.*?)[\s\-_·#(]+([一二三四五六七八九十百零〇两]+)\s*\)?$/,
  /^(.*?)[\s\-_·#(]*(\d{1,2})\)?$/
];

/** Edition years come from the title, never from the date the student practiced. */
export function parsePaperIdentity(value) {
  let text = String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
  let year = "";
  let sequence = null;
  // Do not interpret question counts such as 2000题 / 26题专项 as years.
  const leading = text.match(/^((?:19|20)\d{2}|\d{2})(?!\d)\s*(?:年(?:版)?|版)?\s*[-_·]?\s*/);
  if (leading) {
    const rest = text.slice(leading[0].length).trim();
    if (rest.length >= 2 && !/^(?:题|讲|章|节|套|篇|分)/.test(rest)) {
      year = normalizeYear(leading[1]);
      text = rest;
    }
  }
  if (!year) {
    const trailing = text.match(/[\s\-_·(]*((?:19|20)\d{2}|\d{2}(?=\s*(?:年|版)))\s*(?:年(?:版)?|版)?\s*\)?$/);
    if (trailing) {
      const rest = text.slice(0, trailing.index).trim();
      if (rest.length >= 2) {
        year = normalizeYear(trailing[1]);
        text = rest;
      }
    }
  }
  for (const rule of sequenceRules) {
    const match = text.match(rule);
    if (!match || /\d$/.test(match[1])) continue;
    const base = match[1].replace(/[\s\-_·#(]+$/, "").trim();
    if (base) { text = base; sequence = sequenceNumber(match[2]); break; }
  }
  // Also recognize a year between the series and sequence: 张八(2026)第2套.
  if (!year) {
    const trailing = text.match(/[\s\-_·(]*((?:19|20)\d{2}|\d{2}(?=\s*(?:年|版)))\s*(?:年(?:版)?|版)?\s*\)?$/);
    if (trailing && text.slice(0, trailing.index).trim().length >= 2) {
      year = normalizeYear(trailing[1]);
      text = text.slice(0, trailing.index).trim();
    }
  }
  const compact = text.replace(/\s+/g, "");
  const series = aliases.get(compact) || text || "未命名";
  const variant = /真题|历年|历届/.test(series) ? "true"
    : aliases.has(compact) || /mock|模拟|模考/i.test(series) ? "mock" : "";
  return { year, series, sequence, variant, label: year ? `${year} ${series}` : series };
}

function sequenceNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value in digits) return digits[value];
  const parts = value.split("十");
  if (parts.length === 2) return (digits[parts[0]] || 1) * 10 + (digits[parts[1]] || 0);
  return null;
}

function normalizeYear(value) {
  if (value.length === 4) return value;
  return `${Number(value) >= 80 ? "19" : "20"}${value}`;
}

export function paperGroupName(value, { mergeYears = false } = {}) {
  const identity = parsePaperIdentity(value);
  return mergeYears ? identity.series : identity.label;
}
