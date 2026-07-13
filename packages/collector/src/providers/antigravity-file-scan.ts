import { createHash } from 'node:crypto'

export const maxAntigravityDirectoryEntries = 10_000

export type AntigravityDirectoryEntry = {
  name: string
  isFile: () => boolean
}

export type AntigravityFileScanEntry = {
  mtimeMs: number
  size: number
  hasDatabaseFile: boolean
  checkedSequence: number
}

export type AntigravityFileScanState = {
  nextSequence: number
  files: Record<string, AntigravityFileScanEntry>
}

export async function listAntigravityDirectoryFileNames(
  entries: AsyncIterable<AntigravityDirectoryEntry>
) {
  const names: string[] = []
  let entriesRead = 0
  for await (const entry of entries) {
    entriesRead += 1
    if (entriesRead > maxAntigravityDirectoryEntries) {
      throw new Error(
        `Antigravity conversations directory exceeds the ${maxAntigravityDirectoryEntries}-entry scan limit`
      )
    }
    if (entry.isFile()) names.push(entry.name)
  }
  return names
}

export function beginAntigravityFileScan(state: AntigravityFileScanState) {
  if (!Number.isSafeInteger(state.nextSequence) || state.nextSequence < 0 ||
      state.nextSequence === Number.MAX_SAFE_INTEGER) {
    throw new Error('Invalid Antigravity file scan sequence')
  }
  const sequence = state.nextSequence
  state.nextSequence += 1
  return sequence
}

export function selectAntigravityFileScanIds(
  ids: string[],
  state: AntigravityFileScanState,
  limit: number
) {
  if (limit === Number.POSITIVE_INFINITY) return [...ids]
  const unseen = ids.filter((id) => !state.files[antigravityFileScanKey(id)])
  const selected = selectFromBothEnds(unseen, limit)
  if (selected.length === limit) return selected
  const selectedIds = new Set(selected)
  const known = ids
    .filter((id) => !selectedIds.has(id) && state.files[antigravityFileScanKey(id)])
    .sort((left, right) => {
      const leftEntry = state.files[antigravityFileScanKey(left)]
      const rightEntry = state.files[antigravityFileScanKey(right)]
      return leftEntry.checkedSequence - rightEntry.checkedSequence || left.localeCompare(right)
    })
  return [...selected, ...known.slice(0, limit - selected.length)]
}

export function markAntigravityFileScanned(
  state: AntigravityFileScanState,
  id: string,
  entry: Omit<AntigravityFileScanEntry, 'checkedSequence'>,
  checkedSequence: number
) {
  state.files[antigravityFileScanKey(id)] = { ...entry, checkedSequence }
}

export function readAntigravityFileScanEntry(state: AntigravityFileScanState, id: string) {
  return state.files[antigravityFileScanKey(id)]
}

export function removeAntigravityFileScanEntry(state: AntigravityFileScanState, id: string) {
  delete state.files[antigravityFileScanKey(id)]
}

export function pruneAntigravityFileScanState(state: AntigravityFileScanState, ids: Iterable<string>) {
  const retained = new Set(Array.from(ids, antigravityFileScanKey))
  for (const key of Object.keys(state.files)) {
    if (!retained.has(key)) delete state.files[key]
  }
}

export function isValidAntigravityFileScanState(value: unknown): value is AntigravityFileScanState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as AntigravityFileScanState
  return Number.isSafeInteger(candidate.nextSequence) && candidate.nextSequence >= 0 &&
    Boolean(candidate.files) && typeof candidate.files === 'object' && !Array.isArray(candidate.files) &&
    Object.entries(candidate.files).every(([key, entry]) => /^[a-f0-9]{64}$/.test(key) && isValidEntry(entry))
}

function selectFromBothEnds(ids: string[], limit: number) {
  const selected: string[] = []
  let left = 0
  let right = ids.length - 1
  while (selected.length < limit && left <= right) {
    selected.push(ids[left])
    left += 1
    if (selected.length < limit && left <= right) {
      selected.push(ids[right])
      right -= 1
    }
  }
  return selected
}

function antigravityFileScanKey(id: string) {
  return createHash('sha256').update(id).digest('hex')
}

function isValidEntry(value: unknown): value is AntigravityFileScanEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as AntigravityFileScanEntry
  return Number.isFinite(entry.mtimeMs) && entry.mtimeMs >= 0 &&
    Number.isFinite(entry.size) && entry.size >= 0 &&
    typeof entry.hasDatabaseFile === 'boolean' &&
    Number.isSafeInteger(entry.checkedSequence) && entry.checkedSequence >= 0
}
