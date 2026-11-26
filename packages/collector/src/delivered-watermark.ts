import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { renameAtomic } from './rename-atomic'

// Persists the last usage date each source actually delivered, so an automatic
// since can cover an outage longer than the default seven-day window (up to
// thirty days; see effectiveSince). Without it, a machine that stops syncing
// for more than a week silently loses the older tail of its history when the
// next run picks up the plain default window.
//
// The file is shared byte-for-byte in shape with the Go client
// (clients/go/internal/watermark/watermark.go):
// `{"schemaVersion": ..., "sources": {<source>: {usageDate, endpoint,
// tokenHash, updatedAt}}}`. Entries are scoped by endpoint and token
// fingerprint rather than by a device id: neither client knows its device id
// locally, and a re-paired install gets a new upload token, which is exactly
// the "do not inherit the old watermark" condition.
export const deliveredWatermarkFileName = 'delivered-watermark.json'
export const deliveredWatermarkSchemaVersion = 'tokenboard-delivered-watermark/v1'

const maxLookbackDays = 30
const defaultWindowDays = 7
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

export type DeliveredWatermarkEntry = {
  usageDate: string
  endpoint?: string
  tokenHash?: string
  updatedAt?: string
}

type WatermarkFile = {
  schemaVersion?: string
  sources?: Record<string, DeliveredWatermarkEntry>
}

// Derives the install identity stored in the watermark. It never leaves this
// machine: only the truncated hash is persisted. The first eight bytes match
// the Go client's TokenFingerprint.
export function tokenFingerprint(token: string): string {
  if (!token) return ''
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

function watermarkPath(stateDir: string) {
  return join(stateDir, deliveredWatermarkFileName)
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !isoDatePattern.test(value)) return false
  // Round-trip through a real date so 2026-02-30 is rejected, matching the Go
  // client's time.Parse.
  return formatIsoDate(parseIsoDate(value)) === value
}

function parseIsoDate(value: string): Date {
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  return date
}

function formatIsoDate(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDays(date: string, days: number): string {
  const parsed = parseIsoDate(date)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return formatIsoDate(parsed)
}

function isoDateInTimeZone(now: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
  const values: Record<string, string> = {}
  for (const part of formatter.formatToParts(now)) {
    if (part.type !== 'literal') values[part.type] = part.value
  }
  return `${values.year}-${values.month}-${values.day}`
}

// A missing, unreadable, corrupt or wrong-version file yields no entries: the
// watermark is an optimisation, and an unreadable one must behave exactly like
// a fresh install.
export async function loadDeliveredWatermark(stateDir: string): Promise<Record<string, DeliveredWatermarkEntry>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(watermarkPath(stateDir), 'utf8'))
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const file = parsed as WatermarkFile
  if (file.schemaVersion !== deliveredWatermarkSchemaVersion) return {}
  const entries: Record<string, DeliveredWatermarkEntry> = {}
  if (typeof file.sources !== 'object' || file.sources === null) return entries
  for (const [source, entry] of Object.entries(file.sources)) {
    if (typeof entry !== 'object' || entry === null) continue
    if (!isIsoDate(entry.usageDate)) continue
    entries[source] = entry
  }
  return entries
}

// Returns the automatic since for the given sources, or undefined when no
// source has a usable watermark and the caller should keep its default. The
// effective date per source is max(today-30, min(today-7, watermark-1)): a
// watermark a week or more old widens the window, an older one is clamped to
// thirty days, and a recent one keeps the existing seven-day floor. The
// earliest effective date across the sources wins, so no source can be skipped.
export async function effectiveSince(input: {
  stateDir: string
  sources: readonly string[]
  endpoint: string
  tokenHash: string
  now: Date
  timeZone: string
}): Promise<string | undefined> {
  if (!input.tokenHash) return undefined
  const entries = await loadDeliveredWatermark(input.stateDir)
  const today = isoDateInTimeZone(input.now, input.timeZone)
  const floor = addDays(today, -defaultWindowDays)
  const ceiling = addDays(today, -maxLookbackDays)
  let earliest: string | undefined
  for (const source of input.sources) {
    const entry = entries[source]
    if (!entry || entry.endpoint !== input.endpoint || entry.tokenHash !== input.tokenHash) continue
    // A future date means the clock moved backwards; treat it as absent
    // rather than trusting a window that starts in the future.
    if (entry.usageDate > today) continue
    const candidate = addDays(entry.usageDate, -1)
    const effective = candidate < ceiling ? ceiling : candidate > floor ? floor : candidate
    if (earliest === undefined || effective < earliest) earliest = effective
  }
  return earliest
}

// Advances the watermark for each source/date pair. It never moves a
// watermark backwards, ignores dates it cannot parse, and clamps a candidate
// to today (a clock that jumped ahead must not record a future watermark).
// Other sources and other installs' entries are preserved; a corrupt file is
// simply replaced by the repaired structure.
export async function recordDeliveredWatermark(input: {
  stateDir: string
  endpoint: string
  tokenHash: string
  advances: Record<string, string>
  now: Date
  timeZone: string
}): Promise<void> {
  if (!input.tokenHash) return
  if (Object.keys(input.advances).length === 0) return
  const today = isoDateInTimeZone(input.now, input.timeZone)
  const existing = await loadDeliveredWatermark(input.stateDir)
  const sources: Record<string, DeliveredWatermarkEntry> = { ...existing }
  let changed = false
  for (const [source, rawDate] of Object.entries(input.advances)) {
    if (!isIsoDate(rawDate)) continue
    const date = rawDate > today ? today : rawDate
    const current = sources[source]
    if (
      current &&
      current.endpoint === input.endpoint &&
      current.tokenHash === input.tokenHash &&
      current.usageDate >= date
    ) {
      continue
    }
    sources[source] = {
      usageDate: date,
      endpoint: input.endpoint,
      tokenHash: input.tokenHash,
      updatedAt: input.now.toISOString()
    }
    changed = true
  }
  if (!changed) return

  await mkdir(input.stateDir, { recursive: true, mode: 0o700 })
  const destination = watermarkPath(input.stateDir)
  const temp = `${destination}.tmp-ts-${process.pid}`
  await writeFile(temp, `${JSON.stringify({ schemaVersion: deliveredWatermarkSchemaVersion, sources }, null, 2)}\n`, {
    mode: 0o600
  })
  try {
    await renameAtomic(temp, destination)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}
