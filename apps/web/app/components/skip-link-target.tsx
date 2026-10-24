/**
 * The target of the shell's "skip to content" link (`#app-content`).
 *
 * The shell renders that link as the first focusable element in `<body>`, before every page's
 * `<main>`. The anchor it points at has to sit *after* the repeated navigation, which is why
 * `AppNav` renders one — the app's `<main>` wraps the nav, so an anchor on `<main>` would land
 * the keyboard user at the top of the page, before the navigation they meant to skip.
 *
 * Pages that render no `AppNav` (the 404 and error surfaces) have no navigation to skip, so
 * they render this anchor themselves; without it the link would be a dead target. Keeping the
 * id in one component means the link and the anchor cannot drift apart.
 */
export function SkipLinkTarget() {
  return <div id="app-content" tabindex={-1} class="scroll-mt-4 outline-none" />
}
