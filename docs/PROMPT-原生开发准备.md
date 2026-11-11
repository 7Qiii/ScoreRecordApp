# 任务书：原生 iOS 开发准备（Capacitor 接线，业务逻辑零改动）

> 给 Codex / Claude Code 直接粘贴用的任务书。
> 本轮只做一件事：让**同一份** Vue 代码在 WKWebView 里正确跑起来。
> 不碰数据模型、不碰视觉、不改路由。web 端行为必须逐字节不变。

---

## 背景

- 路径：`G:\11408App`，`exam-tracker-console` v3.0.0
- 栈：Vue 3 + Vite 8 + Pinia + Vue Router（**hash 模式**）+ Dexie/IndexedDB 本地优先，Supabase 可选云同步，Cloudflare R2 存图，Vercel 托管 API 与前端
- 8 条路由：`/` `/records` `/records/:id` `/mistakes` `/mistakes/:id` `/subjects` `/backup` `/login`
- 目标设备：**iPad 为主**，iPhone 次之
- 线上：https://exam-tracker-gray.vercel.app/#/
- 现状：PWA 已完成（manifest + sw.js + 全套 apple-touch-startup-image），**Capacitor 一个文件都没有**

这一轮的价值不在"能跑起来"，而在"跑起来之后不会静默丢数据"。
WebView 和浏览器有四个真实差异，每个都会踩坑：

1. `window.location.origin` 在容器里是 `capacitor://localhost` —— 所有拼 origin 的地方全废
2. WKWebView 里 `<a download>` 不触发下载 —— 备份和 Excel 导出会"点了没反应"
3. WKWebView 不支持注册 Service Worker —— 现在无条件注册会静默失败
4. IndexedDB 里存大 Blob 在 iOS 上会被容量挤压 —— 错题图片是唯一的大对象

---

## 已核实的事实（行号可核对，不必重复查）

| 结论 | 依据 |
| --- | --- |
| 仓库无任何 Capacitor 配置 | 根目录无 `capacitor.config.*`；全库搜 `capacitor` 只命中 `README.md` |
| AI 解析用相对路径调 API | `src/services/aiReview.js:22` → `fetch("/api/ai-review")` |
| 图片上传用相对路径调 API | `src/services/r2.js:2` → `fetch("/api/r2-upload")` |
| Supabase 代理地址绑死 origin | `src/services/supabase.js:6` → `${window.location.origin}/api/supabase-proxy` |
| 邮件确认回跳绑死 origin | `src/services/supabase.js:47` → `${window.location.origin}/login?confirmed=1` |
| 启动层靠 standalone 判定 | `index.html:185` 判定 `data-standalone`，不命中就 `launch.remove()`；`App.vue:416` 派发 `score-record:launch-ready` |
| Service Worker 无条件注册 | `src/main.js:35-39` |
| 图片以 Blob 存 IndexedDB | 写入：`storage.js:177`、`tracker.js:845 / 895 / 934`；读取：`ImageUploader.vue:19-24`、`MistakeDetailPage.vue:61-70` |
| 导出依赖 `<a download>` | `src/utils/downloadBackup.js:26-31`、`src/services/excelExport.js:703-710` |
| 安全区已经铺好 | `index.html:5` 的 `viewport-fit=cover`；`tablet.css:130/179`、`design-system.css:2868`、`main.css:88` |
| 弹窗高度用 100dvh | `src/styles/main.css:6847` |
| 路由是 hash 模式 | `src/router/index.js:39` → `createWebHashHistory()` |
| `check` 链有 17 个脚本 | `package.json:11` |
| `.env.example` 缺失 | `README.md:51` 写着"Vercel 配置 `.env.example` 中列出的环境变量"，但仓库里没有这个文件 |

---

## 任务

### 1. 抽出单一 API 基址（先做这个，后面全依赖它）

新增 `src/services/apiBase.js`：

```js
// 容器内 window.location.origin 是 capacitor://localhost，
// 任何拼 origin 的写法在原生里都会指向一个不存在的服务器。
// 所以 API 基址必须能被环境变量接管，web 下留空即为相对路径。
export const API_BASE = String(import.meta.env.VITE_API_BASE || "").replace(/\/+$/, "");

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}

// 只在"真的跑在原生容器里"时为 true。web 与 PWA 一律 false，
// 这样所有分支保护都天然走原来的代码路径。
export const isNative = Boolean(globalThis.Capacitor?.isNativePlatform?.());
```

改造三处，**只改地址来源，不改请求体**：

- `src/services/aiReview.js:22` → `fetch(apiUrl("/api/ai-review"), ...)`
- `src/services/r2.js:2` → `fetch(apiUrl("/api/r2-upload"), ...)`
- `src/services/supabase.js:6` → 代理开关打开时用 `apiUrl("/api/supabase-proxy")`，否则仍用 `supabaseUrl`

规则：`VITE_API_BASE` 为空时，拼出来的字符串必须与现在**完全一致**（含开头的 `/`），
否则 `scripts/check-*.mjs` 里对请求路径的断言会挂。

### 2. 认证回跳（否则注册完就回不来了）

`src/services/supabase.js:47` 的 `emailRedirectTo` 改为读 `VITE_AUTH_REDIRECT`，原生下取值
`score-record://login?confirmed=1`；web 下为空则退回现在的 `${origin}/login?confirmed=1`。

新增 `src/services/nativeAuth.js`：

- 用 `@capacitor/app` 的 `App.addListener("appUrlOpen", ...)` 接住回跳
- 把 URL 归一成 hash 路由后 `router.replace()`。**两种形态都要处理**：
  `score-record://login?confirmed=1` 和 `score-record:///login?confirmed=1`
- 非原生环境整个模块不加载（用 `if (isNative) import(...)` 懒加载，别让 web 首屏多背一个插件）

iOS 侧在 `ios/App/App/Info.plist` 注册 `CFBundleURLTypes` → `CFBundleURLSchemes` = `score-record`。
Supabase 后台的 Redirect URLs 白名单也要加上这个 scheme（写进交付说明，别只改代码）。

### 3. 启动屏交接（不要闪白）

`index.html:185` 现在的逻辑是"不是 standalone 就把 `#app-launch` 删掉"。
原生容器里 `navigator.standalone` 为 `undefined`、`display-mode` 也不是 `standalone`，
于是启动动画层会被直接删掉 —— 冷启动会出现"SplashScreen 退场 → 白屏 → 首帧"。

改法：保留条件扩展为

```js
var isNative = Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
if (!document.documentElement.hasAttribute("data-standalone") && !isNative) { launch.remove(); return; }
```

`App.vue:416` 的 `score-record:launch-ready` **事件名、派发时机一律不动** —— 它是对外契约，
README 已经写死了，后续 iOS 容器靠它交接。

Capacitor 的 SplashScreen 插件配 `launchAutoHide: false`，在同一个事件上 `hide()`，
让原生启动图和网页入场动画用同一个时间点收尾。

### 4. Service Worker 加守卫

`src/main.js:35-39` 外层加 `if (!isNative)`。WKWebView 里 `navigator.serviceWorker.register`
会失败（或被静默忽略），失败后 catch 掉看似无害，但会留下"以为有离线缓存、其实没有"的错觉，
而且 `dist/sw.js` 还会被 `cap sync` 拷进包里白白占体积。

同时确认 `public/sw.js` 的预缓存清单不会因为新增 `/api` 基址而失效 —— 它只列静态资源，不改。

### 5. 图片落到文件系统（只做新写入，不做历史迁移）

现状：`images` 表直接存 `blob`（`storage.js:177`、`tracker.js:845`）。原生下要改成"文件系统存本体，
IndexedDB 只存路径"。

新增 `src/services/nativeImageStore.js`，只暴露三个函数：

```js
export async function saveImage(id, blob)   // → { nativePath }，写到 Directory.Data/images/<id>.webp
export async function imageSrc(image)       // → 可直接给 <img src> 的地址（原生用 Capacitor.convertFileSrc）
export async function removeImage(image)    // 删文件；文件不存在不报错
```

改动点，全部走 `isNative` 分支，web 分支代码保持原样：

- 写入：`src/services/storage.js:168-194`（`addImages` / `addImageEntries`）、`src/stores/tracker.js:845 / 895 / 934`
- 读取：`src/components/ImageUploader.vue:19-24`、`src/pages/MistakeDetailPage.vue:61-70`
- 导出：`src/services/storage.js:196-202` 的 `blobToDataUrl` 要能读 `nativePath`，否则备份里**图片全丢**

原生行的形态：`{ id, ownerType, ownerId, name, type, size, nativePath, createdAt }`，`blob` 置 `null`。
`backup.js:204` 现在要求"有 blob 或有 url"，要放宽成"有 blob / 有 nativePath / 有 url"三者其一。

**明确不做历史迁移。** 老的 blob 行继续能读（`imageSrc` 里 blob 优先），迁移单独一轮做，
前提是先有"一键导出含图备份"这个安全网。

### 6. 导出改走系统分享

`<a download>` 在 WKWebView 里点了没反应，而备份导出是用户唯一的救命通道。

新增 `src/utils/saveFile.js`：

- web：原逻辑原封不动搬进来（`createObjectURL` + `a.click()` + 延时 `revoke`）
- 原生：`Filesystem.writeFile` 到 `Directory.Cache`，再 `Share.share({ url })`

调用点改为 `saveFile(blob, filename)`：
`src/utils/downloadBackup.js:26-37`、`src/services/excelExport.js:703-710`。

原生分支要把 `downloadBackup` 的返回值语义保住（`"backup" / "archive" / "cancelled"`），
`markBackupExported()` 的调用时机不变 —— 这条被 `scripts/check-backup-import.mjs` 间接覆盖。

### 7. 键盘与安全区

- `capacitor.config.json` 里 `ios.contentInset: "never"`。默认值会让 WKWebView 自己再补一层内边距，
  和 CSS 里已有的 `env(safe-area-inset-top)`（`design-system.css:2868`）叠加，顶部会多出一条白。
- Keyboard 插件 `resize: "body"`。
- 验证 `MistakeForm` / `RecordForm` 的底部操作栏在键盘弹出时**可点**（不是被顶到屏幕外）。
- `main.css:6847` 的 `100dvh` 在 WKWebView 里键盘弹出时不会变，弹窗最大高度要用
  `visualViewport.height` 兜一层，或者监听键盘事件改 CSS 变量。**不要**改成 `100vh`（那会引入 iOS 地址栏抖动问题，网页端反而退化）。

### 8. 脚手架

依赖（仅这些，不要多加）：`@capacitor/core` `@capacitor/cli` `@capacitor/ios`
`@capacitor/app` `@capacitor/filesystem` `@capacitor/share` `@capacitor/keyboard` `@capacitor/splash-screen`

`capacitor.config.json` 关键字段：

```json
{
  "appId": "app.scorerecord.tracker",
  "appName": "Score Record",
  "webDir": "dist",
  "backgroundColor": "#dfe7f0",
  "ios": { "contentInset": "never", "backgroundColor": "#dfe7f0" },
  "plugins": { "SplashScreen": { "launchAutoHide": false, "backgroundColor": "#dfe7f0" } }
}
```

`package.json` 加脚本：`ios:sync`（`vite build && cap sync ios`）、`ios:open`（`cap open ios`）。

`.gitignore` 追加：`ios/App/Pods/`、`ios/App/public/`、`ios/DerivedData/`、`ios/App/App/public/`。

### 9. 补 `.env.example`（README 引用了但文件不存在）

列六个变量，每个都写清"web 怎么填 / 原生怎么填"：

```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_SUPABASE_PROXY=        # "false" 可关闭代理；web 默认开启
VITE_API_BASE=              # web 留空（相对路径）；原生必须填 https://exam-tracker-gray.vercel.app
VITE_AUTH_REDIRECT=         # web 留空；原生填 score-record://login?confirmed=1
```

### 10. 加一个静态守卫脚本

新增 `scripts/check-native.mjs`，纯静态扫描（不需要浏览器），断言：

1. `src/` 下不存在裸的 `fetch("/api/`
2. `supabase.js` 里不再用 `window.location.origin` 拼 API 地址
3. `main.js` 的 `serviceWorker.register` 在 `isNative` 守卫之内
4. `capacitor.config.json` 存在且 `webDir === "dist"`
5. `index.html` 的启动层判定包含 `isNativePlatform`
6. `Info.plist` 含 `score-record` scheme（文件存在时才断言）

加进 `package.json:11` 的 `check` 链，写成 `node scripts/check-native.mjs`。

---

## 明确不做（这些是坑，不是懒）

| 不做 | 原因 |
| --- | --- |
| 改路由为 history 模式 | hash 模式在容器里天然可用，改 history 要配 `server.hostname` 与回退，纯亏 |
| 改 `vite.config.js` 的 `base: "./"` | `/sw.js`、`/manifest.webmanifest`、全套 `/splash/*.png` 都是绝对路径，改 base 会打断它们，收益为零 |
| 换 uni-app / Tauri / SwiftUI 重写 | 现有 17 个 check 脚本和整套设计系统都绑在 Vue 上 |
| 历史图片迁移 | 需要先有含图备份做安全网，单独一轮 |
| App Store 上架、签名证书、Privacy Manifest | 下一轮；本轮只到"模拟器 + 真机能装" |
| 动 `api/state.js` | Vercel Blob 旧通道，与原生无关，动它只会引入风险 |

---

## 约束

- 不改数据模型字段名、不改 Dexie 版本号、不改 `supabase/schema.sql`
- 不改 8 条路由结构、不改 `App.vue` 的 `score-record:launch-ready` 契约
- 不引入 UI 库、不新增硬编码样式、视觉与 web 完全一致
- 所有原生分支必须用 `isNative` 守卫，**web 代码路径一行不改**
- 注释写中文，说明**为什么**，不复述做了什么（与现有代码风格一致）
- 不提交 `ios/App/Pods`、`ios/App/public` 等 `cap sync` 产物

---

## 验收

```bash
npm run build                        # 通过
npm run check                        # 17 个脚本全绿（新增 check-native 后为 18）
node scripts/verify-ui.mjs           # 8 路由 × 6 尺寸 = 48 组合，0 问题（证明 web 没被改坏）
```

Xcode iPad 模拟器 + 真机：

- 冷启动：启动图 → 入场动画 → 首帧，**全程无白屏**
- 断网：能录成绩、能写错题、能打开已有图片
- 杀进程重开：图片还在（验证 Filesystem 落盘生效）
- 导出 JSON 备份 / 导出 Excel：弹出系统分享面板，文件能存进"文件"App
- 邮件确认链接：点开回到 App 并落在 `/login?confirmed=1`
- 横竖屏切换：无内容溢出、无安全区错位
- 键盘弹出：错题表单底部按钮可点

---

## 交付说明

改完请列出：

1. 每个文件改了什么（按 web / 原生分支分开写）
2. 哪几处是"web 行为完全未变"的保护点，以及凭什么证明（对应哪条 check）
3. 模拟器截图：冷启动序列、导出分享面板、断网录入
4. 没做的部分及原因（尤其是历史图片迁移与上架）
5. 需要人工在 Xcode / Supabase 后台做的操作清单（scheme 注册、Redirect URLs、Team 与 Bundle ID）
