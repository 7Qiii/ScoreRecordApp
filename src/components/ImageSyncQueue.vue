<script setup>
/**
 * 图片同步状态。
 *
 * 原来无论有没有图片都会渲染三张大卡，全是 0 的时候纯属占地方。
 * 现在：没有图片就整块不渲染；图片都同步好了就收成一行；
 * 只有真的有队列（上传中 / 失败）时才展开三张卡和列表。
 */
import { computed } from "vue";
import { AlertTriangle, CheckCircle2, Cloud, Image, RefreshCw } from "@lucide/vue";
import { useTrackerStore } from "../stores/tracker";

const store = useTrackerStore();

const cloudCount = computed(() => store.images.filter((image) => image.url || image.storageKey).length);
const pendingCount = computed(() => store.pendingImages.length);
const failedCount = computed(() => store.failedImages.length);
const hasQueue = computed(() => Boolean(pendingCount.value || failedCount.value));
const hasAnyImage = computed(() => store.images.length > 0 || hasQueue.value);

function retry() {
  store.retryPendingImageUploads();
}
</script>

<template>
  <section v-if="hasAnyImage && hasQueue" class="panel sync-panel">
    <div class="section-head">
      <div>
        <h2>图片同步</h2>
        <span class="section-meta">R2 云端图片状态</span>
      </div>
      <button class="secondary-button compact" type="button" @click="retry">
        <RefreshCw :size="15" />
        重试
      </button>
    </div>

    <div class="sync-stats">
      <article>
        <CheckCircle2 :size="17" />
        <strong>{{ cloudCount }}</strong>
        <span>已云端</span>
      </article>
      <article>
        <Cloud :size="17" />
        <strong>{{ pendingCount }}</strong>
        <span>同步中</span>
      </article>
      <article :class="{ danger: failedCount }">
        <AlertTriangle :size="17" />
        <strong>{{ failedCount }}</strong>
        <span>失败</span>
      </article>
    </div>

    <div class="queue-list">
      <div v-for="image in [...store.failedImages, ...store.pendingImages].slice(0, 4)" :key="image.id" class="queue-row">
        <Image :size="15" />
        <span>{{ image.name }}</span>
        <small>{{ image.uploadError || "正在上传到 R2" }}</small>
      </div>
    </div>
  </section>

  <p v-else-if="hasAnyImage" class="image-sync-inline">
    <CheckCircle2 :size="15" />
    {{ cloudCount }} 张图片已同步到云端。
  </p>
</template>
