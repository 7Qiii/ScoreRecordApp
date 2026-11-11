<script setup>
import { computed, ref } from "vue";
import { Bell, Megaphone, Sparkles, Timeline, X } from "@lucide/vue";
import { announcements } from "../data/announcements.js";

const isOpen = ref(false);
const activeTab = ref("timeline");

/**
 * 通知页签是手写的运营提示，**不**从更新日志生成。
 *
 * 它回答的是「你现在需要做什么」，和「最近改了什么」不是一回事，
 * 所以不该混进时间线。代价是它仍然要手工维护 —— 只放当下确实成立的事，
 * 过期的（比如早就补完的字段迁移）要及时删掉，否则会误导人去改一个
 * 已经不需要改的东西。
 */
const notices = [
  {
    id: "missing-columns",
    title: "新设备看不到卷型或用时？",
    summary: "多半是云端表还缺对应的列。应用会自动降级、不会报错，补上列就能恢复完整同步。",
    time: "提示"
  },
  {
    id: "refresh-deploy",
    title: "部署后请刷新缓存",
    summary: "Vercel 部署完成后，iPad 上可下拉刷新或重新打开网页，确保载入最新 JS/CSS。",
    time: "提示"
  }
];

const SEEN_KEY = "exam-tracker-announcements-seen";

function readSeen() {
  try {
    return localStorage.getItem(SEEN_KEY) || "";
  } catch {
    return "";
  }
}

const seenId = ref(readSeen());

/**
 * 角标 = 「比你上次打开时多了几条」。
 *
 * 以前这里是 `announcements.length`，等于公告总条数 —— 永远显示 4，
 * 看过也不会消，角标就失去了全部意义。
 * 只存「看过的最新一条 id」而不是一串已读列表：公告是有序的，
 * 记住最新的那条就等价于记住全部，也不用无限增长。
 */
const unreadCount = computed(() => {
  const index = announcements.findIndex((item) => item.id === seenId.value);
  return index < 0 ? announcements.length : index;
});

const unreadLabel = computed(() => (unreadCount.value > 9 ? "9+" : String(unreadCount.value)));

function markSeen() {
  const newest = announcements[0]?.id ?? "";
  if (!newest || seenId.value === newest) return;
  seenId.value = newest;
  try {
    localStorage.setItem(SEEN_KEY, newest);
  } catch {
    /* 存不进去就退化成「每次打开都显示角标」，不影响主流程 */
  }
}

function toggleOpen() {
  isOpen.value = !isOpen.value;
  if (isOpen.value) markSeen();
}

const currentItems = computed(() => (activeTab.value === "timeline" ? announcements : notices));
</script>

<template>
  <div class="announcement-center">
    <button class="ghost-button icon-only announcement-trigger" type="button" title="系统公告" aria-label="系统公告" @click="toggleOpen">
      <Bell :size="18" />
      <span v-if="unreadCount" class="notification-dot">{{ unreadLabel }}</span>
    </button>

    <div v-if="isOpen" class="announcement-popover">
      <div class="announcement-head">
        <div>
          <p>系统公告</p>
          <span>最新平台更新和通知</span>
        </div>
        <button class="icon-button compact" type="button" aria-label="关闭公告" @click="isOpen = false">
          <X :size="15" />
        </button>
      </div>

      <div class="announcement-tabs" role="tablist" aria-label="公告分类">
        <button type="button" :class="{ active: activeTab === 'notices' }" @click="activeTab = 'notices'">
          <Megaphone :size="15" />
          通知
        </button>
        <button type="button" :class="{ active: activeTab === 'timeline' }" @click="activeTab = 'timeline'">
          <Timeline :size="15" />
          时间线
        </button>
      </div>

      <div class="announcement-list">
        <article v-for="item in currentItems" :key="item.id" class="announcement-item" :class="item.type">
          <i></i>
          <div>
            <strong>{{ item.title }}</strong>
            <p v-if="item.summary">{{ item.summary }}</p>
            <span>{{ item.time }}</span>
          </div>
        </article>
      </div>

      <div class="announcement-foot">
        <Sparkles :size="14" />
        <span>每次功能更新都会自动同步到这里。</span>
      </div>
    </div>
  </div>
</template>
