import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  // 在开发服务器启动时预构建，避免第一次滚到图表时 Vite 重新加载页面。
  optimizeDeps: {
    include: ["echarts/core", "echarts/charts", "echarts/components", "echarts/renderers"]
  },
  server: {
    host: "0.0.0.0",
    port: 5173
  },
  build: {
    rollupOptions: {
      output: {
        /**
         * 路由改成懒加载之后 Vite 会把每个页面拆成独立 chunk（这正是想要的），
         * 但 lucide 图标是**跨页面共享**的小模块，默认会被切成一堆 0.1K 的碎片：
         * 实测 31 个 chunk、首屏请求数从 4 涨到 16，省下的字节又被请求数吃回去。
         * 所以只把图标并成一块。
         *
         * 只并图标、其余交给 Vite 默认策略 —— 这是量出来的结论：
         * 一开始我还把 vue / supabase / dexie 各自拆成 vendor-* 块，结果它们
         * **全都是首屏就要的**，字节一个没省，请求数却从 4 涨到 14。
         * 拆 vendor 只对「业务代码改动不带动 vendor 文件名」有意义，
         * 而这个应用的 vendor 本来就要全量加载，拆它纯亏。
         *
         * echarts / exceljs 必须显式留在自己的块里：它们只被动态 import 引用，
         * 一旦被并进任何首屏会加载的块，就会跟着一起下载（实测多 361K）。
         */
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@lucide")) return "vendor-icons";
          if (id.includes("echarts") || id.includes("zrender")) return "vendor-echarts";
          if (id.includes("exceljs")) return "vendor-exceljs";
          return undefined;
        }
      }
    }
  }
});
