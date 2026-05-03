import { fetchEventData } from 'fetch-sse'
import type { ServerSentEvent } from 'fetch-sse'
import { getCurrentInstance, onUnmounted, ref } from 'vue'
import type { Ref } from 'vue'
import { getDefaultServerUrl } from '../../utils/serverUrl'

export interface DesktopWidgetChatOptions {
  serverUrl?: string
  fetchEventDataFn?: typeof import('fetch-sse').fetchEventData
}

export type ChatBrand = 'codex' | 'claude'

export interface PendingApproval {
  pending_id: string
  description?: string
}

export interface DesktopWidgetChat {
  isStreaming: Ref<boolean>
  assistantText: Ref<string>
  lastUserMessage: Ref<string>
  error: Ref<string>
  toolCallHint: Ref<string>
  pendingApproval: Ref<PendingApproval | null>
  awaitingUserInput: Ref<boolean>
  send: (text: string, sessionId: string, brand: ChatBrand) => Promise<void>
  respondToApproval: (decision: 'allow_once' | 'deny_once') => Promise<void>
  respondToUserInput: (text: string) => Promise<void>
  cancel: () => void
  reset: () => void
}

type EventPayload = Record<string, unknown>

const CHAT_PATH = '/api/session-bridge/agent/chat'
const APPROVAL_PATH = '/api/session-bridge/agent/chat/approval'

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function normalizeBrand(value: ChatBrand): ChatBrand {
  return value === 'claude' ? 'claude' : 'codex'
}

function isRecord(value: unknown): value is EventPayload {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stringFromUnknown(value: unknown, fallback = ''): string {
  if (typeof value === 'string' && value.trim()) return value
  if (value instanceof Error && value.message) return value.message
  if (isRecord(value)) {
    return asString(value.message)
      || asString(value.error)
      || asString(value.detail)
      || asString(value.content)
      || fallback
  }
  return fallback
}

function getEventContent(data: EventPayload): EventPayload {
  return isRecord(data.content) ? data.content : data
}

function hasRequestUserInput(data: EventPayload): boolean {
  const content = data.content
  if (!Array.isArray(content)) return false
  return content.some((item) => isRecord(item) && item.name === 'request_user_input')
}

async function parseJsonResponse(response: Response): Promise<EventPayload> {
  try {
    const data = await response.json()
    return isRecord(data) ? data : {}
  } catch {
    return {}
  }
}

/**
 * v1 desktop-widget chat only shows the current turn. Approval and input waits
 * are handled inline, while history, tool details, and session creation remain
 * in the main UI.
 */
export function useDesktopWidgetChat(options: DesktopWidgetChatOptions = {}): DesktopWidgetChat {
  const serverUrl = options.serverUrl ?? getDefaultServerUrl()
  const fetchEventDataFn = options.fetchEventDataFn ?? fetchEventData
  const baseUrl = trimTrailingSlash(serverUrl)

  const isStreaming = ref(false)
  const assistantText = ref('')
  const lastUserMessage = ref('')
  const error = ref('')
  const toolCallHint = ref('')
  const pendingApproval = ref<PendingApproval | null>(null)
  const awaitingUserInput = ref(false)

  let targetSessionId = ''
  let targetBrand: ChatBrand = 'codex'
  let controller: AbortController | null = null

  function reset(): void {
    assistantText.value = ''
    lastUserMessage.value = ''
    error.value = ''
    toolCallHint.value = ''
    pendingApproval.value = null
    awaitingUserInput.value = false
  }

  function cancel(): void {
    if (controller) {
      controller.abort()
      controller = null
    }
    isStreaming.value = false
  }

  function handleStreamEvent(event: ServerSentEvent | null): void {
    if (!event?.data) return
    let data: EventPayload
    try {
      const parsed = JSON.parse(event.data)
      if (!isRecord(parsed)) return
      data = parsed
    } catch {
      error.value = 'stream error'
      isStreaming.value = false
      return
    }

    if (data.type === 'text') {
      assistantText.value += asString(data.content)
      return
    }

    if (data.type === 'tool_calls') {
      toolCallHint.value = '🔧 工具呼叫'
      if (hasRequestUserInput(data)) {
        awaitingUserInput.value = true
        isStreaming.value = false
      }
      return
    }

    if (data.type === 'approval_request') {
      const content = getEventContent(data)
      const pendingId = asString(content.pending_id)
      if (!pendingId) return
      pendingApproval.value = {
        pending_id: pendingId,
        description: asString(content.description)
          || asString(content.tool_name)
          || asString(content.command)
          || asString(content.justification),
      }
      return
    }

    if (data.type === 'request_user_input') {
      awaitingUserInput.value = true
      isStreaming.value = false
      return
    }

    if (data.type === 'error') {
      error.value = asString(data.message) || asString(data.content) || 'stream error'
      isStreaming.value = false
      return
    }

    if (data.type === 'done') {
      isStreaming.value = false
      toolCallHint.value = ''
    }
  }

  async function send(text: string, sessionId: string, brand: ChatBrand): Promise<void> {
    const message = text.trim()
    if (!message || !sessionId || isStreaming.value) return

    reset()
    lastUserMessage.value = message
    targetSessionId = sessionId
    targetBrand = normalizeBrand(brand)
    isStreaming.value = true

    const activeController = new AbortController()
    controller = activeController

    try {
      await fetchEventDataFn(`${baseUrl}${CHAT_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        data: {
          session_id: targetSessionId,
          message,
          agent_brand: targetBrand,
        },
        signal: activeController.signal,
        onMessage: (event) => {
          if (controller !== activeController) return
          handleStreamEvent(event)
        },
        onError: (err) => {
          if (activeController.signal.aborted || controller !== activeController) return
          error.value = stringFromUnknown(err, 'network error')
          isStreaming.value = false
        },
        onClose: () => {
          if (controller === activeController) {
            isStreaming.value = false
          }
        },
      })
    } catch (err) {
      if (!activeController.signal.aborted && controller === activeController) {
        error.value = stringFromUnknown(err, 'network error')
        isStreaming.value = false
      }
    } finally {
      if (controller === activeController) {
        controller = null
        isStreaming.value = false
      }
    }
  }

  async function respondToApproval(decision: 'allow_once' | 'deny_once'): Promise<void> {
    const approval = pendingApproval.value
    if (!approval || !targetSessionId) return

    // Codex and Claude approval handlers resolve a pending future awaited by the
    // current SSE stream, so a successful approval resumes that same stream.
    let response: Response
    try {
      response = await fetch(`${baseUrl}${APPROVAL_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pending_id: approval.pending_id,
          decision,
          prefix_rule: null,
          agent_brand: targetBrand,
        }),
      })
    } catch (err) {
      error.value = stringFromUnknown(err, 'approval failed')
      return
    }
    const data = await parseJsonResponse(response)
    if (!response.ok || data.ok !== true) {
      error.value = stringFromUnknown(data, `approval failed: ${response.status}`)
      return
    }
    pendingApproval.value = null
  }

  async function respondToUserInput(text: string): Promise<void> {
    if (!awaitingUserInput.value || !targetSessionId) return
    const sessionId = targetSessionId
    const brand = targetBrand
    awaitingUserInput.value = false
    await send(text, sessionId, brand)
  }

  if (getCurrentInstance()) {
    onUnmounted(() => {
      cancel()
    })
  }

  return {
    isStreaming,
    assistantText,
    lastUserMessage,
    error,
    toolCallHint,
    pendingApproval,
    awaitingUserInput,
    send,
    respondToApproval,
    respondToUserInput,
    cancel,
    reset,
  }
}
