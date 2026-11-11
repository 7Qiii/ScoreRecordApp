# Score Record App

Score Record 的独立 iPad / iPhone App 工程，使用 Vue 3、Vite 和 Capacitor 8。iOS 工程在 `ios/`，Vue 页面在 `src/`，两者一起构建成本地安装包。

本地开发目录为 `G:\ScoreRecordApp`，GitHub 仓库为 `7Qiii/ScoreRecordApp`。网页工程位于 `G:\11408App`，由 `7Qiii/Exam-Tracker` 单独维护。

## 开发和构建

需要 Node.js 22.12 或更新版本。浏览器预览用于检查 App 页面和录入交互。

```sh
npm ci
npm run dev
npm run build
```

在安装了 Xcode 26 或更新版本的 macOS 上同步并打开 iOS 工程。

```sh
npm run ios:sync
npm run ios:open
```

在 Xcode 选择 `App` scheme 和 iPad 模拟器。真机安装前，在 **Signing & Capabilities** 选择自己的 Team，确认暂用的 Bundle ID `app.scorerecord.tracker` 可用。

## 验证

```sh
npm run check
npm run check:ui
```

浏览器检查脚本沿用原工程的本机 Playwright 路径。iPad Simulator Smoke Test 工作流会在 GitHub 的 macOS runner 上安装依赖、同步资源、编译、安装并启动 App，随后保存模拟器截图。

本机档案使用 IndexedDB。冷启动先由 iOS 启动屏交给已绘制的网页启动层，再由 `score-record:launch-ready` 事件交给首页。原生启动屏和网页启动层各有超时。

## 当前阶段与后续接线

当前可验证本地录入和启动链路。设备验收需要检查断网录入、已有图片、杀进程重开、横竖屏和键盘弹出时的保存按钮。

API 服务由网页工程的 Vercel 后端提供。下一阶段配置生产 HTTPS API、账号回跳和系统文件分享，再验证含图 JSON 备份导出后重新导入，随后评估图片存储和 TestFlight 测试。

环境变量示例见 `.env.example`。可在已忽略的 `.env.ios.local` 中保存本机配置，使用本地测试数据验收。原生容器与网页分别保存各自的本机档案，数据迁移使用经过验收的备份或云同步流程。
