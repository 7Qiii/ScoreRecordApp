<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, RouterView, START_LOCATION, useRoute, useRouter } from "vue-router";
import {
  AlertTriangle,
  BarChart3,
  BookOpenCheck,
  ClipboardList,
  Cloud,
  Database,
  Home,
  LogIn,
  Menu,
  Monitor,
  Moon,
  PenLine,
  RefreshCw,
  Search,
  Settings,
  Share,
  Sun,
  Upload,
  X
} from "@lucide/vue";
import AnnouncementCenter from "./components/AnnouncementCenter.vue";
import RouteErrorBoundary from "./components/RouteErrorBoundary.vue";
import DsConfirmHost from "./components/ds/DsConfirmHost.vue";
import DsEmptyState from "./components/ds/DsEmptyState.vue";
import { useDialogA11y } from "./composables/useDialogA11y";
import { useDismissable } from "./composables/useDismissable";
import { useTrackerStore } from "./stores/tracker";
import { normalizeSearch, recordTitle } from "./utils/recordDisplay";

const store = useTrackerStore();
const route = useRoute();
const router = useRouter();
/** 正文容器。换页后把焦点移到这里，见下面的 route watcher */
const mainRef = ref(null);
const loadFailed = ref(false);
const isSidebarOpen = ref(false);
const isOnline = ref(typeof navigator === "undefined" ? true : navigator.onLine);
const globalSearch = ref("");
const isGlobalSearchOpen = ref(false);
const searchBoxRef = ref(null);
const themeMode = ref("system");
const themeStorageKey = "exam-tracker-theme-mode";
// 状态栏颜色跟随解析后的模式，否则安卓/iOS 的状态栏和页面底色永远对不上。
// 取的是各自 --bg 的值：浅色 #dfe7f0（main.css 的 :root[data-theme="light"]），
// 深色 #0f141b（design-system.css 的 :root[data-theme="dark"]）。
const THEME_COLOR = { light: "#dfe7f0", dark: "#0f141b" };
let systemThemeQuery = null;
const signatureStorageKey = "exam-tracker-signature";
const signatureText = ref("稳住节奏，今天继续推进");
const signatureDraft = ref("");
const isSignatureSplashVisible = ref(false);
const isSignatureDialogOpen = ref(false);
let signatureTimer = null;
const themeOptions = [
  { value: "system", label: "跟随系统", icon: Monitor },
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon }
];

// 侧栏按「学习 / 管理」分组，6 个入口不再平铺成一坨。
const navSections = [
  {
    label: "学习",
    items: [
      { to: "/", label: "总览", title: "总览", icon: Home },
      { to: "/records", label: "成绩", title: "成绩", icon: ClipboardList },
      { to: "/mistakes", label: "错题", title: "错题", icon: BookOpenCheck }
    ]
  },
  {
    label: "管理",
    items: [
      { to: "/subjects", label: "科目", title: "科目", icon: Settings },
      { to: "/backup", label: "备份", title: "备份", icon: Database },
      { to: "/login", label: "同步", title: "同步", icon: LogIn }
    ]
  }
];

const navItems = navSections.flatMap((section) => section.items);

// 移动端底部标签栏只保留 5 个高频入口；「同步」仍可从顶栏账号区进入。
const primaryNavPaths = ["/", "/records", "/mistakes", "/subjects", "/backup"];
const primaryNavItems = computed(() =>
  primaryNavPaths.map((path) => navItems.find((item) => item.to === path)).filter(Boolean)
);

// 路由是扁平注册的，vue-router 不会把 /records 认成 /records/123 的父级，
// 详情页里侧栏会丢掉选中态，所以这里自己判定一次。
function isNavActive(item) {
  if (item.to === "/") return route.path === "/";
  return route.path === item.to || route.path.startsWith(`${item.to}/`);
}

const pageTitle = computed(() => {
  const exact = navItems.find((item) => item.to === route.path);
  if (exact) return exact.title;
  const nested = navItems.find((item) => item.to !== "/" && route.path.startsWith(`${item.to}/`));
  return nested?.title || "详情";
});

const latestRecord = computed(() => {
  let latest;
  for (const record of store.records) {
    if (!latest || (String(record.date || "").localeCompare(String(latest.date || "")) ||
      String(record.createdAt || "").localeCompare(String(latest.createdAt || ""))) > 0) {
      latest = record;
    }
  }
  return latest;
});
const sidebarScore = computed(() => (latestRecord.value ? `${latestRecord.value.score}/${latestRecord.value.fullScore}` : "--"));
const sidebarHint = computed(() => (latestRecord.value ? latestRecord.value.paperName : "还没有成绩记录"));
const userInitial = computed(() => (store.user?.email || "未").slice(0, 1).toUpperCase());
const syncLabel = computed(() => (store.user ? store.user.email : "未登录"));
const syncStateText = computed(() => {
  if (store.syncError) return "同步失败";
  if (store.user) return store.lastSyncedAt ? "已同步" : "已登录";
  return store.syncMode === "local" ? "本地模式" : "未登录";
});
const syncStateTitle = computed(() => {
  if (store.syncError) return store.syncError;
  if (store.lastSyncedAt) return `${store.deviceName} · ${store.autoSyncState} · 最后同步：${new Date(store.lastSyncedAt).toLocaleString("zh-CN")}`;
  return store.user ? "快速上传本地待同步数据" : "登录后开启多设备同步";
});
const globalSearchResults = computed(() => {
  const keyword = normalizeSearch(globalSearch.value);
  if (!keyword) return [];
  const results = [];
  for (const record of store.records) {
    const subject = store.subjectName(record.subjectId);
    const title = recordTitle(record);
    const haystack = normalizeSearch([title, record.paperName, record.note, subject, record.score, record.fullScore, record.date].join(" "));
    if (!haystack.includes(keyword)) continue;
    results.push({
      id: `record-${record.id}`,
      type: "成绩",
      title,
      meta: `${subject} · ${record.score}/${record.fullScore}`,
      to: `/records/${record.id}`
    });
    if (results.length === 4) break;
  }
  const limit = Math.min(results.length + 4, 6);
  for (const mistake of store.mistakes) {
    const subject = store.subjectName(mistake.subjectId);
    const haystack = normalizeSearch([mistake.title, mistake.knowledgePoint, mistake.analysis, subject].join(" "));
    if (!haystack.includes(keyword)) continue;
    results.push({
      id: `mistake-${mistake.id}`,
      type: "错题",
      title: mistake.title,
      meta: `${subject} · ${mistake.knowledgePoint || "未分类"}`,
      to: `/mistakes/${mistake.id}`
    });
    if (results.length === limit) break;
  }
  return results;
});

async function syncNow() {
  try {
    await store.syncNow();
  } catch (error) {
    store.syncError = error.message || "同步失败";
    store.notify(store.syncError, "error", 6000);
  }
}

function toggleSidebar() {
  isSidebarOpen.value = !isSidebarOpen.value;
}

function closeSidebar() {
  isSidebarOpen.value = false;
}

async function openGlobalResult(item = globalSearchResults.value[0]) {
  if (!item) return;
  if (route.path !== item.to && await router.push(item.to)) return;
  globalSearch.value = "";
  closeGlobalSearch();
}

/**
 * 收起搜索建议。
 *
 * 之前只有「选中一条结果」和「路由变化」会收起它 —— 输入几个字之后
 * 点页面别处，那个浮层会一直挂在那儿挡住下面的内容。
 */
function closeGlobalSearch() {
  isGlobalSearchOpen.value = false;
}

/**
 * 搜索区内切换焦点时保留结果，离开搜索区后收起浮层。
 *
 * 不能直接 closeGlobalSearch：结果项就在这个浮层里，键盘用户按 Tab 从输入框
 * 移到结果上时，输入框同样会失焦 —— 之前一失焦就收起，浮层先没了，结果项
 * 对键盘来说等于不存在。所以只在焦点真的离开整个搜索框时才收。
 * relatedTarget 为空（点到页面空白、或浮层被移除）也算离开。
 */
function onSearchFocusOut(event) {
  const next = event.relatedTarget;
  if (next && searchBoxRef.value?.contains(next)) return;
  closeGlobalSearch();
}

/**
 * 搜索浮层的键盘操作。
 *
 * ↑↓ 在输入框和结果之间移动（从输入框按 ↑ 直接落到最后一条），Escape 收起。
 * Enter 不用管：焦点在输入框时走 form 的 submit（打开第一条），
 * 焦点在结果项时按钮自己会触发 click。
 */
function onSearchKeydown(event) {
  const root = searchBoxRef.value;
  if (!root || event.isComposing || event.keyCode === 229) return;

  if (event.key === "Escape") {
    if (!isGlobalSearchOpen.value) return;
    event.preventDefault();
    root.querySelector("input")?.focus();
    closeGlobalSearch();
    return;
  }

  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  if (!isGlobalSearchOpen.value) return;
  const items = [...root.querySelectorAll(".global-search-result")];
  if (!items.length) return;

  // 拦掉默认行为，否则光标会在输入框里跳到行首/行尾
  event.preventDefault();
  const current = items.indexOf(document.activeElement);
  const step = event.key === "ArrowDown" ? 1 : -1;
  const next =
    current === -1
      ? step === 1
        ? 0
        : items.length - 1
      : (current + step + items.length) % items.length;
  items[next].focus();
}

useDismissable(isGlobalSearchOpen, searchBoxRef, { onClose: closeGlobalSearch, closeOnEscape: false });

/* ------------------------------------------------------------------ *
 * iOS「添加到主屏幕」引导
 *
 * 只提两件事：**只有 iOS Safari 提**，**只有还没装到主屏幕时提**。
 *   - iOS 上所有浏览器都跑 WebKit，但「添加到主屏幕」只有 Safari 有，
 *     微信 / QQ / UC / Chrome(iOS) 都做不到 —— 在那儿提示只会让人白找一通。
 *   - 已经装好了（standalone）就没必要再提。
 *   - 关掉之后记在 localStorage，不再打扰。
 * 桌面浏览器永远不满足第一个条件，所以这条提示不会出现在任何审计里 ——
 * 它由 scripts/check-pwa.mjs 用 iPhone UA 单独验。
 * ------------------------------------------------------------------ */

const IOS_HINT_KEY = "exam-tracker-ios-install-hint-dismissed";
const isIosSafari = ref(false);
const isInstalled = ref(false);
// 默认当成「已关掉」：探测是在 onMounted 里做的，先当关掉可以避免首帧闪一下。
const isInstallHintDismissed = ref(true);

function detectInstallContext() {
  if (typeof navigator === "undefined") return;
  const ua = navigator.userAgent || "";
  // iPadOS 13+ 的 UA 是 Macintosh，只能靠「Mac 平台 + 多点触控」认出来
  const isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  // 只认 Safari：其他 iOS 浏览器都在 UA 里带自己的标记
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|MicroMessenger|QQBrowser|UCBrowser|DingTalk|Weibo/.test(ua);
  isIosSafari.value = isIos && isSafari;
  isInstalled.value = document.documentElement.matches("[data-standalone], [data-native-ios]");
  try {
    isInstallHintDismissed.value = localStorage.getItem(IOS_HINT_KEY) === "1";
  } catch (error) {
    // 隐私模式下 localStorage 会抛错：当作已关掉，不弹
    isInstallHintDismissed.value = true;
  }
}

const showInstallHint = computed(
  () => isIosSafari.value && !isInstalled.value && !isInstallHintDismissed.value
);

function dismissInstallHint() {
  isInstallHintDismissed.value = true;
  try {
    localStorage.setItem(IOS_HINT_KEY, "1");
  } catch (error) {
    /* 存不下就算了，至少这次会话不再显示 */
  }
}

function normalizeThemeMode(value) {
  return ["system", "light", "dark"].includes(value) ? value : "system";
}

// 「跟随系统」不是第三种外观，它只是「按系统在浅色 / 深色里挑一个」。
//
// 以前它靠 CSS 的 @media (prefers-color-scheme: dark) 兜底，而 design-system.css
// 最后加载、里面的裸 :root 浅色 token 和媒体查询里的 :root 优先级相同却更靠后，
// 于是系统是深色时页面反而渲染成浅色 —— 而且还是和「浅色」模式不同的第三种样子。
// 现在统一在这里解析成 light / dark 再写 data-theme，三种模式只剩两套外观。
function resolveThemeMode(mode) {
  const normalized = normalizeThemeMode(mode);
  if (normalized !== "system") return normalized;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyThemeMode(mode) {
  if (typeof document === "undefined") return;
  const resolved = resolveThemeMode(mode);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLOR[resolved] || THEME_COLOR.light);
}

function setThemeMode(mode) {
  const normalized = normalizeThemeMode(mode);
  themeMode.value = normalized;
  applyThemeMode(normalized);
  try {
    localStorage.setItem(themeStorageKey, normalized);
  } catch {
    // 主题仍在当前页面生效。
  }
}

// 停在「跟随系统」时，系统临时切换深浅（比如到了日落时间）页面要立刻跟上。
function handleSystemThemeChange() {
  if (themeMode.value === "system") applyThemeMode("system");
}

function watchSystemTheme() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  systemThemeQuery.addEventListener?.("change", handleSystemThemeChange);
}

function showSignatureSplash() {
  if (signatureTimer) window.clearTimeout(signatureTimer);
  isSignatureSplashVisible.value = true;
  signatureTimer = window.setTimeout(() => {
    isSignatureSplashVisible.value = false;
    signatureTimer = null;
  }, 2800);
}

function openSignatureDialog() {
  signatureDraft.value = signatureText.value;
  isSignatureDialogOpen.value = true;
}

function closeSignatureDialog() {
  isSignatureDialogOpen.value = false;
}

// 手写弹窗只挂 role="dialog" 并不会限制焦点，键盘行为统一走这个 composable
const signatureDialogRef = ref(null);
useDialogA11y(isSignatureDialogOpen, signatureDialogRef, { onClose: closeSignatureDialog });

function saveSignature() {
  const next = signatureDraft.value.trim() || "稳住节奏，今天继续推进";
  signatureText.value = next;
  localStorage.setItem(signatureStorageKey, next);
  closeSignatureDialog();
  showSignatureSplash();
}

watch(
  () => route.path,
  () => {
    closeSidebar();
    isGlobalSearchOpen.value = false;
    // 换页后把焦点移到正文。
    // 不移动的话焦点会掉回 body：键盘用户按 Tab 得从文档最开头、
    // 也就是侧栏那一长串导航重新走一遍，才够得到刚打开的详情页。
    // preventScroll 是必须的 —— 否则聚焦会把页面滚回正文顶部，
    // 和 router 的 scrollBehavior 抢方向盘（返回列表时位置就保不住了）。
    nextTick(() => mainRef.value?.focus({ preventScroll: true }));
  }
);

function updateOnlineState() {
  isOnline.value = navigator.onLine;
  store.notify(isOnline.value ? "网络已恢复。" : "当前离线，操作会先保存在本地。", isOnline.value ? "success" : "info");
}

// >=1024px 时侧栏变成常驻的图标导航条（见 tablet.css），
// 如果竖屏时抽屉是打开的，旋转到横屏后要收起来，否则 .open 样式会残留。
function syncSidebarForViewport() {
  if (window.innerWidth >= 1024) closeSidebar();
}

async function loadArchive() {
  loadFailed.value = false;
  try {
    await store.load();
  } catch (error) {
    console.error("本机档案读取失败", error);
    loadFailed.value = true;
  }
}

watch(
  () => loadFailed.value || (store.isReady && router.currentRoute.value !== START_LOCATION),
  () => document.dispatchEvent(new Event("score-record:launch-ready")),
  { once: true, flush: "post" }
);

onMounted(() => {
  detectInstallContext();
  try {
    setThemeMode(localStorage.getItem(themeStorageKey) || "system");
    signatureText.value = localStorage.getItem(signatureStorageKey) || signatureText.value;
  } catch {
    setThemeMode("system");
  }
  watchSystemTheme();
  loadArchive();
  window.addEventListener("online", updateOnlineState);
  window.addEventListener("offline", updateOnlineState);
  window.addEventListener("resize", syncSidebarForViewport);
  window.addEventListener("orientationchange", syncSidebarForViewport);
});

onBeforeUnmount(() => {
  systemThemeQuery?.removeEventListener?.("change", handleSystemThemeChange);
  systemThemeQuery = null;
  if (signatureTimer) window.clearTimeout(signatureTimer);
  window.removeEventListener("online", updateOnlineState);
  window.removeEventListener("offline", updateOnlineState);
  window.removeEventListener("resize", syncSidebarForViewport);
  window.removeEventListener("orientationchange", syncSidebarForViewport);
});
</script>

<template>
  <div class="app-shell">
    <button
      v-if="isSidebarOpen"
      class="sidebar-backdrop"
      type="button"
      aria-label="关闭导航"
      @click="closeSidebar"
    />

    <aside class="sidebar" :class="{ open: isSidebarOpen }">
      <div class="sidebar-head">
        <RouterLink class="brand" to="/" @click="closeSidebar">
          <span class="brand-mark">SR</span>
          <span>
            <strong>Score Record</strong>
            <small>Study OS</small>
          </span>
        </RouterLink>
        <button class="drawer-close" type="button" aria-label="关闭导航" @click="closeSidebar">
          <X :size="18" />
        </button>
      </div>

      <RouterLink class="brand desktop-brand" to="/">
        <span class="brand-mark">SR</span>
        <span>
          <strong>Score Record</strong>
          <small>Study OS</small>
        </span>
      </RouterLink>

      <template v-for="section in navSections" :key="section.label">
        <p class="sidebar-section-label">{{ section.label }}</p>
        <nav class="nav-list" :aria-label="section.label">
          <RouterLink
            v-for="item in section.items"
            :key="item.to"
            :to="item.to"
            class="nav-item"
            :class="{ 'router-link-active': isNavActive(item) }"
            :aria-label="item.label"
            :aria-current="isNavActive(item) ? 'page' : undefined"
            @click="closeSidebar"
          >
            <component :is="item.icon" :size="18" />
            <span>{{ item.label }}</span>
          </RouterLink>
        </nav>
      </template>

      <div class="sidebar-card">
        <div class="sidebar-card-head">
          <div class="mini-icon"><BarChart3 :size="18" /></div>
          <span>最近成绩</span>
        </div>
        <strong>{{ sidebarScore }}</strong>
        <span>{{ sidebarHint }}</span>
      </div>
    </aside>

    <div class="workspace">
      <div v-if="!isOnline" class="offline-banner">当前离线，新增内容会先保存在本地。</div>
      <div v-if="showInstallHint" class="offline-banner install-hint">
        <Share :size="15" />
        <span>
          把「Score Record」装到主屏幕：点底部的<b>分享</b>按钮，选「添加到主屏幕」，
          之后就能像 App 一样全屏打开，断网也能用。
        </span>
        <button type="button" aria-label="不再提示安装" @click="dismissInstallHint">
          <X :size="14" />
        </button>
      </div>
      <header class="topbar">
        <div class="topbar-title">
          <button class="menu-button" type="button" aria-label="打开导航" @click="toggleSidebar">
            <Menu :size="20" />
          </button>
          <div>
            <p class="eyebrow">学习档案</p>
            <!-- 这一行只是「你现在在哪儿」的位置提示，真正的页面标题由各页的
                 DsPageHeader 出 h1。两处都用 h1 的话，读屏用户每进一个页面
                 都会先听到两遍标题。 -->
            <p class="topbar-heading">{{ pageTitle }}</p>
          </div>
        </div>
        <div class="topbar-tools">
          <form
            ref="searchBoxRef"
            class="search-box global-search"
            @submit.prevent="openGlobalResult()"
            @keydown="onSearchKeydown"
            @focusout="onSearchFocusOut"
          >
            <Search :size="17" />
            <input
              v-model="globalSearch"
              type="search"
              aria-label="搜索成绩和错题"
              placeholder="搜索成绩、错题或知识点"
              @focus="isGlobalSearchOpen = true"
              @input="isGlobalSearchOpen = true"
            />
            <div v-if="isGlobalSearchOpen && globalSearch" class="global-search-popover">
              <!-- @mousedown.prevent 保住输入框的焦点（鼠标路径），
                   @click 让键盘 Enter 也能打开（焦点在按钮上时浏览器发的是 click） -->
              <button
                v-for="item in globalSearchResults"
                :key="item.id"
                type="button"
                class="global-search-result"
                @mousedown.prevent
                @click="openGlobalResult(item)"
              >
                <strong>{{ item.title }}</strong>
                <span>{{ item.type }} · {{ item.meta }}</span>
              </button>
              <div v-if="!globalSearchResults.length" class="global-search-empty">没有匹配结果</div>
            </div>
          </form>
          <div class="theme-switcher" role="group" aria-label="外观模式">
            <button
              v-for="item in themeOptions"
              :key="item.value"
              type="button"
              :class="{ active: themeMode === item.value }"
              :title="item.label"
              :aria-label="item.label"
              :aria-pressed="themeMode === item.value"
              @click="setThemeMode(item.value)"
            >
              <component :is="item.icon" :size="15" />
            </button>
          </div>
          <button class="ghost-button icon-only" type="button" title="签名" aria-label="签名" @click="openSignatureDialog">
            <PenLine :size="18" />
          </button>
          <AnnouncementCenter />
          <RouterLink class="account-pill" to="/login" :title="store.user ? '账号与同步' : '登录同步'">
            <span class="avatar-dot" :class="{ online: store.user }">{{ userInitial }}</span>
            <span>{{ syncLabel }}</span>
            <Cloud :size="17" />
          </RouterLink>
          <button
            v-if="store.user"
            class="sync-pill"
            :class="{ online: store.user && !store.syncError, danger: store.syncError }"
            type="button"
            :title="syncStateTitle"
            :disabled="store.isSyncing"
            @click="syncNow"
          >
            <RefreshCw :size="15" :class="{ spinning: store.isSyncing }" />
            <span>{{ syncStateText }}</span>
          </button>
          <RouterLink class="ghost-button icon-only" to="/subjects" title="科目管理">
            <Settings :size="18" />
          </RouterLink>
        </div>
      </header>

      <main ref="mainRef" tabindex="-1">
        <DsEmptyState
          v-if="loadFailed"
          :icon="AlertTriangle"
          title="暂时无法读取本机档案"
          description="请确认浏览器允许此站点使用存储，然后重试。"
          role="alert"
        >
          <template #action>
            <button class="secondary-button" type="button" @click="loadArchive">重试读取</button>
          </template>
        </DsEmptyState>
        <div v-else-if="!store.isReady" class="loading-panel">
          <Upload :size="22" />
          <span>正在加载本地学习档案...</span>
        </div>
        <RouterView v-else v-slot="{ Component, route: currentRoute }">
          <RouteErrorBoundary :path="currentRoute.path">
            <component :is="Component" />
          </RouteErrorBoundary>
        </RouterView>
      </main>
    </div>

    <nav class="bottom-nav" aria-label="移动端导航">
      <RouterLink
        v-for="item in primaryNavItems"
        :key="item.to"
        :to="item.to"
        class="bottom-nav-item"
        :class="{ 'router-link-active': isNavActive(item) }"
        :aria-current="isNavActive(item) ? 'page' : undefined"
      >
        <component :is="item.icon" :size="18" />
        <span>{{ item.label }}</span>
      </RouterLink>
    </nav>

    <div class="toast-stack" aria-live="polite">
      <button
        v-for="item in store.notifications"
        :key="item.id"
        class="toast"
        :class="item.type"
        :style="{ '--toast-duration': `${item.timeout || 3200}ms` }"
        type="button"
        @click="store.removeNotification(item.id)"
      >
        {{ item.message }}
      </button>
    </div>

    <div v-if="isSignatureSplashVisible" class="signature-splash" @click="isSignatureSplashVisible = false">
      <div class="signature-card">
        <span class="signature-orbit"></span>
        <p>学习签名</p>
        <strong>{{ signatureText }}</strong>
        <i></i>
      </div>
    </div>

    <div v-if="isSignatureDialogOpen" class="signature-dialog-backdrop" @mousedown.self="closeSignatureDialog">
      <section ref="signatureDialogRef" class="signature-dialog" role="dialog" aria-modal="true" aria-labelledby="signature-title">
        <div class="section-head">
          <h2 id="signature-title">设置签名</h2>
          <button class="icon-button" type="button" aria-label="关闭" @click="closeSignatureDialog">
            <X :size="16" />
          </button>
        </div>
        <label>
          每次打开网页时展示
          <input v-model.trim="signatureDraft" maxlength="32" placeholder="稳住节奏，今天继续推进" @keydown.enter.prevent="saveSignature" />
        </label>
        <div class="signature-preview">
          <span>预览</span>
          <strong>{{ signatureDraft || "稳住节奏，今天继续推进" }}</strong>
        </div>
        <div class="composite-dialog-footer">
          <button class="secondary-button" type="button" @click="closeSignatureDialog(); showSignatureSplash()">重播</button>
          <button class="primary-button" type="button" @click="saveSignature">保存签名</button>
        </div>
      </section>
    </div>

    <!-- 全局二次确认弹窗，配合 useConfirm() 使用 -->
    <DsConfirmHost />
  </div>
</template>
