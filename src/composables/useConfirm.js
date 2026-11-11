/**
 * 全局二次确认。
 *
 * 用来替换散落各处的 window.confirm：原生弹窗样式不可控、会阻塞渲染，
 * 而且在 iPad 上会弹出系统级对话框，和整站观感割裂。
 *
 * 用法：
 *   const { confirm } = useConfirm();
 *   if (!(await confirm({ title: "删除这条成绩？", message: "24 小时内可恢复。" }))) return;
 *
 * 弹窗本体由 App.vue 里的 DsConfirmHost 统一渲染，所以页面里不用挂任何组件。
 */
import { ref } from "vue";

const pending = ref(null);

export function useConfirm() {
  /**
   * @param {string|{title?:string,message?:string,confirmText?:string,cancelText?:string,tone?:'danger'|'primary',noHistory?:boolean}} options
   *   noHistory: 不要往历史里压记录（返回手势关不掉这个确认框）。
   *   只有「路由守卫里弹的确认框」需要 —— 守卫卡在导航中间时不能动历史栈。
   * @returns {Promise<boolean>}
   */
  function confirm(options = {}) {
    const normalized = typeof options === "string" ? { message: options } : options;
    return new Promise((resolve) => {
      // 上一个还没关掉就先当作取消，避免 promise 悬挂
      pending.value?.resolve(false);
      pending.value = {
        title: normalized.title || "确认操作",
        message: normalized.message || "",
        confirmText: normalized.confirmText || "确认",
        cancelText: normalized.cancelText || "取消",
        tone: normalized.tone || "danger",
        noHistory: Boolean(normalized.noHistory),
        resolve
      };
    });
  }

  return { confirm, pending };
}

export function settleConfirm(result) {
  const current = pending.value;
  pending.value = null;
  current?.resolve(result);
}
