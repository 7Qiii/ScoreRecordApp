import { createRouter, createWebHashHistory } from "vue-router";
import { confirmDiscardChanges } from "../composables/useUnsavedChanges";

/**
 * 页面全部懒加载。
 *
 * 以前是 8 个静态 import，于是所有页面的代码都堆在入口 chunk 里 ——
 * 实测入口 628K raw / 190K gzip，而用户每次只看得见其中一页。
 * 改成动态 import 后入口降到 140K gzip 左右，各页按需加载。
 *
 * 注意：光改这里不够。动态 import 会把跨页面共享的 lucide 图标切成一堆
 * 0.1K 的碎片，请求数从 4 涨到 16 —— 必须配合 vite.config.js 里的
 * manualChunks 把图标并回去，否则省了字节、赔了请求数。
 */
const DashboardPage = () => import("../pages/DashboardPage.vue");
const RecordsPage = () => import("../pages/RecordsPage.vue");
const RecordDetailPage = () => import("../pages/RecordDetailPage.vue");
const MistakesPage = () => import("../pages/MistakesPage.vue");
const MistakeDetailPage = () => import("../pages/MistakeDetailPage.vue");
const LoginPage = () => import("../pages/LoginPage.vue");
const SubjectsPage = () => import("../pages/SubjectsPage.vue");
const BackupPage = () => import("../pages/BackupPage.vue");

/**
 * 这次导航是不是「浏览器返回 / 前进」触发的。
 *
 * 必须在 createRouter 之前注册：vue-router 内部也监听 popstate，两个处理器在同一个
 * 事件里先后跑完，而导航守卫还要等到后面的微任务才执行 —— 所以这里打的标记
 * 到守卫跑的时候一定已经就绪。
 */
let popNavigation = false;
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    popNavigation = true;
  });
}

const router = createRouter({
  history: createWebHashHistory(),
  /**
   * 切页面时的滚动位置。
   *
   * 不写这一段的话，vue-router 不会动滚动位置，而 hash 路由又不会触发浏览器
   * 的默认置顶 —— 结果是新页面「继承」上一页的滚动位置：在成绩列表翻到一半
   * 点「科目」，会直接落在科目页的中段，看着像页面坏了。
   *
   * savedPosition 是浏览器前进/后退时 vue-router 记下的位置：返回列表时要
   * 恢复它，否则用户翻到一半点进详情、退回来又得重新翻。
   * 两种情况必须分开处理，只写 return { top: 0 } 会把「返回」也一并重置掉。
   *
   * 第一行的「同一个 fullPath」是给弹窗用的：弹窗打开时会往历史里压一条同地址
   * 的记录，好让手机的返回手势去关弹窗（见 composables/useDialogA11y.js）。
   * 那条记录被弹掉时地址没变，但 vue-router 仍可能来问滚动位置。
   *
   * 实测过：Chrome 里不写这一行也不会跳（浏览器的 scrollRestoration 默认会把这
   * 条同地址记录的滚动位置还原回来）。留着是为了**不依赖浏览器的默认行为** ——
   * iOS Safari 在这块的做法和 Chrome 不一样，而 iPad 正是目标设备之一。
   * 语义上也更准确：没换页就别动滚动。
   */
  scrollBehavior(to, from, savedPosition) {
    if (to.fullPath === from.fullPath) return false;
    if (savedPosition) return savedPosition;
    if (to.path === from.path) return false;
    return { top: 0, left: 0 };
  },
  routes: [
    { path: "/", name: "dashboard", component: DashboardPage },
    { path: "/login", name: "login", component: LoginPage },
    { path: "/records", name: "records", component: RecordsPage },
    { path: "/records/:id", name: "record-detail", component: RecordDetailPage },
    { path: "/mistakes", name: "mistakes", component: MistakesPage },
    { path: "/mistakes/:id", name: "mistake-detail", component: MistakeDetailPage },
    { path: "/subjects", name: "subjects", component: SubjectsPage },
    { path: "/backup", name: "backup", component: BackupPage }
  ]
});

/**
 * 换页前的「填了一半」保护。
 *
 * 录入表单散在 5 处（首页内联、成绩列表面板、成绩详情、错题列表、错题详情），
 * 每一处都能被「顺手点一下侧栏」带走。逐个页面去写 onBeforeRouteLeave 一定会漏，
 * 而「换页」这件事本身只有路由层能统一兜住 —— 表单只管把「我脏了」登记进来
 * （见 composables/useUnsavedChanges.js）。
 *
 * 「同一个 path 就直接放行」是必须的：弹窗打开时会往历史里压一条**同地址**的
 * 记录（useDialogA11y），那条记录被弹掉时 vue-router 会收到一次 popstate 并且
 * 来问守卫。不排除的话，确认框自己关掉的那一下就会再触发一次守卫 —— 递归地问
 * 「要不要放弃」。
 *
 * 返回 false 会中止这次导航，地址栏保持不动（hash 路由下 pushState 还没发生）。
 */
router.beforeEach(async (to, from) => {
  // 「返回 / 前进」一律放行，不拦。
  //
  // 不是偷懒，是拦了会更糟：这种导航是浏览器**先把地址改掉**、再通知我们的，
  // 想中止就得靠 vue-router 自己补一次 history.go(-delta) 退回去。而它算 delta
  // 用的是 history.state.position，那个值在 buildState 里是拿 history.length
  // 记的 —— history.length 只增不减，本项目的弹窗每次打开都会 pushState
  // （见 useDialogA11y），压过几次之后这个差值就偏了。
  //
  // 实测到过：在填了一半的表单上按返回、再选「继续编辑」，地址栏退到了**上一个**
  // 页面（#/subjects），画面却还停在首页 —— 地址和画面不一致，比不拦更难理解。
  // 拦不住的时候宁可放行：返回手势本来就是「我要走」的明确表达。
  if (popNavigation) return true;
  if (to.path === from.path) return true;
  return confirmDiscardChanges();
});

// 标记只对「这一次」导航有效，导航结束后就清掉。
// 中止的导航也会走到 afterEach（带一个 failure 参数），所以这里能清干净。
router.afterEach(() => {
  popNavigation = false;
});

export default router;
