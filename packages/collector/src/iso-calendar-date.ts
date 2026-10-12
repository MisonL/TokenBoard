const isoCalendarDatePattern = /^(\d{4})-(\d{2})-(\d{2})/

export function isAllDateFilter(value: string | undefined) {
  return typeof value === 'string' && value.trim() === 'all'
}

export function assertValidDateFilter(value: string, field: string, allowAll = false) {
  const trimmed = value.trim()
  if (allowAll && trimmed === 'all') return trimmed
  if (!/^\d{8}$/.test(trimmed) && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`Invalid ${field}: ${value}. Expected YYYYMMDD or YYYY-MM-DD.`)
  }
  const compact = trimmed.replaceAll('-', '')
  const year = Number(compact.slice(0, 4))
  const month = Number(compact.slice(4, 6))
  const day = Number(compact.slice(6, 8))
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid ${field}: ${value}. Expected YYYYMMDD or YYYY-MM-DD.`)
  }
  return trimmed
}

export function assertValidDateFilterRange(input: {
  since?: string
  until?: string
  sinceField: string
  untilField: string
}) {
  const normalizedSince = input.since?.trim()
  const since =
    input.since && normalizedSince !== 'all' ? assertValidDateFilter(input.since, input.sinceField, true) : undefined
  const until = input.until ? assertValidDateFilter(input.until, input.untilField) : undefined

  if (since && until && since.replaceAll('-', '') > until.replaceAll('-', '')) {
    throw new Error(`Invalid ${input.sinceField}/${input.untilField}: since date must not be after until date.`)
  }

  return { since, until }
}

export function assertValidIsoCalendarDate(value: string, message: string) {
  const match = isoCalendarDatePattern.exec(value)
  if (!match) return

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(message)
  }
}
