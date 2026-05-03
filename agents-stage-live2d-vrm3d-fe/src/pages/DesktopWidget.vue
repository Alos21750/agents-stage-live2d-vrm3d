<template>
  <main class="desktop-widget-shell">
    <div class="desktop-widget-controls">
      <button type="button" title="重新載入" @click="reloadWindow">↻</button>
      <button type="button" title="關閉" @click="closeWindow">×</button>
    </div>

    <section class="desktop-widget-stage" :class="statusClass">
      <div class="desktop-widget-brand-toggle no-drag" aria-label="Chat brand">
        <button
          type="button"
          class="no-drag"
          :class="{ 'is-active': selectedBrand === 'codex' }"
          @click="selectBrand('codex')"
        >
          Codex
        </button>
        <button
          type="button"
          class="no-drag"
          :class="{ 'is-active': selectedBrand === 'claude' }"
          @click="selectBrand('claude')"
        >
          Claude
        </button>
      </div>

      <div v-if="chat.error.value" class="chat-error-banner no-drag">
        <span>{{ chat.error.value }}</span>
        <button type="button" class="no-drag" title="Close" @click="dismissChatError">×</button>
      </div>

      <DesktopWidgetLive2D :state="monitor.activeState.value" />
      <div class="status-bubble">
        <span class="status-dot"></span>
        <span>{{ monitor.activeStateText.value }}</span>
      </div>

      <div
        v-if="chat.assistantText.value || chat.isStreaming.value"
        class="assistant-bubble no-drag"
      >
        <div v-if="chat.toolCallHint.value" class="tool-call-hint">{{ chat.toolCallHint.value }}</div>
        <div v-if="chat.assistantText.value" class="assistant-text">{{ chat.assistantText.value }}</div>
        <div v-else-if="chat.isStreaming.value" class="assistant-text">...</div>

        <div v-if="chat.pendingApproval.value" class="approval-panel">
          <div v-if="chat.pendingApproval.value.description" class="approval-description">
            {{ chat.pendingApproval.value.description }}
          </div>
          <div class="approval-actions">
            <button type="button" class="no-drag" @click="approveOnce">✓ 允許一次</button>
            <button type="button" class="no-drag" @click="denyOnce">✗ 拒絕一次</button>
          </div>
        </div>

        <form v-if="chat.awaitingUserInput.value" class="user-input-reply" @submit.prevent="submitUserInputResponse">
          <input
            v-model="userInputReply"
            class="no-drag"
            type="text"
            placeholder="agent 在等你回應"
          />
          <button type="submit" class="no-drag" :disabled="!userInputReply.trim()">送出</button>
        </form>
      </div>

      <form class="desktop-widget-chat no-drag" @submit.prevent="sendChatMessage">
        <input
          v-model="chatInput"
          class="no-drag"
          type="text"
          :placeholder="chatPlaceholder"
          :disabled="!canSendMessage"
        />
        <button type="submit" class="no-drag" :disabled="!canSendMessage || !chatInput.trim()">▶</button>
      </form>
    </section>

    <footer class="desktop-widget-status">
      <div class="session-row">
        <span class="brand">{{ monitor.brandName.value }}</span>
        <span class="session-name">{{ sessionName }}</span>
      </div>
      <div class="meta-row">
        <span>{{ monitor.cwdLabel.value }}</span>
        <span v-if="monitor.rateLimitText.value">{{ monitor.rateLimitText.value }}</span>
        <span v-if="monitor.lastEventText.value">{{ monitor.lastEventText.value }}</span>
      </div>
    </footer>

    <div class="resize-corner" aria-hidden="true">
      <span></span>
      <span></span>
      <span></span>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import DesktopWidgetLive2D from '../components/desktop-widget/DesktopWidgetLive2D.vue'
import { getSessionActivityEpoch } from '../utils/sessionStageState'
import { isDesktopWidgetWarmupSession, useDesktopWidgetMonitor } from './desktop-widget/desktopWidgetMonitor'
import { useDesktopWidgetChat } from './desktop-widget/desktopWidgetChat'
import type { ChatBrand } from './desktop-widget/desktopWidgetChat'

const monitor = useDesktopWidgetMonitor()
const chat = useDesktopWidgetChat()
const chatInput = ref('')
const userInputReply = ref('')
const selectedBrand = ref<ChatBrand>(normalizeChatBrand(monitor.activeSession.value?.agent_brand))
const selectedBrandTouched = ref(false)

const sessionName = computed(() => monitor.activeSession.value?.display_name || 'Bridge monitor')
const statusClass = computed(() => ({
  'is-disconnected': monitor.connectionStatus.value === 'disconnected',
  'is-connected': monitor.connectionStatus.value === 'connected',
}))
const filteredActiveSession = computed(() => {
  const wanted = selectedBrand.value
  return monitor.sessions.value
    .filter((s) => s.active === true)
    .filter((s) => !isDesktopWidgetWarmupSession(s))
    .filter((s) => normalizeChatBrand(s.agent_brand) === wanted)
    .sort((a, b) => getSessionActivityEpoch(b) - getSessionActivityEpoch(a))[0] || null
})
const canSendMessage = computed(() => (
  !!filteredActiveSession.value
  && !chat.isStreaming.value
  && !chat.pendingApproval.value
  && !chat.awaitingUserInput.value
))
const chatPlaceholder = computed(() => (
  filteredActiveSession.value
    ? `傳送訊息到 ${selectedBrand.value}`
    : `沒有活躍 ${selectedBrand.value} session`
))

watch(
  () => monitor.activeSession.value?.agent_brand,
  (brand) => {
    if (selectedBrandTouched.value) return
    selectedBrand.value = normalizeChatBrand(brand)
  },
  { immediate: true },
)

function normalizeChatBrand(value: unknown): ChatBrand {
  return String(value || 'codex').trim().toLowerCase() === 'claude' ? 'claude' : 'codex'
}

function selectBrand(brand: ChatBrand): void {
  selectedBrandTouched.value = true
  selectedBrand.value = brand
}

function sendChatMessage(): void {
  const text = chatInput.value.trim()
  const session = filteredActiveSession.value
  if (!text || !session || !canSendMessage.value) return
  chatInput.value = ''
  void chat.send(text, session.session_id, selectedBrand.value)
}

function submitUserInputResponse(): void {
  const text = userInputReply.value.trim()
  if (!text || !chat.awaitingUserInput.value) return
  userInputReply.value = ''
  void chat.respondToUserInput(text)
}

function approveOnce(): void {
  void chat.respondToApproval('allow_once')
}

function denyOnce(): void {
  void chat.respondToApproval('deny_once')
}

function dismissChatError(): void {
  chat.error.value = ''
}

function closeWindow(): void {
  window.desktopWidget?.close()
}

function reloadWindow(): void {
  window.desktopWidget?.reload()
}
</script>

<style scoped>
.desktop-widget-shell {
  position: relative;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  color: #f8fbff;
  background: transparent;
  user-select: none;
  -webkit-app-region: drag;
}

.desktop-widget-controls {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 20;
  display: flex;
  gap: 6px;
  opacity: 0;
  transition: opacity 160ms ease;
  -webkit-app-region: no-drag;
}

.desktop-widget-shell:hover .desktop-widget-controls {
  opacity: 1;
}

.desktop-widget-controls button {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 1px solid rgb(255 255 255 / 28%);
  border-radius: 999px;
  color: #f8fbff;
  font-size: 17px;
  line-height: 1;
  background: rgb(12 18 28 / 72%);
  box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
  cursor: pointer;
}

.no-drag,
.no-drag * {
  -webkit-app-region: no-drag;
}

.desktop-widget-stage {
  position: relative;
  min-height: 0;
  padding: 20px 18px 0;
}

.desktop-widget-brand-toggle {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 10;
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid rgb(255 255 255 / 24%);
  border-radius: 999px;
  background: rgb(12 18 28 / 72%);
  box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
  backdrop-filter: blur(10px);
}

.desktop-widget-brand-toggle button {
  min-width: 58px;
  padding: 5px 10px;
  border: 0;
  border-radius: 999px;
  color: #d7e2f0;
  font-size: 12px;
  font-weight: 800;
  line-height: 1;
  background: transparent;
  cursor: pointer;
}

.desktop-widget-brand-toggle button:hover,
.desktop-widget-brand-toggle button.is-active {
  color: #0f1722;
  background: #d8f3ff;
}

.chat-error-banner {
  position: absolute;
  top: 52px;
  right: 18px;
  left: 18px;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid rgb(255 107 114 / 44%);
  border-radius: 8px;
  color: #ffe8ea;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.3;
  background: rgb(78 20 28 / 78%);
  box-shadow: 0 12px 28px rgb(0 0 0 / 18%);
  backdrop-filter: blur(10px);
}

.chat-error-banner span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-error-banner button {
  flex: 0 0 auto;
  border: 0;
  color: #ffe8ea;
  font-size: 16px;
  line-height: 1;
  background: transparent;
  cursor: pointer;
}

.desktop-widget-stage::after {
  position: absolute;
  right: 52px;
  bottom: 18px;
  left: 52px;
  height: 18px;
  content: "";
  background: radial-gradient(ellipse at center, rgb(12 18 28 / 36%), rgb(12 18 28 / 0) 68%);
  pointer-events: none;
}

.desktop-widget-live2d {
  width: 100%;
  height: 100%;
}

.status-bubble {
  position: absolute;
  top: 54px;
  left: 22px;
  display: inline-flex;
  max-width: calc(100% - 44px);
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid rgb(255 255 255 / 24%);
  border-radius: 8px;
  color: #f8fbff;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.2;
  background: rgb(20 28 40 / 74%);
  box-shadow: 0 12px 28px rgb(0 0 0 / 18%);
  backdrop-filter: blur(10px);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #74d680;
  box-shadow: 0 0 14px rgb(116 214 128 / 70%);
}

.is-disconnected .status-dot {
  background: #ff6b72;
  box-shadow: 0 0 14px rgb(255 107 114 / 72%);
}

.assistant-bubble {
  position: absolute;
  top: 96px;
  right: 18px;
  left: 18px;
  z-index: 10;
  max-height: 28%;
  overflow-y: auto;
  padding: 10px 12px;
  border: 1px solid rgb(255 255 255 / 24%);
  border-radius: 8px;
  color: #f8fbff;
  font-size: 13px;
  line-height: 1.45;
  background: rgb(20 28 40 / 74%);
  box-shadow: 0 12px 28px rgb(0 0 0 / 18%);
  backdrop-filter: blur(10px);
  user-select: text;
}

.tool-call-hint {
  margin-bottom: 6px;
  color: #d7e2f0;
  font-size: 12px;
  font-style: italic;
}

.assistant-text {
  white-space: pre-wrap;
}

.approval-panel {
  display: grid;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgb(255 255 255 / 18%);
}

.approval-description {
  color: #d7e2f0;
  font-size: 12px;
}

.approval-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.approval-actions button,
.user-input-reply button,
.desktop-widget-chat button {
  border: 1px solid rgb(255 255 255 / 24%);
  border-radius: 8px;
  color: #f8fbff;
  font-size: 12px;
  font-weight: 800;
  background: rgb(12 18 28 / 72%);
  cursor: pointer;
}

.approval-actions button {
  padding: 6px 9px;
}

.approval-actions button:hover,
.user-input-reply button:hover,
.desktop-widget-chat button:hover:not(:disabled) {
  background: rgb(216 243 255 / 18%);
}

.user-input-reply {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  margin-top: 10px;
}

.user-input-reply input,
.desktop-widget-chat input {
  min-width: 0;
  border: 1px solid rgb(255 255 255 / 24%);
  border-radius: 8px;
  color: #f8fbff;
  background: rgb(12 18 28 / 72%);
  outline: none;
  user-select: text;
  cursor: text;
}

.user-input-reply input {
  padding: 6px 8px;
  font-size: 12px;
}

.user-input-reply button {
  padding: 6px 9px;
}

.desktop-widget-chat {
  position: absolute;
  right: 12px;
  bottom: 64px;
  left: 12px;
  z-index: 10;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 38px;
  gap: 8px;
}

.desktop-widget-chat input {
  height: 34px;
  padding: 0 11px;
  font-size: 13px;
}

.desktop-widget-chat input::placeholder,
.user-input-reply input::placeholder {
  color: #aebdcc;
}

.desktop-widget-chat input:disabled {
  cursor: default;
  opacity: 0.68;
}

.desktop-widget-chat button {
  width: 38px;
  height: 34px;
}

.desktop-widget-chat button:disabled,
.user-input-reply button:disabled {
  cursor: default;
  opacity: 0.52;
}

.desktop-widget-status {
  display: grid;
  gap: 5px;
  padding: 10px 14px 16px;
  border-top: 1px solid rgb(255 255 255 / 14%);
  background: linear-gradient(180deg, rgb(14 19 28 / 38%), rgb(14 19 28 / 78%));
  backdrop-filter: blur(12px);
}

.session-row,
.meta-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.brand {
  flex: 0 0 auto;
  padding: 3px 7px;
  border-radius: 6px;
  color: #0f1722;
  font-size: 11px;
  font-weight: 800;
  background: #d8f3ff;
}

.session-name {
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  font-weight: 800;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-row {
  overflow: hidden;
  color: #d7e2f0;
  font-size: 11px;
}

.meta-row span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resize-corner {
  position: absolute;
  right: 5px;
  bottom: 5px;
  z-index: 30;
  display: grid;
  width: 22px;
  height: 22px;
  align-content: end;
  justify-items: end;
  gap: 2px;
  pointer-events: none;
}

.resize-corner span {
  display: block;
  height: 2px;
  border-radius: 999px;
  background: rgb(222 239 255 / 90%);
  box-shadow: 0 1px 8px rgb(0 0 0 / 25%);
}

.resize-corner span:nth-child(1) {
  width: 7px;
}

.resize-corner span:nth-child(2) {
  width: 12px;
}

.resize-corner span:nth-child(3) {
  width: 17px;
}
</style>
