/**
 * 浮层「点外面 / 按 Escape 就收起」。
 *
 * 全站的浮层之前都只能靠再点一次触发按钮来关：顶部搜索建议、成绩列表的
 * 排序菜单、健康检查的「已忽略」面板，点了别处都会一直挂在那儿挡住内容。
 * 鼠标用户顶多觉得有点烦，键盘用户则会卡在一个关不掉的层上。
 *
 * 用法：
 *   const menuRef = ref(null);
 *   useDismissable(isOpen, menuRef, { onClose: () => (isOpen.value = false) });
 *
 *   <div ref="menuRef">          <!-- 必须同时包住触发按钮和浮层 -->
 *     <button @click="isOpen = !isOpen">排序</button>
 *     <div v-if="isOpen">…</div>
 *   </div>
 *
 * containerRef **必须同时包住触发按钮**。只包浮层的话，点触发按钮会被判成
 * 「点在了外面」而先收起，紧接着 click 事件又把它打开 —— 结果就是怎么点都关不掉。
 */
import { onBeforeUnmount, watch } from "vue";

export function useDismissable(isOpen, containerRef, { onClose, closeOnEscape = true } = {}) {
  let listening = false;

  function onPointerDown(event) {
    const root = containerRef.value;
    // 浮层还没渲染出来时不处理，免得把「刚点开」当成「点了外面」
    if (!root) return;
    if (root.contains(event.target)) return;
    onClose?.();
  }

  function onKeydown(event) {
    if (event.key !== "Escape") return;
    onClose?.();
  }

  function start() {
    if (listening || typeof document === "undefined") return;
    listening = true;
    // 捕获阶段：浮层里的元素 stopPropagation 也吃不掉这个关闭逻辑
    document.addEventListener("pointerdown", onPointerDown, true);
    if (closeOnEscape) document.addEventListener("keydown", onKeydown);
  }

  function stop() {
    if (!listening) return;
    listening = false;
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeydown);
  }

  watch(isOpen, (open) => (open ? start() : stop()), { immediate: true });
  onBeforeUnmount(stop);
}
