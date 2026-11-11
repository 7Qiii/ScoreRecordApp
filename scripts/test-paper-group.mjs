/**
 * paperGroupName 的行为回归测试。
 *
 * 「按卷子分列」的分组完全由卷子名推导，规则改错会静默地把不同卷子并到一列
 * （列变少、数据看起来像丢了），或者把同一套卷子拆成好几列（列炸开）。
 * 两个方向都要钉住，所以下面既有「必须合并」也有「必须不合并」。
 *
 * 跑法：node scripts/test-paper-group.mjs
 */
import { paperGroupName, buildExportMatrix } from "../src/services/excelExport.js";

const cases = [
  // Explicit cross-year mode retains the previous grouping behavior.
  [["09真题", "11真题", "12真题"], "真题", "2 位年份 + 名称，开头年份剥掉"],
  [["07年真题", "08年真题", "09年真题"], "真题", "2 位年份 + 年 + 名称"],
  [["2015 合成成绩", "2016 合成成绩"], "合成成绩", "4 位年份 + 空格 + 名称"],
  [["2015合成成绩", "2016合成成绩"], "合成成绩", "4 位年份紧贴名称"],
  [["2015年真题", "2016年真题"], "真题", "4 位年份 + 年 + 名称"],
  [["英语一2010", "英语一2011"], "英语一", "4 位年份在结尾"],
  [["真题2015年", "真题2016年"], "真题", "结尾年份带「年」"],

  // ---- 尾部序号写法 ----
  [["26张八1", "26张八2", "26张八10"], "张宇八套卷", "年份 + 裸数字序号"],
  [["张宇八套卷 第1套", "张宇八套卷 第2套"], "张宇八套卷", "第N套（带空格）"],
  [["张宇八套卷第1套", "张宇八套卷第3套"], "张宇八套卷", "第N套（不带空格）"],
  [["模拟卷第一套", "模拟卷第二套"], "模拟卷", "第 + 汉字数字 + 单位"],
  [["真题 第 12 讲", "真题 第 13 讲"], "真题", "第 N 讲（数字两侧有空格）"],
  [["模拟卷(1)", "模拟卷(2)"], "模拟卷", "半角括号数字"],
  [["模拟卷（1）", "模拟卷（2）"], "模拟卷", "全角括号数字"],
  [["模拟卷（一）", "模拟卷（二）"], "模拟卷", "括号汉字数字"],
  [["模拟卷-三", "模拟卷-四"], "模拟卷", "短横线 + 汉字数字"],
  [["模拟卷_3", "模拟卷_4"], "模拟卷", "下划线 + 数字"],
  [["强化 二", "强化 三"], "强化", "空格 + 汉字数字"],

  // ---- 必须保持原样：并了才是 bug ----
  ["英语一", "英语一", "汉字数字属于名字本身"],
  ["数学一", "数学一", "汉字数字属于名字本身"],
  ["数一", "数一", "汉字数字属于名字本身"],
  ["1800题", "1800题", "习题册名，1800 不在 19xx/20xx"],
  ["1000题", "1000题", "习题册名，数字后紧跟汉字"],
  ["660题", "660题", "习题册名，3 位数字不当年份"],
  ["2000题", "2000题", "剥完只剩 1 个字，放弃"],
  ["50题", "50题", "剥完只剩 1 个字，放弃"],
  ["408 综合模拟 01", "408 综合模拟", "3 位科目号不被当年份"],
  ["第一套真题", "第一套真题", "序号不在末尾"],
  ["数学第二轮复习", "数学第二轮复习", "序号不在末尾"],
  ["第三次模拟", "第三次模拟", "序号不在末尾"],
  ["真题", "真题", "没有年份也没有序号"],
  ["张八", "张宇八套卷", "已经没有年份了"],
  ["", "未命名", "空名兜底"]
];

let failed = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) console.log(`      实际 ${JSON.stringify(actual)}  期望 ${JSON.stringify(expected)}`);
}

for (const [input, expected, note] of cases) {
  const names = Array.isArray(input) ? input : [input];
  for (const name of names) {
    check(`${JSON.stringify(name).padEnd(26)} -> ${JSON.stringify(paperGroupName(name, { mergeYears: true })).padEnd(14)} (${note})`, paperGroupName(name, { mergeYears: true }), expected);
  }
}

// 同一套卷子的不同写法必须收敛到同一个分组名，否则仍然会裂成多列
const convergence = [
  [["张宇八套卷 第1套", "张宇八套卷第2套", "张宇八套卷(3)", "张宇八套卷（四）"], "张宇八套卷"],
  [["2026年真题第一套", "2026年真题第2套", "2026年真题 第3讲"], "真题"],
  [["09真题", "11真题", "2015年真题", "真题2016年"], "真题"],
  [["2015 合成成绩", "2016合成成绩"], "合成成绩"]
];
for (const [names, expected] of convergence) {
  const actual = new Set(names.map((name) => paperGroupName(name, { mergeYears: true })));
  check(`收敛 ${JSON.stringify(names)} -> ${JSON.stringify([...actual])}`, actual.size === 1 && actual.has(expected) ? "ok" : "no", "ok");
}

// 端到端：真的摊成列之后，分组数 / 每组条数是否符合预期
const subjects = [{ id: "math1", name: "数一", color: "#2563eb" }, { id: "p408", name: "408", color: "#7c3aed" }];
const matrixScenarios = [
  {
    note: "09/11/12 真题并成一列（用户截图 1 的场景）",
    records: [
      { id: "a", subjectId: "p408", recordType: "paper", paperName: "09真题", score: 132, fullScore: 150 },
      { id: "b", subjectId: "p408", recordType: "paper", paperName: "11真题", score: 124, fullScore: 150 },
      { id: "c", subjectId: "p408", recordType: "paper", paperName: "12真题", score: 133, fullScore: 150 }
    ],
    expect: [["真题", 3]]
  },
  {
    note: "2015/2016 合成成绩并成一列（用户截图 2 的场景）",
    records: [
      { id: "a", subjectId: "math1", recordType: "composite", paperName: "2015 合成成绩", score: 47.5, fullScore: 60 },
      { id: "b", subjectId: "math1", recordType: "composite", paperName: "2016 合成成绩", score: 45.5, fullScore: 60 }
    ],
    expect: [["合成成绩", 2]]
  },
  {
    note: "07/08/09年真题并成一列",
    records: [
      { id: "a", subjectId: "math1", recordType: "paper", paperName: "07年真题", score: 124, fullScore: 150 },
      { id: "b", subjectId: "math1", recordType: "paper", paperName: "08年真题", score: 136, fullScore: 150 },
      { id: "c", subjectId: "math1", recordType: "paper", paperName: "09年真题", score: 133, fullScore: 150 }
    ],
    expect: [["真题", 3]]
  },
  {
    note: "真题和模拟卷仍然分开两列",
    records: [
      { id: "a", subjectId: "math1", recordType: "paper", paperName: "09真题", score: 132, fullScore: 150 },
      { id: "b", subjectId: "math1", recordType: "paper", paperName: "10真题", score: 128, fullScore: 150 },
      { id: "c", subjectId: "math1", recordType: "paper", paperName: "张宇八套卷 第1套", score: 120, fullScore: 150 },
      { id: "d", subjectId: "math1", recordType: "paper", paperName: "张宇八套卷 第2套", score: 130, fullScore: 150 }
    ],
    expect: [["张宇八套卷", 2], ["真题", 2]]
  },
  {
    note: "不同科目即使同名也不并到一起",
    records: [
      { id: "a", subjectId: "math1", recordType: "paper", paperName: "09真题", score: 132, fullScore: 150 },
      { id: "b", subjectId: "p408", recordType: "paper", paperName: "11真题", score: 124, fullScore: 150 }
    ],
    expect: [["真题", 1], ["真题", 1]]
  },
  {
    note: "习题按习题册名分组，1000题 不被啃成「题」",
    records: [
      { id: "a", subjectId: "math1", recordType: "exercise", exerciseBookName: "1000题", exercisePage: "12", exerciseQuestion: "3", score: 5, fullScore: 5 },
      { id: "b", subjectId: "math1", recordType: "exercise", exerciseBookName: "1000题", exercisePage: "13", exerciseQuestion: "4", score: 4, fullScore: 5 }
    ],
    expect: [["1000题", 2]]
  }
];

for (const scenario of matrixScenarios) {
  const { groups } = buildExportMatrix({ records: scenario.records, subjects, fields: ["record", "scoreText"], mergeYears: true });
  const actual = groups.map((group) => [group.label, group.records.length]);
  check(`${scenario.note}\n      实际 ${JSON.stringify(actual)}`, JSON.stringify(actual), JSON.stringify(scenario.expect));
}


// Default mode preserves editions; aliases and sequence spelling still converge.
const editionCases = [
  ["26张八1", "2026 张宇八套卷"],
  ["27张八2", "2027 张宇八套卷"],
  ["２０２６年 张宇８套卷（２）", "2026 张宇八套卷"],
  ["张八(2026)第2套", "2026 张宇八套卷"],
  ["张宇八套卷2026版", "2026 张宇八套卷"],
  ["张八27年版", "2027 张宇八套卷"],
  ["26肖四第1套", "2026 肖秀荣四套卷"],
  ["09真题", "2009 真题"], ["真题2015年", "2015 真题"],
  ["26题专项", "26题专项"], ["2000题强化", "2000题强化"],
  ["英语一", "英语一"], ["660题", "660题"], ["408", "408"]
];
for (const [input, expected] of editionCases) check(input, paperGroupName(input), expected);
const editionRecords = ["26张八10", "2026张宇8套卷第2套", "26张八1", "27张八1", "张八1"].map((paperName, i) => ({
  id: String(i), subjectId: "math1", recordType: "paper", paperName, score: 100, fullScore: 150, date: "2026-10-30"
}));
const editions = buildExportMatrix({ records: editionRecords, subjects });
check("Different editions and unknown year stay separate", editions.groups.length, 3);
const edition26 = editions.groups.find(group => group.label === "2026 张宇八套卷");
check("Same edition aliases converge", edition26?.records.length, 3);
check("Sequence order across aliases", edition26?.records.map(record => record.id).join(","), "2,1,0");
check("Explicit merge remains available", buildExportMatrix({ records: editionRecords, subjects, mergeYears: true }).groups.length, 1);
check("Exercise and paper are separate", buildExportMatrix({ records: [editionRecords[0], { ...editionRecords[0], id: "exercise", recordType: "exercise" }], subjects }).groups.length, 2);

console.log(failed ? `\n${failed} 条不符合预期` : "\n全部通过");
process.exit(failed ? 1 : 0);
