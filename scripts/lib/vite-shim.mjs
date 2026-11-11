/**
 * 让 Node 能直接跑 src/ 下的源码。
 *
 * 源码是给 Vite 写的，有两处 Node 不认，这个文件把两处都补上：
 *
 * 1. 不带扩展名的相对导入。
 *    源码里写的是 `from "../services/storage"`。Vite 会帮你补 `.js`，
 *    Node 的 ESM 解析器不会 —— 它要求写全。于是 store 在 Node 里根本
 *    import 不进来，1354 行的数据层就一直没法测。
 *    与其为了测试去改几十个源文件的 import，不如在解析阶段补上。
 *
 * 2. `import.meta.env`。
 *    这是 Vite 注入的，Node 里 `import.meta.env` 是 undefined，
 *    读 `.VITE_SUPABASE_URL` 会直接抛错。这里在加载时把它换成
 *    `globalThis.__viteEnv`，测试脚本自己往里塞需要的值即可。
 *
 * 两个钩子都只在「Node 原本会失败」或「确实命中了 Vite 专有语法」时介入，
 * 其余情况一律走 Node 原生的逻辑。
 */
// 刻意用字符串而不是正则来「有没有命中」：带 /g 的正则是有状态的，
// 先 .test() 再 .replace() 会让 lastIndex 残留在上一次的位置，
// 下一次 .test() 就可能从中间开始扫、误判成「没命中」。
const VITE_ENV_TOKEN = "import.meta.env";
const VITE_ENV_PATTERN = /import\.meta\.env/g;

/** 相对路径、且没写扩展名时才补 .js —— 补错了反而会掩盖真正的找不到模块。 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    const hasExtension = /\.[a-z0-9]+$/i.test(specifier);
    if (!isRelative || hasExtension) throw error;
    return nextResolve(`${specifier}.js`, context);
  }
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);

  if (!url.startsWith("file:") || !url.includes("/src/")) return result;
  if (result.format !== "module" || typeof result.source === "undefined") return result;

  const source = result.source.toString();
  if (!source.includes(VITE_ENV_TOKEN)) return result;

  return {
    ...result,
    source: source.replace(VITE_ENV_PATTERN, "globalThis.__viteEnv")
  };
}
