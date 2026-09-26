import { jsxRenderer } from 'hono/jsx-renderer'
import { Link } from 'honox/server'
import { initialColorScheme, mobileNightModeOptOutMeta, themeChromeColors } from '../lib/theme'
import { themeScript } from '../lib/theme-script'

type Manifest = Record<string, { file?: string }>
type ManifestModule = { default?: Manifest }

export default jsxRenderer(({ children }) => {
  const clientScriptSrc = getClientScriptSrc()

  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="color-scheme" content={initialColorScheme} />
        <meta name={mobileNightModeOptOutMeta.name} content={mobileNightModeOptOutMeta.content} />
        <meta name="theme-color" content={themeChromeColors.dark} />
        <link rel="icon" type="image/svg+xml" href="/logo.svg" />
        <link rel="alternate icon" href="/favicon.ico" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <Link href="/app/style.css" rel="stylesheet" />
        <script type="module" src={clientScriptSrc} async />
      </head>
      <body>{children}</body>
    </html>
  )
})

function getClientScriptSrc() {
  if (!import.meta.env.PROD) return '/app/client.ts'

  const manifestFiles = import.meta.glob<ManifestModule>('/dist/.vite/manifest.json', { eager: true })
  for (const manifestFile of Object.values(manifestFiles)) {
    const manifest = manifestFile.default
    const clientEntry = manifest?.['app/client.ts']
    if (clientEntry?.file) return `/${clientEntry.file}`
  }

  return '/app/client.ts'
}
