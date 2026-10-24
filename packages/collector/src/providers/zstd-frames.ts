import * as zlib from 'node:zlib'

const zstdMagic = 0xfd2fb528
const skippableMagicMin = 0x184d2a50
const skippableMagicMax = 0x184d2a5f

// A named import would make a trimmed third-party Node build (no zstd support) crash the
// whole CLI at module-load time with an unhelpful SyntaxError. The namespace import yields
// `undefined` instead, so the failure is confined to the DSH source at call time with an
// actionable message; cli.ts already classifies that source as unavailable-and-skipped.
export function decompressZstdFrame(
  buffer: Buffer,
  frame: ZstdFrameRange,
  options?: { maxOutputLength?: number }
): Buffer {
  if (typeof currentZstdDecompressSync() !== 'function') {
    throw new Error(
      'This Node.js build lacks zstd support; DeepSeek Harness .zstd sessions need an official Node >= 22.15 build'
    )
  }
  return currentZstdDecompressSync()(buffer.subarray(frame.start, frame.end), options)
}

// Mutable seam for tests: an ESM namespace object cannot be reassigned, so a trimmed Node
// build is simulated by pointing this at undefined.
let zstdDecompressOverride: typeof zlib.zstdDecompressSync | undefined | null = null

export function setZstdDecompressOverride(value: typeof zlib.zstdDecompressSync | undefined | null) {
  zstdDecompressOverride = value
}

function currentZstdDecompressSync(): typeof zlib.zstdDecompressSync {
  return zstdDecompressOverride === null ? zlib.zstdDecompressSync : zstdDecompressOverride!
}

export type ZstdFrameRange = { start: number; end: number }

/**
 * Byte ranges of every structurally complete frame, in file order.
 *
 * Reading the headers rather than decompressing is what makes a partially
 * written trailing frame recoverable instead of fatal.
 */
export function scanZstdFrames(buffer: Buffer): ZstdFrameRange[] {
  const frames: ZstdFrameRange[] = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    const magic = buffer.readUInt32LE(offset)

    if (magic >= skippableMagicMin && magic <= skippableMagicMax) {
      // A skippable frame carries no compressed data; step over its payload.
      if (buffer.length - offset < 8) return frames
      const size = buffer.readUInt32LE(offset + 4)
      const end = offset + 8 + size
      if (end > buffer.length) return frames
      offset = end
      continue
    }

    if (magic !== zstdMagic) {
      throw new Error(`Corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4

    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    // Bit 3 is reserved and must be zero. Bit 4 is currently unused, but
    // valid producers may leave it set, so do not reject that forward-
    // compatible header bit.
    if ((descriptor & 0x08) !== 0) {
      throw new Error(`Corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const hasChecksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return frames
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`Corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      // An RLE block stores one byte that expands to `blockSize` bytes.
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }

    if (hasChecksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }

  return frames
}

export function isZstdBuffer(buffer: Buffer) {
  if (buffer.length < 4) return false
  const magic = buffer.readUInt32LE(0)
  return magic === zstdMagic || (magic >= skippableMagicMin && magic <= skippableMagicMax)
}
