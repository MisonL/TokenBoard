import { resetDashboardTrendTooltip } from './features/usage/dashboard-trend-tooltip'
import { refreshPublicCardPreview } from './features/public-card/client-preview'
import { leaderboardDocumentTitle } from './features/leaderboards/title'
import { syncCurrentTheme } from './lib/theme-client'

export function initAppNavigation(refreshTimezoneInputs: () => void) {
  document.addEventListener('click', async (event) => {
    const link = getNavigableLink(event)
    if (!link) return
    event.preventDefault()
    await navigateTo(link.href, true, refreshTimezoneInputs, leaderboardGroupOf(link))
  })
  window.addEventListener('popstate', () => {
    void navigateTo(window.location.href, false, refreshTimezoneInputs, null)
  })
}

// Which tab strip a link belongs to. The strips are rebuilt on every swap and both carry a link
// per metric, so "the tab the user clicked" is only recoverable from the clicked element itself.
function leaderboardGroupOf(link: HTMLAnchorElement): LeaderboardGroup {
  const group = link.closest<HTMLElement>('[data-leaderboard-group]')?.dataset.leaderboardGroup
  return group === 'period' || group === 'metric' ? group : null
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
  )
    return null
  const link = event.target.closest<HTMLAnchorElement>('a[href]')
  if (!link || (link.target && link.target !== '_self')) return null
  if (link.hasAttribute('download') || link.dataset.noAjax === 'true') return null
  if (link.origin !== window.location.origin) return null
  const url = new URL(link.href)
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname.startsWith('/api/')) return null
  if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return null
  return link
}

async function navigateTo(
  pageHref: string,
  pushState: boolean,
  refreshTimezoneInputs: () => void,
  clickedGroup: LeaderboardGroup
) {
  const navigation = beginNavigation()
  const pageUrl = new URL(pageHref)
  const currentUrl = new URL(window.location.href)
  if (pageUrl.pathname === '/leaderboards' && currentUrl.pathname === '/leaderboards') {
    await replaceLeaderboardPanel(pageUrl, pushState, navigation, clickedGroup)
    return
  }
  await replaceDocument(pageUrl, pushState, refreshTimezoneInputs, navigation)
}

// Which tab strip a swap should leave focus in, named by the link the user activated. A popstate
// carries no such link, and moving focus there would fight the browser's own history handling.
type LeaderboardGroup = 'period' | 'metric' | null

async function replaceLeaderboardPanel(
  pageUrl: URL,
  pushState: boolean,
  navigation: NavigationRequest,
  clickedGroup: LeaderboardGroup
) {
  const currentPanel = document.querySelector<HTMLElement>('[data-leaderboard-panel]')
  if (!currentPanel) {
    if (isCurrentNavigation(navigation)) window.location.href = pageUrl.toString()
    finishNavigation(navigation)
    return
  }
  const fragmentUrl = new URL('/leaderboards/fragment', window.location.origin)
  fragmentUrl.search = pageUrl.search
  markNavigationBusy(navigation, currentPanel, true)
  try {
    const response = await fetch(fragmentUrl, {
      headers: { 'x-tokenboard-fragment': 'leaderboard' },
      signal: navigation.controller.signal
    })
    if (!response.ok) throw new Error(`Failed to load leaderboard: ${response.status}`)
    const html = await response.text()
    if (!isCurrentNavigation(navigation)) return
    currentPanel.outerHTML = html
    if (pushState) window.history.pushState({}, '', pageUrl)
    syncDocumentTitle(pageUrl)
    syncScroll(pageUrl)
    restoreFocusAfterPanelSwap(clickedGroup)
  } catch (_) {
    if (isCurrentNavigation(navigation)) window.location.href = pageUrl.toString()
  } finally {
    if (isCurrentNavigation(navigation)) {
      finishNavigation(navigation)
    }
  }
}

async function replaceDocument(
  pageUrl: URL,
  pushState: boolean,
  refreshTimezoneInputs: () => void,
  navigation: NavigationRequest
) {
  markNavigationBusy(navigation, document.body)
  resetDashboardTrendTooltip()
  try {
    const response = await fetch(pageUrl, {
      headers: { 'x-tokenboard-fragment': 'document' },
      signal: navigation.controller.signal
    })
    if (!response.ok) throw new Error(`Failed to load page: ${response.status}`)
    const nextDocument = new DOMParser().parseFromString(await response.text(), 'text/html')
    const resolvedUrl = new URL(response.url || pageUrl.toString())
    if (!nextDocument.body) throw new Error('Missing body in response document')
    if (!isCurrentNavigation(navigation)) return
    document.body.innerHTML = nextDocument.body.innerHTML
    if (pushState) window.history.pushState({}, '', resolvedUrl)
    document.title = nextDocument.title || document.title
    syncCurrentTheme()
    refreshTimezoneInputs()
    refreshPublicCardPreview()
    syncScroll(resolvedUrl)
  } catch (_) {
    if (isCurrentNavigation(navigation)) window.location.href = pageUrl.toString()
  } finally {
    if (isCurrentNavigation(navigation)) {
      finishNavigation(navigation)
    }
  }
}

type NavigationRequest = {
  id: number
  controller: AbortController
  busyElement?: HTMLElement
  dimsBusyElement?: boolean
}

let nextNavigationId = 0
let activeNavigation: NavigationRequest | null = null

function beginNavigation(): NavigationRequest {
  if (activeNavigation) {
    activeNavigation.controller.abort()
    clearNavigationBusy(activeNavigation)
  }
  const navigation = {
    id: (nextNavigationId += 1),
    controller: new AbortController()
  }
  activeNavigation = navigation
  return navigation
}

function isCurrentNavigation(navigation: NavigationRequest) {
  return activeNavigation?.id === navigation.id
}

function finishNavigation(navigation: NavigationRequest) {
  if (!isCurrentNavigation(navigation)) return
  clearNavigationBusy(navigation)
  activeNavigation = null
}

function markNavigationBusy(navigation: NavigationRequest, element: HTMLElement, dim = false) {
  clearNavigationBusy(navigation)
  navigation.busyElement = element
  navigation.dimsBusyElement = dim
  element.setAttribute('aria-busy', 'true')
  if (dim) element.classList.add('opacity-70')
}

function clearNavigationBusy(navigation: NavigationRequest) {
  const element = navigation.busyElement
  if (!element) return
  element.removeAttribute('aria-busy')
  if (navigation.dimsBusyElement) element.classList.remove('opacity-70')
  navigation.busyElement = undefined
  navigation.dimsBusyElement = undefined
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

// Replacing the panel's `outerHTML` destroys the element that held focus, so a keyboard user who
// activated a tab lands on `<body>` and has to Tab through the whole page again. Move focus to
// the active tab of the strip they were in, so the swap is invisible to them.
function restoreFocusAfterPanelSwap(group: LeaderboardGroup) {
  if (!group) return
  const target = document.querySelector<HTMLAnchorElement>(`[data-leaderboard-group="${group}"] [aria-current]`)
  if (!target) return
  target.focus()
}
