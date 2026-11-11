<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { Cloud, Database, Image, KeyRound, LogOut, Mail, Monitor, RefreshCw, UserPlus } from "@lucide/vue";
import { useTrackerStore } from "../stores/tracker";
import { isSupabaseConfigured } from "../services/supabase";
import DsPageHeader from "../components/ds/DsPageHeader.vue";
import DsSection from "../components/ds/DsSection.vue";
import DsStatCard from "../components/ds/DsStatCard.vue";

const store = useTrackerStore();
const mode = ref("login");
const isBusy = ref(false);
const message = ref("");
const form = reactive({ email: "", password: "" });

onMounted(() => {
  const url = new URL(window.location.href);
  if (url.searchParams.get("confirmed") === "1") {
    message.value = "邮箱已确认，现在可以登录并同步。";
    window.history.replaceState({}, "", "#/login");
  }
});

const statusText = computed(() => {
  if (!isSupabaseConfigured) return "未配置 Supabase 环境变量";
  if (store.syncError) return `同步失败：${store.syncError}`;
  if (store.user) return `已登录：${store.user.email}`;
  return "可登录或注册后开启多设备同步";
});
const lastSyncText = computed(() => (store.lastSyncedAt ? new Date(store.lastSyncedAt).toLocaleString("zh-CN") : "暂无同步记录"));
const imageSyncText = computed(() => {
  if (!store.pendingImages.length && !store.failedImages.length) return "图片队列正常";
  return `图片：${store.pendingImages.length} 张同步中 / ${store.failedImages.length} 张失败`;
});

async function submit() {
  isBusy.value = true;
  message.value = "";
  try {
    if (mode.value === "login") {
      await store.login(form.email, form.password);
      message.value = "登录成功，实时同步已开启。";
    } else {
      await store.register(form.email, form.password);
      message.value = "注册完成，如开启邮箱确认请先查收邮件。";
    }
  } catch (error) {
    message.value = error.message || "账号操作失败";
  } finally {
    isBusy.value = false;
  }
}

async function logout() {
  await store.logout();
  message.value = "已退出登录，当前回到本地模式。";
}

async function syncNow() {
  isBusy.value = true;
  message.value = "";
  try {
    await store.syncNow();
    message.value = "同步完成。";
  } catch (error) {
    message.value = error.message || "同步失败";
  } finally {
    isBusy.value = false;
  }
}

async function calibrateCloud() {
  isBusy.value = true;
  message.value = "";
  try {
    await store.calibrateCloud();
    message.value = "云端校准完成。";
  } catch (error) {
    message.value = error.message || "云端校准失败";
  } finally {
    isBusy.value = false;
  }
}
</script>

<template>
  <div class="page-stack">
    <DsPageHeader title="同步中心" description="账号、成绩和错题的云端入口" />

    <section class="ds-stats">
      <DsStatCard label="当前状态" :value="store.user ? '已登录' : '未登录'" :hint="statusText" :icon="Cloud" />
      <DsStatCard label="最近同步" :value="store.lastSyncedAt ? '已同步' : '未同步'" :hint="lastSyncText" :icon="RefreshCw" />
      <DsStatCard
        label="图片队列"
        :value="store.pendingImages.length + store.failedImages.length"
        unit="张"
        :hint="imageSyncText"
        :icon="Image"
      />
      <DsStatCard label="设备" :value="store.deviceName" :hint="store.autoSyncState" :icon="Monitor" />
    </section>

    <section class="content-grid">
      <DsSection
        :title="store.user ? '云端操作' : '登录或注册'"
        :description="store.user ? '同步、校准与退出' : '登录后开启多设备同步'"
      >
        <form v-if="!store.user" class="form-grid" @submit.prevent="submit">
          <label>
            邮箱
            <div class="input-with-icon">
              <Mail :size="17" />
              <input v-model.trim="form.email" type="email" required placeholder="you@example.com" />
            </div>
          </label>
          <label>
            密码
            <div class="input-with-icon">
              <KeyRound :size="17" />
              <input v-model="form.password" type="password" minlength="6" required placeholder="至少 6 位" />
            </div>
          </label>
          <div class="segmented">
            <button type="button" :class="{ active: mode === 'login' }" @click="mode = 'login'">登录</button>
            <button type="button" :class="{ active: mode === 'register' }" @click="mode = 'register'">注册</button>
          </div>
          <button class="primary-button" type="submit" :disabled="isBusy || !isSupabaseConfigured">
            <component :is="mode === 'login' ? Cloud : UserPlus" :size="17" />
            {{ mode === "login" ? "登录并同步" : "创建账号" }}
          </button>
        </form>

        <div v-else class="action-stack">
          <button class="primary-button" type="button" :disabled="isBusy || store.isSyncing" @click="syncNow">
            <RefreshCw :size="17" :class="{ spinning: store.isSyncing }" />
            立即同步
          </button>
          <button class="secondary-button" type="button" :disabled="isBusy || store.isSyncing" @click="calibrateCloud">
            <Database :size="17" />
            云端校准
          </button>
          <button class="secondary-button" type="button" @click="logout">
            <LogOut :size="17" />
            退出登录
          </button>
        </div>

        <p v-if="message" class="dialog-hint">{{ message }}</p>
      </DsSection>

      <DsSection title="同步说明" description="本地模式也能继续使用">
        <div class="login-note compact-note">
          <Database :size="17" />
          <span>未配置 Supabase 时，应用会继续使用本地 IndexedDB。云端登录后，成绩、错题和图片会同步到同一账号。</span>
        </div>
      </DsSection>
    </section>
  </div>
</template>
