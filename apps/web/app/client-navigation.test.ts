import { afterEach, describe, expect, test, vi } from 'vitest'
import { initAppNavigation } from './client-navigation'

describe('client navigation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('ignores an older document response that resolves after a newer navigation', async () => {
    const dom = installNavigationDom()
    const requests = new Map<string, (response: Response) => void>()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (input: string | URL) =>
          new Promise<Response>((resolve) => {
            requests.set(new URL(String(input)).pathname, resolve)
          })
      )
    )

    initAppNavigation(() => undefined)
    const firstNavigation = dom.click('/first')
    const secondNavigation = dom.click('/second')

    requests.get('/second')?.(navigationResponse('/second', 'second document'))
    await secondNavigation
    requests.get('/first')?.(navigationResponse('/first', 'first document'))
    await firstNavigation

    expect(dom.body.innerHTML).toBe('second document')
    expect(dom.history).toEqual(['/second'])
  })

  test('clears a superseded document busy state when a leaderboard fragment wins', async () => {
    const dom = installNavigationDom({ initialPath: '/leaderboards', hasLeaderboardPanel: true })
    const requests = new Map<string, (response: Response) => void>()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (input: string | URL) =>
          new Promise<Response>((resolve) => {
            requests.set(new URL(String(input)).pathname, resolve)
          })
      )
    )

    initAppNavigation(() => undefined)
    const documentNavigation = dom.click('/dashboard')
    const fragmentNavigation = dom.click('/leaderboards?period=monthly')

    requests.get('/leaderboards/fragment')?.(navigationResponse('/leaderboards/fragment', 'monthly panel'))
    await fragmentNavigation
    requests.get('/dashboard')?.(navigationResponse('/dashboard', 'dashboard document'))
    await documentNavigation

    expect(dom.body.hasAttribute('aria-busy')).toBe(false)
  })

  // Swapping the panel's outerHTML destroys the element that held focus, so a keyboard user who
  // activated a tab used to land on <body> and had to Tab through the whole page again. Focus
  // has to follow the selection into the swapped-in control.
  test('restores focus to the tab it just swapped in', async () => {
    const dom = installNavigationDom({ initialPath: '/leaderboards', hasLeaderboardPanel: true })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => navigationResponse('/leaderboards/fragment', '<div data-leaderboard-panel="true"></div>'))
    )

    initAppNavigation(() => undefined)
    await dom.click('/leaderboards?period=monthly&metric=cost', 'period')

    expect(dom.focused).toEqual(['leaderboard-link'])
  })

  // Several links share a period — one per metric — so a selector built from `period` alone
  // matches the first of them. Changing only the metric then focused a different tab than the
  // one the user clicked. The strip the link is read from is what disambiguates, and the fake
  // element records it because a stubbed `Element` cannot.
  test('targets the strip the clicked link is in, not the first matching period', async () => {
    const dom = installNavigationDom({ initialPath: '/leaderboards', hasLeaderboardPanel: true })
    const selectors: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => navigationResponse('/leaderboards/fragment', '<div data-leaderboard-panel="true"></div>'))
    )
    const originalQuerySelector = dom.querySelector
    dom.querySelector = (selector: string) => {
      selectors.push(selector)
      return originalQuerySelector(selector)
    }

    initAppNavigation(() => undefined)
    await dom.click('/leaderboards?period=daily&metric=tokens-without-cache-read', 'metric')

    expect(selectors).toContain('[data-leaderboard-group="metric"] [aria-current]')
    expect(selectors.some((selector) => selector.includes('data-leaderboard-group="period"'))).toBe(false)
    expect(dom.focused).toEqual(['leaderboard-link'])
  })
})

function installNavigationDom(
  options: {
    initialPath?: string
    hasLeaderboardPanel?: boolean
    fragmentHtml?: string
  } = {}
) {
  const listeners = new Map<string, (event: Event) => Promise<void> | void>()
  const body = new FakeBody()
  const leaderboardPanel = options.hasLeaderboardPanel ? new FakePanel() : null
  const focused: string[] = []
  const history: string[] = []
  const location = new URL(options.initialPath ?? '/start', 'https://tokenboard.example.com')
  // One object serves as both the returned handle and the object `document.querySelector`
  // delegates to, so a test that wraps a method on the handle is seen by the code under test.
  const dom = {
    body,
    history,
    focused,
    querySelector: (selector: string): unknown => {
      if (selector === '[data-leaderboard-panel]') return leaderboardPanel
      // The focus restore looks up the active tab of the strip the clicked link was in. The
      // double answers that selector and records it so a test can assert which strip it named.
      if (selector.includes('data-leaderboard-group')) {
        return { focus: () => focused.push('leaderboard-link') }
      }
      return null
    },
    click(pathname: string, group: 'period' | 'metric' | null = null) {
      const href = new URL(pathname, location).toString()
      const link = {
        href,
        origin: location.origin,
        target: '',
        dataset: {},
        hasAttribute: () => false,
        closest: (selector: string) =>
          selector === '[data-leaderboard-group]' && group ? { dataset: { leaderboardGroup: group } } : null
      }
      const event = {
        defaultPrevented: false,
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        target: new FakeElement(link),
        preventDefault: () => undefined
      }
      return Promise.resolve(listeners.get('click')?.(event as unknown as Event))
    }
  }
  const document = {
    body,
    title: 'Start',
    documentElement: {
      dataset: { theme: 'dark' },
      classList: { toggle: () => undefined },
      style: {}
    },
    addEventListener(type: string, listener: (event: Event) => Promise<void> | void) {
      listeners.set(type, listener)
    },
    querySelector: (selector: string) => dom.querySelector(selector),
    querySelectorAll: () => [],
    getElementById: () => null
  }
  const window = {
    location,
    history: {
      pushState(_state: unknown, _unused: string, url: URL) {
        history.push(url.pathname)
      }
    },
    addEventListener: () => undefined,
    scrollTo: () => undefined
  }

  vi.stubGlobal('Element', FakeElement)
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', window)
  vi.stubGlobal(
    'DOMParser',
    class {
      parseFromString(value: string) {
        return { body: { innerHTML: value }, title: value }
      }
    }
  )

  return dom
}

function navigationResponse(pathname: string, body: string) {
  return {
    ok: true,
    url: `https://tokenboard.example.com${pathname}`,
    text: async () => body
  } as Response
}

class FakeElement {
  constructor(private readonly link: unknown) {}

  // The navigation code asks the clicked element which tab strip it is in; the fake link carries
  // that answer, so the stub has to pass it through rather than return the link itself.
  closest(selector: string) {
    if (selector !== '[data-leaderboard-group]') return this.link
    return (this.link as { closest: (s: string) => unknown }).closest(selector)
  }
}

class FakeBody {
  innerHTML = ''
  private readonly attributes = new Map<string, string>()

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  removeAttribute(name: string) {
    this.attributes.delete(name)
  }

  hasAttribute(name: string) {
    return this.attributes.has(name)
  }
}

class FakePanel extends FakeBody {
  outerHTML = ''
  readonly classList = {
    add: () => undefined,
    remove: () => undefined
  }
}
