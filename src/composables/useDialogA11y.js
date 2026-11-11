/**
 * 弹窗的键盘可达性 + 返回键关闭。
 *
 * 为什么需要单独抽出来：
 * 光写 `role="dialog" aria-modal="true"` 是**没有实际作用**的 —— 浏览器不会因此
 * 限制焦点。实测过导出面板：Tab 能从弹窗一路跳到被遮住的页面按钮上（12 次里有 6 次
 * 跑出去），回车就点到了看不见的东西；Escape 也关不掉。鼠标用户完全无感，
 * 所以这个 bug 能一直藏着。
 *
 * 另一件事是「返回键」。手机上从边缘滑一下（或安卓的系统返回键）是最顺手的「退出」
 * 手势，但在网页里它默认等于**换页**：弹窗开着时滑一下，会连人带弹窗一起离开当前页
 * —— 弹窗还盖在新页面上，看起来像是卡住了。所以弹窗打开时往历史里压一条「同一个
 * 地址」的记录，把返回手势拦下来改成「关弹窗」。
 *
 * 用法：
 *   const dialogRef = ref(null);
 *   useDialogA11y(isOpen, dialogRef, { onClose: close });
 *
 *   <section ref="dialogRef" role="dialog" aria-modal="true">
 *
 * 注意 isOpen 和 containerRef 要指向「同一个弹窗」：弹窗用 v-if 渲染时，
 * containerRef 只在打开期间有值，所以这里用 flush: "post" 等 DOM 出来再聚焦。
 */
import { onBeforeUnmount, watch } from "vue";

/** 可聚焦元素。排除 disabled 和 tabindex="-1"（后者只能被脚本聚焦） */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

/**
 * 已经打开的弹窗，后进先出。
 * Escape 只关最上面那个 —— 否则确认框盖在表单上时，一下 Escape 会把两个都关掉。
 * 返回手势同理：一次返回只关一层。
 */
const openStack = [];

/**
 * 我们自己发起的 history.back() 次数。
 *
 * 弹窗正常关闭（点 X / Escape / 点遮罩）时要把打开时压进历史的那一条弹出去，
 * 而这个 back() 同样会触发 popstate。不区分的话，popstate 处理器会以为「用户按了
 * 返回」，顺手把下面那层弹窗也关掉 —— 所以用计数把「清理」和「用户操作」分开。
 */
let pendingBacks = 0;

/** 给每条历史记录一个自增 id，关闭时用它确认「栈顶那条到底是不是我的」 */
let dialogSeq = 0;

function onPopState() {
  if (pendingBacks > 0) {
    pendingBacks -= 1;
    return;
  }
  // 用户按了返回 / 手机侧滑：只关最上面那层弹窗，不换页
  openStack[openStack.length - 1]?.closeFromHistory?.();
}

if (typeof window !== "undefined") {
  // 模块级只注册一次。vue-router 也监听 popstate，它先注册所以先跑 ——
  // 但它拿到的地址和当前路由完全一样，不会真的换页（见 router/index.js 的
  // scrollBehavior 里那条「同一个 fullPath 就别动滚动」的兜底）。
  window.addEventListener("popstate", onPopState);
}

function isVisible(element) {
  // 不用 offsetParent：position: fixed 的子树里 offsetParent 会是 null，
  // 明明看得见却被判成不可见，焦点圈就漏了。
  return element.getClientRects().length > 0 && window.getComputedStyle(element).visibility !== "hidden";
}

export function useDialogA11y(isOpen, containerRef, { onClose, lockScroll = true, historyEntry = true } = {}) {
  // 每个弹窗一个身份对象，用来在 openStack 里认出自己
  const identity = {};
  let previousActive = null;
  let previousOverflow = "";
  /** 打开时压进历史的那条记录的 id；没压过就是 null */
  let entryId = null;
  /** 这次关闭是不是「返回手势」触发的 —— 是的话那条历史已经被浏览器弹掉了，不要再 back() */
  let closedByPop = false;

  // 挂到身份对象上，让模块级的 popstate 处理器能叫到这一层
  identity.closeFromHistory = () => {
    closedByPop = true;
    onClose?.();
  };

  function focusableItems() {
    const root = containerRef.value;
    if (!root) return [];
    return [...root.querySelectorAll(FOCUSABLE)].filter(isVisible);
  }

  function focusFirst() {
    const items = focusableItems();
    // 优先聚焦显式标了 data-autofocus 的元素（比如输入框），否则第一个
    const target = items.find((element) => element.hasAttribute("data-autofocus")) || items[0];
    target?.focus?.();
  }

  /**
   * 把打开时压的那条历史弹出去。
   *
   * 两种「不该弹」的情况：
   *   1. closedByPop —— 用户按返回关的，那条已经被浏览器弹掉了，再弹会退到上一页
   *   2. 栈顶已经不是我们这条 —— 期间发生了路由跳转（比如弹窗里点了「去错题本」），
   *      这时 back() 会把用户从新页面拽回去
   */
  function releaseHistoryEntry() {
    if (!entryId) return;
    const mine = typeof history !== "undefined" && history.state?.__dialogId === entryId;
    entryId = null;
    if (closedByPop || !mine) return;
    pendingBacks += 1;
    history.back();
  }

  function onKeydown(event) {
    // 只有最上层的弹窗响应键盘
    if (openStack[openStack.length - 1] !== identity) return;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
      return;
    }

    if (event.key !== "Tab") return;

    const items = focusableItems();
    if (!items.length) {
      // 弹窗里没有可聚焦元素：别让 Tab 把焦点带到背后页面上
      event.preventDefault();
      return;
    }

    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = containerRef.value?.contains(active);

    // 焦点还在弹窗外（刚打开、或用户用鼠标点了遮罩），把 Tab 拉回来
    if (!inside) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  watch(
    isOpen,
    (open) => {
      if (typeof document === "undefined") return;

      if (open) {
        previousActive = document.activeElement;
        previousOverflow = document.body.style.overflow;
        if (lockScroll) document.body.style.overflow = "hidden";
        openStack.push(identity);
        // 捕获阶段：抢在页面上的其它 keydown 之前处理
        window.addEventListener("keydown", onKeydown, true);

        // 压一条「同一个地址」的历史记录，把手机返回手势 / 系统返回键变成「关弹窗」。
        // 必须把 vue-router 的 state 一起带上（...history.state）：它靠 state.position
        // 算前进还是后退，丢掉的话它会把这次返回当成「换了页」。
        //
        // historyEntry 可以是布尔或函数。用函数是为了让调用方按「打开的那一刻」决定：
        // 路由守卫里弹出的确认框不能压记录 —— 守卫正卡在一次导航中间，确认框一压一弹
        // 会把 vue-router 用来「导航失败就退回原地址」的那次 history.go(-delta) 搅乱，
        // 结果是点了「放弃」反而没换页（实测到过）。
        const useHistoryEntry = typeof historyEntry === "function" ? historyEntry() : historyEntry;
        entryId = null;
        closedByPop = false;
        if (useHistoryEntry) {
          entryId = `dlg-${++dialogSeq}`;
          try {
            history.pushState({ ...history.state, __dialogId: entryId }, "", location.href);
          } catch {
            // 文档不是「完全激活」状态时 pushState 会抛异常。
            // 压不进去就当作没压过 —— entryId 留着会让关闭时去 back() 一个不存在的记录。
            entryId = null;
          }
        }

        // 等这一帧渲染完，弹窗里的元素才存在
        requestAnimationFrame(focusFirst);
        return;
      }

      window.removeEventListener("keydown", onKeydown, true);
      const index = openStack.indexOf(identity);
      if (index !== -1) openStack.splice(index, 1);
      if (lockScroll) document.body.style.overflow = previousOverflow;

      releaseHistoryEntry();
      closedByPop = false;

      // 焦点还给打开弹窗的那个按钮，键盘用户才不会丢失位置。
      //
      // preventScroll 不能省：focus() 默认会把元素滚进视野。手机上（<768px）顶栏
      // 不是 sticky，焦点如果停在顶栏按钮上，用户又往下滚过 —— 关弹窗时页面会
      // 一路弹回顶部。实测过：滚到 500，关弹窗后变成 0，而这一路 window.scrollTo
      // 一次都没被调用（是浏览器自己滚的），所以只能从 focus 这一头堵。
      // 弹窗开着的时候背景是锁滚动的，那个按钮必然还在原处，不需要滚过去。
      if (previousActive instanceof HTMLElement && document.contains(previousActive)) {
        previousActive.focus?.({ preventScroll: true });
      }
      previousActive = null;
    },
    { flush: "post" }
  );

  onBeforeUnmount(() => {
    if (typeof document === "undefined") return;
    window.removeEventListener("keydown", onKeydown, true);
    const index = openStack.indexOf(identity);
    if (index !== -1) openStack.splice(index, 1);
    if (lockScroll) document.body.style.overflow = previousOverflow;
    // 组件被销毁时 isOpen 的 watcher 不会再跑，这里补一次清理。
    // 若是「换页导致销毁」，history.state 已经是新路由那条，mine 为 false，不会误退。
    releaseHistoryEntry();
  });

  return { focusFirst };
}
