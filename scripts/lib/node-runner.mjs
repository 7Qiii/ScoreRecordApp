/**
 * 让校验脚本用 `node scripts/xxx.mjs` 就能直接跑，不用记一长串参数。
 *
 * 做两件事：
 *
 * 1. 注册 Vite 兼容钩子（见 vite-shim.mjs）。
 *    必须在 import src/ 之前执行。这里靠的是「静态 import 按书写顺序求值」——
 *    所以这个文件要放在所有 `import "../src/..."` 的最前面，
 *    而且 src/ 下的模块要用 `await import()` 动态加载（动态导入发生在
 *    模块体执行时，一定晚于本文件）。
 *
 * 2. 屏蔽 MODULE_TYPELESS_PACKAGE_JSON 警告。
 *    src/ 下是 ESM，但 package.json 没有 "type": "module"（根目录有
 *    vite.config.js、api/ 下还有 Vercel 函数，动这个字段有部署风险，
 *    不值得为一条提示去改）。于是 Node 每次都要「猜」一遍并打印警告。
 *    这里只过滤这一条，其它警告照常放出来 —— 不能用 --no-warnings，
 *    那会把真正有用的告警一起吞掉。
 */
import { register } from "node:module";

register("./vite-shim.mjs", import.meta.url);

const originalEmit = process.emit;
process.emit = function emit(name, data, ...rest) {
  if (name === "warning" && data?.code === "MODULE_TYPELESS_PACKAGE_JSON") return false;
  return originalEmit.call(this, name, data, ...rest);
};
