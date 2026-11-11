/**
 * 静态模板绑定检查。
 *
 * 用途：大改模板（尤其是插槽、动态组件、v-for 作用域）之后，构建通过并不代表
 * 模板里引用的变量真的存在——未解析的标识符会被编译成 `_ctx.xxx`，运行时只是
 * 渲染成空值，不会报错。这个脚本把每个 SFC 的 <script setup> 绑定收集起来，
 * 再用带 prefixIdentifiers 的模板编译器编译一遍，扫出残留的 `_ctx.*`。
 *
 * 用法：
 *   node scripts/check-bindings.mjs            # 检查 src 下全部 .vue
 *   node scripts/check-bindings.mjs src/App.vue
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";

const ROOT = process.cwd();
const TARGETS = process.argv.slice(2);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".vue")) out.push(full);
  }
  return out;
}

const files = TARGETS.length
  ? TARGETS.map((item) => join(ROOT, item))
  : walk(join(ROOT, "src"));

let failed = 0;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const { descriptor, errors } = parse(source, { filename: file });

  if (errors.length) {
    console.log(`✗ ${relative(ROOT, file)} — SFC 解析失败`);
    errors.forEach((error) => console.log(`    ${error.message}`));
    failed += 1;
    continue;
  }

  if (!descriptor.template) continue;

  let bindings = {};
  try {
    const script = compileScript(descriptor, { id: file });
    bindings = script.bindings || {};
  } catch (error) {
    console.log(`✗ ${relative(ROOT, file)} — <script setup> 编译失败`);
    console.log(`    ${error.message}`);
    failed += 1;
    continue;
  }

  const { code } = compileTemplate({
    id: file,
    filename: file,
    source: descriptor.template.content,
    compilerOptions: {
      prefixIdentifiers: true,
      bindingMetadata: bindings
    }
  });

  // 模板里真正能用的标识符都会在编译期被替换掉；剩下的 `_ctx.x` 就是没绑上的。
  // 例外：`$slots` / `$emit` 这类实例属性本来就挂在 _ctx 上，属于正常情况。
  const unresolved = [...new Set(code.match(/_ctx\.[A-Za-z_$][\w$]*/g) || [])].filter(
    (name) => !name.startsWith("_ctx.$")
  );

  if (unresolved.length) {
    console.log(`✗ ${relative(ROOT, file)}`);
    unresolved.forEach((name) => console.log(`    ${name}`));
    failed += 1;
  } else {
    console.log(`✓ ${relative(ROOT, file)}`);
  }
}

console.log(
  failed ? `\n${failed} 个文件存在未绑定的模板标识符。` : `\n全部 ${files.length} 个文件模板绑定正常。`
);
process.exit(failed ? 1 : 0);
