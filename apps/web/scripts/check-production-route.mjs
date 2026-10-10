import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_CONFIG_FILE = fileURLToPath(new URL('../wrangler.production.jsonc', import.meta.url))
const CONFIG_FILE = process.env.TOKENBOARD_WRANGLER_CONFIG?.trim() || DEFAULT_CONFIG_FILE
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
const REQUEST_TIMEOUT_MS = 10_000

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

export async function verifyProductionRoute({
  configPath = CONFIG_FILE,
  token = readCloudflareToken(),
  fetcher = globalThis.fetch.bind(globalThis)
} = {}) {
  const route = readProductionRoute(configPath)
  if (!token) {
    throw new Error(
      'Production route preflight requires Cloudflare authentication. Set CLOUDFLARE_API_TOKEN or run wrangler login.'
    )
  }

  const zone = await findAccessibleZone(route, token, fetcher)
  if (!zone) {
    throw new Error(
      `Cloudflare zone for ${route} is not accessible with the current credentials. Verify the account, zone, and DNS ownership before deploying.`
    )
  }
  return { route, zone }
}

export function readProductionRoute(configPath = CONFIG_FILE) {
  const path = resolve(configPath)
  if (!existsSync(path)) throw new Error(`Production Wrangler config does not exist: ${path}`)
  let config
  try {
    config = JSON.parse(stripJsonc(readFileSync(path, 'utf8')))
  } catch (error) {
    throw new Error(
      `Unable to parse production Wrangler config: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const route = config.routes?.find(
    (value) => value && value.custom_domain === true && typeof value.pattern === 'string'
  )
  if (!route) throw new Error('Production Wrangler config is missing an enabled custom domain route.')
  const pattern = route.pattern.trim()
  const hostname = pattern.startsWith('*.') ? pattern.slice(2) : pattern
  const normalizedHostname = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname
  const labels = normalizedHostname.split('.')
  const validHostname =
    normalizedHostname.length <= 253 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  if (
    !normalizedHostname ||
    hostname.endsWith('..') ||
    hostname.includes('/') ||
    hostname.includes('?') ||
    hostname.includes('#') ||
    !validHostname
  ) {
    throw new Error(`Production custom domain route is invalid: ${pattern}`)
  }
  return normalizedHostname.toLowerCase()
}

export async function findAccessibleZone(hostname, token, fetcher = globalThis.fetch.bind(globalThis)) {
  const labels = hostname.split('.')
  for (let index = 0; index <= labels.length - 2; index += 1) {
    const candidate = labels.slice(index).join('.')
    const response = await fetchJson(
      `${CLOUDFLARE_API_BASE}/zones?name=${encodeURIComponent(candidate)}&status=active`,
      token,
      fetcher
    )
    const zone = response.result?.find((value) => value && value.status === 'active' && value.name === candidate)
    if (zone) return { id: zone.id, name: zone.name, status: zone.status }
  }
  return null
}

export function readCloudflareToken(env = process.env) {
  const explicit = env.CLOUDFLARE_API_TOKEN?.trim() || env.CF_API_TOKEN?.trim()
  if (explicit) return explicit

  for (const path of wranglerAuthPaths(env)) {
    if (!existsSync(path)) continue
    try {
      const content = readFileSync(path, 'utf8')
      const match = /^oauth_token\s*=\s*"([^"]+)"\s*$/m.exec(content)
      if (match?.[1]) return match[1]
    } catch {
      // Try the next auth location; the deploy will report a useful error below.
    }
  }
  return ''
}

async function runCli() {
  const result = await verifyProductionRoute()
  console.log(`Cloudflare production route preflight passed: ${result.route} (${result.zone.name})`)
}

async function fetchJson(url, token, fetcher) {
  let response
  try {
    response = await fetcher(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    throw new Error(
      `Cloudflare zone preflight request failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      'Cloudflare credentials were rejected during production route preflight. Run wrangler login or set CLOUDFLARE_API_TOKEN.'
    )
  }
  if (!response.ok) throw new Error(`Cloudflare zone preflight returned HTTP ${response.status}.`)
  let body
  try {
    body = await response.json()
  } catch (error) {
    throw new Error(
      `Cloudflare zone preflight returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!body?.success || !Array.isArray(body.result)) {
    throw new Error('Cloudflare zone preflight returned an invalid API response.')
  }
  return body
}

// Mirrors how wrangler itself resolves the auth file, so a logged-in `wrangler login` is found
// wherever wrangler would have written it. wrangler (4.x) builds the config directory as
// `xdgConfig()/.wrangler`, where `xdgConfig()` honours `XDG_CONFIG_HOME` and otherwise falls
// back per platform (macOS `~/Library/Preferences`, Windows `%APPDATA%/xdg.config`, else
// `~/.config`); when the legacy `~/.wrangler` directory exists it takes precedence. The auth
// file is always `<configDir>/config/default.toml`. `WRANGLER_CONFIG_DIR` is not a variable
// wrangler reads — it is kept first only because this repo's own tooling documents it.
export function wranglerAuthPaths(env = process.env, deps = {}) {
  const home = deps.home ?? homedir()
  const os = deps.platform ?? platform()
  const isDirectory = deps.isDirectory ?? defaultIsDirectory
  const candidates = []

  const configured = env.WRANGLER_CONFIG_DIR?.trim()
  if (configured) candidates.push(resolve(configured, 'config/default.toml'))

  const legacyConfigDir = resolve(home, '.wrangler')
  if (isDirectory(legacyConfigDir)) candidates.push(resolve(legacyConfigDir, 'config/default.toml'))

  const xdgHome = env.XDG_CONFIG_HOME?.trim()
  const configBase = xdgHome
    ? resolve(xdgHome)
    : os === 'darwin'
      ? resolve(home, 'Library/Preferences')
      : os === 'win32'
        ? resolve(env.APPDATA?.trim() || home, 'xdg.config')
        : resolve(home, '.config')
  candidates.push(resolve(configBase, '.wrangler/config/default.toml'))

  // The pre-XDG default, kept last for older wrangler installs on any platform.
  candidates.push(resolve(home, '.config/.wrangler/config/default.toml'))
  candidates.push(resolve(legacyConfigDir, 'config/default.toml'))

  return [...new Set(candidates)]
}

function defaultIsDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function stripJsonc(value) {
  let result = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    const next = value[index + 1]
    if (inString) {
      result += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      result += char
      continue
    }
    if (char === '/' && next === '/') {
      while (index < value.length && value[index] !== '\n') index += 1
      result += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      let terminated = false
      while (index < value.length) {
        if (value[index] === '*' && value[index + 1] === '/') {
          terminated = true
          index += 1
          break
        }
        index += 1
      }
      if (!terminated) throw new SyntaxError('Unterminated JSONC block comment')
      continue
    }
    result += char
  }
  return stripTrailingCommas(result)
}

function stripTrailingCommas(value) {
  let result = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (inString) {
      result += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      result += char
      continue
    }
    if (char === ',') {
      let nextIndex = index + 1
      while (/\s/.test(value[nextIndex] ?? '')) nextIndex += 1
      if (value[nextIndex] === '}' || value[nextIndex] === ']') continue
    }
    result += char
  }
  return result
}
