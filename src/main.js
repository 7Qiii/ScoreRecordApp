import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import router from "./router";
import { useTrackerStore } from "./stores/tracker";
import "./styles/main.css";
import "./styles/mistakes-refresh.css";
import "./styles/tablet.css";
// design-system.css 必须最后加载：它定义全局 token，并用同一批类名覆盖前面的样式，
// 是整站视觉的最终裁决层（详见文件头注释）。
import "./styles/design-system.css";

const isNativeIos = document.documentElement.hasAttribute("data-native-ios");

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);

let lastNoticeAt = 0;
function reportUnexpectedError(error, source) {
  if (error?.name === "AbortError") return;
  console.error(source, error);
  const now = Date.now();
  if (now - lastNoticeAt < 3000) return;
  lastNoticeAt = now;
  useTrackerStore(pinia).notify("有一项操作未能完成。可重试，或前往「备份与恢复」查看本机档案。", "error", 8000);
}

app.config.errorHandler = (error, _instance, info) => reportUnexpectedError(error, info);
window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  reportUnexpectedError(event.reason, "未处理的异步错误");
});
router.onError((error) => reportUnexpectedError(error, "页面导航异常"));
app.use(router).mount("#app");

if (isNativeIos) {
  import("@capacitor/splash-screen").then(async ({ SplashScreen }) => {
    // 等启动层至少绘制一帧，再让 iOS 启动屏交给网页动画。
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await SplashScreen.hide({ fadeOutDuration: 0 });
    document.dispatchEvent(new Event("score-record:native-splash-hidden"));
  }).catch((error) => console.error("iOS 启动屏交接失败", error));
} else if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
