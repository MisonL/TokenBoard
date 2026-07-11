import { resetDashboardTrendTooltip } from './features/usage/dashboard-trend-tooltip'
import { refreshPublicCardPreview } from './features/public-card/client-preview'
import { leaderboardDocumentTitle } from './features/leaderboards/title'
import { syncCurrentTheme } from './lib/theme-client'

export function initAppNavigation(refreshTimezoneInputs: () => void) {
  document.addEventListener('click', async (event) => {
    const link = getNavigableLink(event)
    if (!link) return
    event.preventDefault()
    await navigateTo(link.href, true, refreshTimezoneInputs)
  })
  window.addEventListener('popstate', () => {
    void navigateTo(window.location.href, false, refreshTimezoneInputs)
  })
}

function getNavigableLink(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
    event.shiftKey || event.altKey || !(event.target instanceof Element)) return null
  const link = event.target.closest<HTMLAnchorElement>('a[href]')
  if (!link || (link.target && link.target !== '_self')) return null
  if (link.hasAttribute('download') || link.dataset.noAjax === 'true') return null
  if (link.origin !== window.location.origin) return null
  const url = new URL(link.href)
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname.startsWith('/api/')) return null
  if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return null
  return link
}

async function navigateTo(pageHref: string, pushState: boolean, refreshTimezoneInputs: () => void) {
  const pageUrl = new URL(pageHref)
  const currentUrl = new URL(window.location.href)
  if (pageUrl.pathname === '/leaderboards' && currentUrl.pathname === '/leaderboards') {
    await replaceLeaderboardPanel(pageUrl, pushState)
    return
  }
  await replaceDocument(pageUrl, pushState, refreshTimezoneInputs)
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
    const response = await fetch(fragmentUrl, { headers: { 'x-tokenboard-fragment': 'leaderboard' } })
    if (!response.ok) throw new Error(`Failed to load leaderboard: ${response.status}`)
    currentPanel.outerHTML = await response.text()
    if (pushState) window.history.pushState({}, '', pageUrl)
    syncDocumentTitle(pageUrl)
    syncScroll(pageUrl)
  } catch (_) {
    window.location.href = pageUrl.toString()
  } finally {
    document.querySelector<HTMLElement>('[data-leaderboard-panel]')?.removeAttribute('aria-busy')
  }
}

async function replaceDocument(pageUrl: URL, pushState: boolean, refreshTimezoneInputs: () => void) {
  document.body.setAttribute('aria-busy', 'true')
  resetDashboardTrendTooltip()
  try {
    const response = await fetch(pageUrl, { headers: { 'x-tokenboard-fragment': 'document' } })
    if (!response.ok) throw new Error(`Failed to load page: ${response.status}`)
    const nextDocument = new DOMParser().parseFromString(await response.text(), 'text/html')
    const resolvedUrl = new URL(response.url || pageUrl.toString())
    if (!nextDocument.body) throw new Error('Missing body in response document')
    document.body.innerHTML = nextDocument.body.innerHTML
    if (pushState) window.history.pushState({}, '', resolvedUrl)
    document.title = nextDocument.title || document.title
    syncCurrentTheme()
    refreshTimezoneInputs()
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
    period: pageUrl.searchParams.get('period'), metric: pageUrl.searchParams.get('metric')
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
