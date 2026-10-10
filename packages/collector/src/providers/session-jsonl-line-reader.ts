import { createReadStream } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { TextDecoder } from 'node:util'
import type { UsageSource } from '@tokenboard/usage-core'
import { createSessionContentHasher } from './session-content-hash'
import {
  createSessionJsonlMetadataScanner,
  finishSessionJsonlMetadataScan,
  hasRelevantSessionJsonlMetadata,
  readSessionJsonlRecordType,
  scanSessionJsonlMetadata,
  type SessionJsonlMetadataScanner
} from './session-jsonl-metadata-scanner'

export type SkippedOversizedSessionJsonlLine = {
  kind: 'skipped-oversized-non-usage'
  byteLength: number
}

export type SessionJsonlLine = string | SkippedOversizedSessionJsonlLine

type ReadSessionJsonlLinesInput = {
  filePath: string
  startOffsetBytes: number
  endOffsetBytes?: number
  maxLineBytes: number
  maxDiscardedLineBytes?: number
  codexUsageOnly?: boolean
  source?: UsageSource
  expectedFingerprint?: SessionJsonlFileFingerprint
}

export type SessionJsonlFileFingerprint = {
  dev: number
  ino: number
  sha256: string
  size: number
}

type LineState = {
  chunks: Buffer[]
  byteLength: number
  skipping: boolean
  metadataScanner: SessionJsonlMetadataScanner
}

export const maxDiscardedSessionJsonlLineBytes = 64 * 1024 * 1024

// Record types that never carry a root-level `usage`, so an oversized row of one of these can be
// dropped instead of failing the whole source. Every entry here is a claim that the type is not a
// metric row; a type left out is treated as potentially billable and its oversized row is fatal.
//
// `attachment` and `result` are the two that were missing. Claude Code writes `attachment` rows
// for hook output, tool listings and queued prompts, and a queued command can embed base64 images:
// one 1.1 MB `attachment` row stopped every claude-code hook sync for a week, while four larger
// `user` rows in the same file passed untouched because `user` was listed. `result` rows hold a
// subagent result key, also without usage.
//
// Listing a type here is what fixes the production path: an oversized row whose type is absent
// from this set is fatal in `finishLine`, whatever its content. The `root-attachment` scope added
// to session-jsonl-metadata-scanner.ts is defence in depth for callers that read without a source
// (where `hasRelevantSessionJsonlMetadata` cannot gate on `source === 'claude-code'`) and would
// otherwise see `attachment.usage`'s `totalTokens` as evidence that the row is metric-bearing.
// The parser never reads that subtree — usage comes only from `record.message.usage` or
// `record.usage` — so the task summary inside it is safe to ignore in both paths.
const discardableSessionRecordTypes = new Set([
  'assistant',
  'attachment',
  'compacted',
  'event_msg',
  'file-history-snapshot',
  'progress',
  'queue-operation',
  'response_item',
  'result',
  'session_meta',
  'summary',
  'task_complete',
  'task_started',
  'turn_context',
  'user'
])

export async function* readSessionJsonlLines(input: ReadSessionJsonlLinesInput): AsyncIterable<SessionJsonlLine> {
  const codexUsageOnly = input.codexUsageOnly ?? input.source === 'codex'
  const verifiedFile = input.expectedFingerprint
    ? await openVerifiedSessionJsonlFile(input.filePath, input.expectedFingerprint)
    : undefined
  const expectedEndOffsetBytes = input.expectedFingerprint ? input.expectedFingerprint.size : input.endOffsetBytes
  if (input.expectedFingerprint && input.endOffsetBytes !== input.expectedFingerprint.size) {
    await verifiedFile?.close()
    throw new Error(`Invalid verified session JSONL range: ${input.filePath}`)
  }

  try {
    const contentHash = verifiedFile
      ? await hashSessionJsonlPrefix(verifiedFile, input.startOffsetBytes, input.filePath)
      : undefined
    if (expectedEndOffsetBytes !== undefined && expectedEndOffsetBytes <= input.startOffsetBytes) {
      assertVerifiedSessionJsonlContent({
        bytesRead: input.startOffsetBytes,
        expected: input.expectedFingerprint,
        hash: contentHash,
        filePath: input.filePath
      })
      return
    }
    const stream = createSessionJsonlReadStream(input.filePath, verifiedFile, {
      ...(input.startOffsetBytes > 0 ? { start: input.startOffsetBytes } : {}),
      ...(expectedEndOffsetBytes === undefined ? {} : { end: expectedEndOffsetBytes - 1 })
    })
    const maxDiscardedLineBytes = input.maxDiscardedLineBytes ?? maxDiscardedSessionJsonlLineBytes
    let line = emptyLineState(codexUsageOnly)
    let skipLeadingLineFeed = await startsAfterCarriageReturn({
      fileHandle: verifiedFile,
      filePath: input.filePath,
      startOffsetBytes: input.startOffsetBytes
    })
    let bytesRead = input.startOffsetBytes
    let completed = false

    try {
      for await (const chunk of stream) {
        contentHash?.update(chunk)
        bytesRead += chunk.length
        let offset = 0
        if (skipLeadingLineFeed) {
          if (chunk.length === 0) continue
          if (chunk[0] === 0x0a) offset = 1
          skipLeadingLineFeed = false
        }
        while (offset < chunk.length) {
          const terminator = findLineTerminator(chunk, offset)
          const end = terminator === -1 ? chunk.length : terminator
          appendLineSegment(chunk.subarray(offset, end), line, {
            maxLineBytes: input.maxLineBytes,
            maxDiscardedLineBytes,
            source: input.source
          })
          if (terminator === -1) break
          yield finishLine(line, input.source)
          line = emptyLineState(codexUsageOnly)
          const terminatorByte = chunk[terminator]
          offset = terminator + 1
          if (terminatorByte === 0x0d) {
            if (offset < chunk.length && chunk[offset] === 0x0a) {
              offset += 1
            } else if (offset === chunk.length) {
              skipLeadingLineFeed = true
            }
          }
        }
      }
      if (line.byteLength > 0) yield finishLine(line, input.source)
      completed = true
    } finally {
      stream.destroy()
      if (completed && input.expectedFingerprint) {
        assertVerifiedSessionJsonlContent({
          bytesRead,
          expected: input.expectedFingerprint,
          hash: contentHash,
          filePath: input.filePath
        })
      }
    }
  } finally {
    await verifiedFile?.close()
  }
}

function createSessionJsonlReadStream(
  filePath: string,
  fileHandle: FileHandle | undefined,
  options: { start?: number; end?: number }
) {
  if (!fileHandle) return createReadStream(filePath, options)
  return fileHandle.createReadStream({ ...options, autoClose: false })
}

async function startsAfterCarriageReturn(input: {
  fileHandle: FileHandle | undefined
  filePath: string
  startOffsetBytes: number
}) {
  if (input.startOffsetBytes === 0) return false
  if (input.fileHandle) {
    const buffer = Buffer.allocUnsafe(1)
    const { bytesRead } = await input.fileHandle.read(buffer, 0, 1, input.startOffsetBytes - 1)
    if (bytesRead !== 1) throw new Error(`Session file changed before reading: ${input.filePath}`)
    return buffer[0] === 0x0d
  }
  for await (const chunk of createReadStream(input.filePath, {
    start: input.startOffsetBytes - 1,
    end: input.startOffsetBytes - 1
  })) {
    return chunk[0] === 0x0d
  }
  throw new Error(`Could not read the byte before the session file range: ${input.filePath}`)
}

async function openVerifiedSessionJsonlFile(filePath: string, expected: SessionJsonlFileFingerprint) {
  const pathStat = await lstat(filePath).catch((error) => {
    throw new Error(`Session file changed before reading: ${filePath}`, { cause: error })
  })
  if (!matchesSessionJsonlIdentity(pathStat, expected) || pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new Error(`Session file changed before reading: ${filePath}`)
  }

  const fileHandle = await open(filePath, 'r').catch((error) => {
    throw new Error(`Session file changed before reading: ${filePath}`, { cause: error })
  })
  try {
    const [handleStat, currentPathStat] = await Promise.all([fileHandle.stat(), lstat(filePath).catch(() => null)])
    if (
      !matchesSessionJsonlIdentity(handleStat, expected) ||
      !matchesSessionJsonlIdentity(currentPathStat, expected) ||
      currentPathStat?.isSymbolicLink() ||
      !currentPathStat?.isFile()
    ) {
      throw new Error(`Session file changed before reading: ${filePath}`)
    }
    return fileHandle
  } catch (error) {
    await fileHandle.close()
    throw error
  }
}

// Prefix verification re-hashes from byte 0, so its throughput decides how long a
// hook sync takes on large session files. A 64 KiB buffer spent most of that time
// in per-chunk overhead rather than in SHA-256 itself: measured on a 1.2 GB codex
// session, 64 KiB reached 0.10 GB/s while 4 MiB reached 0.25 GB/s. The buffer is
// still clamped to the range being verified so tiny files do not allocate 4 MiB.
export const sessionJsonlHashBufferBytes = 4 * 1024 * 1024

async function hashSessionJsonlPrefix(fileHandle: FileHandle, endOffsetBytes: number, filePath: string) {
  const hash = createSessionContentHasher()
  const buffer = Buffer.allocUnsafe(Math.min(sessionJsonlHashBufferBytes, Math.max(1, endOffsetBytes)))
  let position = 0
  while (position < endOffsetBytes) {
    const length = Math.min(buffer.length, endOffsetBytes - position)
    const { bytesRead } = await fileHandle.read(buffer, 0, length, position)
    if (bytesRead !== length) {
      throw new Error(`Session file changed while reading: ${filePath}`)
    }
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return hash
}

function assertVerifiedSessionJsonlContent(input: {
  bytesRead: number
  expected: SessionJsonlFileFingerprint | undefined
  filePath: string
  hash: ReturnType<typeof createSessionContentHasher> | undefined
}) {
  if (
    input.expected &&
    (input.bytesRead !== input.expected.size || input.hash?.digest('hex') !== input.expected.sha256)
  ) {
    throw new Error(`Session file changed while reading: ${input.filePath}`)
  }
}

function matchesSessionJsonlIdentity(
  stat: { dev: number; ino: number; mtimeMs: number; size: number } | null,
  expected: SessionJsonlFileFingerprint
) {
  return stat !== null && stat.dev === expected.dev && stat.ino === expected.ino && stat.size >= expected.size
}

export function isSkippedOversizedSessionJsonlLine(line: SessionJsonlLine): line is SkippedOversizedSessionJsonlLine {
  return typeof line !== 'string'
}

function emptyLineState(codexUsageOnly = false): LineState {
  return {
    chunks: [],
    byteLength: 0,
    skipping: false,
    metadataScanner: createSessionJsonlMetadataScanner({
      codexUsageOnly,
      additionalRelevantKeys: codexUsageOnly ? ['total_token_usage', 'last_token_usage'] : undefined
    })
  }
}

function appendLineSegment(
  segment: Buffer,
  line: LineState,
  limits: {
    maxLineBytes: number
    maxDiscardedLineBytes: number
    source?: UsageSource
  }
) {
  if (segment.length === 0) return
  const nextByteLength = line.byteLength + segment.length
  if (!line.skipping && nextByteLength <= limits.maxLineBytes) {
    line.chunks.push(segment)
    line.byteLength = nextByteLength
    return
  }

  scanSessionJsonlMetadata(line.skipping ? [segment] : [...line.chunks, segment], line.metadataScanner, limits.source)
  if (line.metadataScanner.invalid) {
    throw new Error('Session JSONL contains a malformed oversized line')
  }
  if (hasRelevantSessionJsonlMetadata(line.metadataScanner, limits.source)) {
    throw new Error('Session JSONL contains an oversized line with token or usage metadata')
  }
  line.byteLength = nextByteLength
  if (!line.skipping) {
    line.chunks = []
    line.skipping = true
  }
  if (line.byteLength > limits.maxDiscardedLineBytes) {
    throw new Error(
      `Session JSONL contains a non-usage line exceeding the ${limits.maxDiscardedLineBytes}-byte discard limit`
    )
  }
}

function isDiscardableSessionRecordType(scanner: SessionJsonlMetadataScanner) {
  const type = readSessionJsonlRecordType(scanner)
  return type !== undefined && discardableSessionRecordTypes.has(type)
}

function findLineTerminator(chunk: Buffer, offset: number) {
  const carriageReturn = chunk.indexOf(0x0d, offset)
  const lineFeed = chunk.indexOf(0x0a, offset)
  if (carriageReturn === -1) return lineFeed
  if (lineFeed === -1) return carriageReturn
  return Math.min(carriageReturn, lineFeed)
}

function finishLine(line: LineState, source?: UsageSource): SessionJsonlLine {
  if (line.skipping) {
    if (!finishSessionJsonlMetadataScan(line.metadataScanner)) {
      throw new Error('Session JSONL contains a malformed oversized line')
    }
    if (hasRelevantSessionJsonlMetadata(line.metadataScanner, source)) {
      throw new Error('Session JSONL contains an oversized line with token or usage metadata')
    }
    if (!isDiscardableSessionRecordType(line.metadataScanner)) {
      throw new Error('Session JSONL contains an oversized line with an unknown record type')
    }
    return { kind: 'skipped-oversized-non-usage', byteLength: line.byteLength }
  }
  const value = Buffer.concat(line.chunks, line.byteLength)
  const withoutCarriageReturn = value.length > 0 && value[value.length - 1] === 0x0d ? value.subarray(0, -1) : value
  return decodeSessionJsonlLine(withoutCarriageReturn)
}

function decodeSessionJsonlLine(value: Buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    throw new Error('Session JSONL contains invalid UTF-8')
  }
}
