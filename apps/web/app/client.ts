import { createClient } from 'honox/client'
import { initCustomSelects } from './components/ui/custom-select-client'
import { initDashboardTrendTooltip, resetDashboardTrendTooltip } from './features/usage/dashboard-trend-tooltip'
import { shouldEnhanceDeviceDetailsClick } from './features/device/device-details-client'
import { initPublicCardPreview, refreshPublicCardPreview } from './features/public-card/client-preview'
import { leaderboardDocumentTitle } from './features/leaderboards/title'
import { copyTextToClipboard } from './lib/clipboard'
import { initTheme, syncCurrentTheme } from './lib/theme-client'
import { isValidTimezone, timezoneCookieName } from './lib/timezone'

createClient()
type ToastTone = 'success' | 'error'

initTheme()
initBrowserTimezone()
initTimezoneInputs()

initCopyButtons()
initConfirmableActions()
initDeviceDetailsDialogs()
initSubmitFeedback()
initLoginCardFocus()
initAppNavigation()
initCustomSelects()
initPublicCardPreview()
initDashboardTrendTooltip()

const loginCardAttentionDurationMs = 900
const loginCardScrollAttentionDelayMs = 320
let loginCardFocusSeq = 0

function initBrowserTimezone() {
  const timezone = detectBrowserTimezone()
  if (!timezone) return

  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${timezoneCookieName}=${encodeURIComponent(timezone)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
}

function initTimezoneInputs() {
  const timezone = detectBrowserTimezone()
  if (!timezone) return

  document.querySelectorAll<HTMLInputElement>('[data-timezone-input]').forEach((input) => {
    const mode = input.dataset.timezoneAutofill
    if (mode !== 'true' && mode !== 'always') return
    if (mode === 'always') {
      input.value = timezone
      return
    }

    const initialValue = input.dataset.timezoneDefault?.trim() || input.defaultValue.trim()
    const currentValue = input.value.trim()
    if (currentValue && currentValue !== 'UTC' && initialValue !== 'UTC') return

    input.value = timezone
  })
}

function detectBrowserTimezone() {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return isValidTimezone(timezone) ? timezone : null
  } catch (_) {
    return null
  }
}

function initCopyButtons() {
  document.addEventListener('click', async (event) => {
    if (!(event.target instanceof Element)) return

    const button = event.target.closest<HTMLButtonElement>('[data-copy-target]')
    if (!button) return

    const targetId = button.dataset.copyTarget
    const text = targetId ? document.getElementById(targetId)?.textContent : null
    if (!text) return

    event.preventDefault()

    const originalLabel = button.getAttribute('aria-label') || '复制'
    const originalTitle = button.getAttribute('title') || originalLabel
    const copied = await copyTextToClipboard(navigator.clipboard, text)

    button.dataset.copied = copied ? 'true' : 'false'
    button.setAttribute('aria-label', copied ? '已复制' : '复制失败')
    button.setAttribute('title', copied ? '已复制' : '复制失败')
    showToast(copied ? '已复制到剪贴板' : '复制失败，请手动选择文本复制', copied ? 'success' : 'error')

    window.setTimeout(() => {
      button.dataset.copied = 'idle'
      button.setAttribute('aria-label', originalLabel)
      button.setAttribute('title', originalTitle)
    }, 1600)
  })
}

function initConfirmableActions() {
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return

    const button = event.target.closest<HTMLButtonElement>('[data-confirm]')
    if (!button) return

    const message = button.dataset.confirm?.trim()
    if (message && !window.confirm(message)) {
      event.preventDefault()
      event.stopPropagation()
    }
  })
}

function initDeviceDetailsDialogs() {
  if (typeof HTMLDialogElement === 'undefined') return
  let activeDetailsRequest: { controller: AbortController; nonce: number } | null = null
  let detailsRequestSeq = 0

  document.addEventListener('click', async (event) => {
    if (!(event.target instanceof Element)) return

    const openButton = event.target.closest<HTMLAnchorElement>('[data-device-details-open]')
    if (openButton) {
      if (!shouldEnhanceDeviceDetailsClick(event)) return
      event.preventDefault()
      const dialogId = openButton.dataset.deviceDetailsOpen
      const dialog = dialogId ? document.getElementById(dialogId) : null
      if (dialog instanceof HTMLDialogElement) {
        activeDetailsRequest?.controller.abort()
        const controller = new AbortController()
        const nonce = ++detailsRequestSeq
        activeDetailsRequest = { controller, nonce }
        dialog.setAttribute('aria-labelledby', 'device-details-dialog-title')
        dialog.innerHTML = renderDeviceDetailsLoading()
        if (!dialog.open) {
          dialog.showModal()
        }

        try {
          const response = await fetch(openButton.href, {
            headers: { 'x-tokenboard-fragment': 'device-details' },
            signal: controller.signal
          })
          if (response.status >= 500) throw new Error(`Failed to load device details: ${response.status}`)
          if (!activeDetailsRequest || activeDetailsRequest.nonce !== nonce || controller.signal.aborted) return
          const html = await response.text()
          if (!activeDetailsRequest || activeDetailsRequest.nonce !== nonce || controller.signal.aborted) return
          dialog.innerHTML = html
          activeDetailsRequest = null
        } catch (_) {
          if (controller.signal.aborted) return
          if (activeDetailsRequest && activeDetailsRequest.nonce === nonce) {
            activeDetailsRequest = null
          }
          dialog.close()
          window.location.href = openButton.href
        }
      } else {
        window.location.href = openButton.href
      }
      return
    }

    const closeButton = event.target.closest<HTMLButtonElement>('[data-device-details-close]')
    if (closeButton) {
      event.preventDefault()
      activeDetailsRequest?.controller.abort()
      activeDetailsRequest = null
      const dialog = closeButton.closest<HTMLDialogElement>('[data-device-details-dialog]')
      dialog?.close()
      return
    }

    if (event.target instanceof HTMLDialogElement && event.target.dataset.deviceDetailsDialog === 'true') {
      activeDetailsRequest?.controller.abort()
      activeDetailsRequest = null
      event.target.close()
    }
  })

  document.addEventListener('cancel', abortActiveDeviceDetailsRequest, true)
  document.addEventListener('close', abortActiveDeviceDetailsRequest, true)

  function abortActiveDeviceDetailsRequest(event: Event) {
    if (!(event.target instanceof HTMLDialogElement)) return
    if (event.target.dataset.deviceDetailsDialog !== 'true') return
    activeDetailsRequest?.controller.abort()
    activeDetailsRequest = null
  }
}

function renderDeviceDetailsLoading() {
  return `
    <header class="flex items-start justify-between gap-3 border-b border-[var(--app-border)] bg-[var(--app-panel)] p-4">
      <div class="min-w-0">
        <p id="device-details-dialog-title" class="text-base font-black text-[var(--app-text)]">设备详情</p>
        <p class="mt-1 text-sm font-bold text-[var(--app-muted)]">正在加载...</p>
      </div>
      <button
        type="button"
        class="inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--app-border)] bg-[var(--app-bg-soft)] text-[var(--app-muted)] transition hover:bg-[var(--app-hover)] hover:text-[var(--app-text)]"
        data-device-details-close="true"
        aria-label="关闭详情"
      >
        x
      </button>
    </header>
    <div class="app-device-dialog-body bg-[var(--app-bg-soft)] p-4 text-sm font-bold text-[var(--app-muted)]">
      正在加载设备安装、凭证和最近操作。
    </div>
  `
}

function initSubmitFeedback() {
  document.addEventListener('submit', (event) => {
    const form = event.target
    if (!(form instanceof HTMLFormElement)) return
    if (form.dataset.submitFeedback !== 'true') return
    if (form.dataset.submitting === 'true') {
      event.preventDefault()
      return
    }

    const submitter = event.submitter instanceof HTMLButtonElement ? event.submitter : null
    preserveSubmitterValue(form, submitter)
    form.dataset.submitting = 'true'
    form.setAttribute('aria-busy', 'true')

    form.querySelectorAll<HTMLButtonElement>('button[type="submit"], button:not([type])').forEach((button) => {
      button.disabled = true
      if (button === submitter) {
        button.dataset.submitting = 'true'
        button.dataset.originalLabel = button.textContent?.trim() || ''
        button.textContent = button.dataset.submittingLabel || '处理中...'
      }
    })
  })
}

function initLoginCardFocus() {
  document.addEventListener('click', (event) => {
    const trigger = getLoginFocusTrigger(event)
    if (!trigger) return

    const currentUrl = new URL(window.location.href)
    const targetUrl = new URL(trigger.href)
    if (
      currentUrl.pathname !== '/auth/sign-in' ||
      targetUrl.pathname !== '/auth/sign-in' ||
      targetUrl.search !== currentUrl.search
    ) {
      return
    }

    const card = document.querySelector<HTMLElement>('[data-login-card="true"]')
    if (!card) return

    event.preventDefault()
    focusLoginCard(card)
  })
}

function getLoginFocusTrigger(event: MouseEvent) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    !(event.target instanceof Element)
  ) {
    return null
  }

  return event.target.closest<HTMLAnchorElement>('a[data-login-focus="true"][href]')
}

function focusLoginCard(card: HTMLElement) {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const shouldDelayAttention = !reducedMotion && !isElementFullyVisible(card)
  const runId = String(++loginCardFocusSeq)

  card.dataset.loginFocusRun = runId
  card.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' })

  window.setTimeout(() => {
    startLoginCardAttention(card, runId)
  }, shouldDelayAttention ? loginCardScrollAttentionDelayMs : 0)
}

function isElementFullyVisible(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth

  return rect.top >= 0 && rect.left >= 0 && rect.bottom <= viewportHeight && rect.right <= viewportWidth
}

function startLoginCardAttention(card: HTMLElement, runId: string) {
  if (card.dataset.loginFocusRun !== runId) return

  card.classList.remove('app-login-card-attention')
  void card.offsetWidth
  card.classList.add('app-login-card-attention')

  window.setTimeout(() => {
    if (card.dataset.loginFocusRun !== runId) return
    card.classList.remove('app-login-card-attention')
    delete card.dataset.loginFocusRun
  }, loginCardAttentionDurationMs)
}

function preserveSubmitterValue(form: HTMLFormElement, submitter: HTMLButtonElement | null) {
  if (!submitter?.name) return
  const existing = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="hidden"][data-submit-feedback-value]'))
    .some((input) => input.dataset.submitFeedbackValue === submitter.name)
  if (existing) return

  const input = document.createElement('input')
  input.type = 'hidden'
  input.name = submitter.name
  input.value = submitter.value
  input.dataset.submitFeedbackValue = submitter.name
  form.appendChild(input)
}

function showToast(message: string, tone: ToastTone) {
  const container = getToastContainer()
  const toast = document.createElement('div')
  toast.className = 'app-toast'
  toast.dataset.tone = tone
  toast.setAttribute('role', 'status')
  toast.textContent = message

  container.appendChild(toast)
  window.requestAnimationFrame(() => {
    toast.dataset.visible = 'true'
  })

  window.setTimeout(() => {
    toast.dataset.visible = 'false'
    window.setTimeout(() => {
      toast.remove()
      if (!container.childElementCount) container.remove()
    }, 220)
  }, 2200)
}

function getToastContainer() {
  const existing = document.querySelector<HTMLDivElement>('[data-toast-container]')
  if (existing) return existing

  const container = document.createElement('div')
  container.className = 'app-toast-viewport'
  container.dataset.toastContainer = 'true'
  container.setAttribute('aria-live', 'polite')
  container.setAttribute('aria-atomic', 'true')
  document.body.appendChild(container)
  return container
}

function initAppNavigation() {
  document.addEventListener('click', async (event) => {
    const link = getNavigableLink(event)
    if (!link) return

    event.preventDefault()
    await navigateTo(link.href, true)
  })

  window.addEventListener('popstate', () => {
    void navigateTo(window.location.href, false)
  })
}

function getNavigableLink(event: MouseEvent) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    !(event.target instanceof Element)
  ) {
    return null
  }

  const link = event.target.closest<HTMLAnchorElement>('a[href]')
  if (!link) return null
  if (link.target && link.target !== '_self') return null
  if (link.hasAttribute('download') || link.dataset.noAjax === 'true') return null
  if (link.origin !== window.location.origin) return null

  const url = new URL(link.href)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.pathname.startsWith('/api/')) return null
  if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return null

  return link
}

async function navigateTo(pageHref: string, pushState: boolean) {
  const pageUrl = new URL(pageHref)
  const currentUrl = new URL(window.location.href)
  const shouldReplaceLeaderboardPanel =
    pageUrl.pathname === '/leaderboards' &&
    currentUrl.pathname === '/leaderboards'

  if (shouldReplaceLeaderboardPanel) {
    await replaceLeaderboardPanel(pageUrl, pushState)
    return
  }

  await replaceDocument(pageUrl, pushState)
}

async function replaceLeaderboardPanel(pageUrl: URL, pushState: boolean) {
  const currentPanel = document.querySelector<HTMLElement>('[data-leaderboard-panel]')
  if (!currentPanel) {
    window.location.href = pageUrl.toString()
    return
  }

  const fragmentUrl = new URL('/leaderboards/fragment', window.location.origin)
  fragmentUrl.search = pageUrl.search

  currentPanel.setAttribute('aria-busy', 'true')
  currentPanel.classList.add('opacity-70')

  try {
    const response = await fetch(fragmentUrl, {
      headers: { 'x-tokenboard-fragment': 'leaderboard' }
    })
    if (!response.ok) throw new Error(`Failed to load leaderboard: ${response.status}`)

    const html = await response.text()
    currentPanel.outerHTML = html
    if (pushState) window.history.pushState({}, '', pageUrl)
    syncDocumentTitle(pageUrl)
    syncScroll(pageUrl)
  } catch (_) {
    window.location.href = pageUrl.toString()
  } finally {
    document
      .querySelector<HTMLElement>('[data-leaderboard-panel]')
      ?.removeAttribute('aria-busy')
  }
}

async function replaceDocument(pageUrl: URL, pushState: boolean) {
  document.body.setAttribute('aria-busy', 'true')
  resetDashboardTrendTooltip()

  try {
    const response = await fetch(pageUrl, {
      headers: { 'x-tokenboard-fragment': 'document' }
    })
    if (!response.ok) throw new Error(`Failed to load page: ${response.status}`)

    const html = await response.text()
    const nextDocument = new DOMParser().parseFromString(html, 'text/html')
    const nextBody = nextDocument.body
    const resolvedUrl = new URL(response.url || pageUrl.toString())
    if (!nextBody) throw new Error('Missing body in response document')

    document.body.innerHTML = nextBody.innerHTML
    if (pushState) window.history.pushState({}, '', resolvedUrl)
    document.title = nextDocument.title || document.title
    syncCurrentTheme()
    initTimezoneInputs()
    refreshPublicCardPreview()
    syncScroll(resolvedUrl)
  } catch (_) {
    window.location.href = pageUrl.toString()
  } finally {
    document.body.removeAttribute('aria-busy')
  }
}

function syncDocumentTitle(pageUrl: URL) {
  if (pageUrl.pathname !== '/leaderboards') return

  document.title = leaderboardDocumentTitle({
    period: pageUrl.searchParams.get('period'),
    metric: pageUrl.searchParams.get('metric')
  })
}

function syncScroll(pageUrl: URL) {
  if (pageUrl.hash) {
    const target = document.getElementById(pageUrl.hash.slice(1))
    if (target) {
      target.scrollIntoView()
      return
    }
  }

  window.scrollTo(0, 0)
}
