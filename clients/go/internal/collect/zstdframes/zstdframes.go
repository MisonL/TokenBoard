// Package zstdframes ports zstd-frames.ts: locating the byte ranges of every
// structurally complete Zstandard frame in a session log.
//
// DeepSeek Harness appends frames in batches, so the tail of a live log is
// routinely a half-written frame. Reading the headers rather than
// decompressing is what makes that torn trailing frame recoverable instead
// of fatal: a frame whose bytes are not all present is simply not returned,
// and the frames before it decode normally.
package zstdframes

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"github.com/klauspost/compress/zstd"
)

const (
	zstdMagic         = 0xfd2fb528
	skippableMagicMin = 0x184d2a50
	skippableMagicMax = 0x184d2a5f
)

// FrameRange is one frame's byte range within the log.
type FrameRange struct {
	Start int
	End   int
}

// IsZstdBuffer reports whether the buffer begins with a Zstandard frame or
// skippable-frame magic.
func IsZstdBuffer(buffer []byte) bool {
	if len(buffer) < 4 {
		return false
	}
	magic := binary.LittleEndian.Uint32(buffer)
	return magic == zstdMagic || (magic >= skippableMagicMin && magic <= skippableMagicMax)
}

// ScanFrames returns the byte ranges of every structurally complete frame, in
// file order. A truncated trailing frame is omitted rather than reported.
func ScanFrames(buffer []byte) ([]FrameRange, error) {
	var frames []FrameRange
	offset := 0

	for offset < len(buffer) {
		start := offset
		if len(buffer)-offset < 4 {
			return frames, nil
		}
		magic := binary.LittleEndian.Uint32(buffer[offset:])

		if magic >= skippableMagicMin && magic <= skippableMagicMax {
			// A skippable frame carries no compressed data; step over its
			// payload.
			if len(buffer)-offset < 8 {
				return frames, nil
			}
			size := int(binary.LittleEndian.Uint32(buffer[offset+4:]))
			end := offset + 8 + size
			if end > len(buffer) {
				return frames, nil
			}
			offset = end
			continue
		}

		if magic != zstdMagic {
			return nil, fmt.Errorf("Corrupt Zstandard session log: invalid frame magic at byte %d", offset)
		}
		offset += 4

		if offset == len(buffer) {
			return frames, nil
		}
		descriptor := buffer[offset]
		offset++
		// Bit 3 is reserved and must be zero. Bit 4 is currently unused, but
		// valid producers may leave it set, so that forward-compatible
		// header bit is not rejected.
		if descriptor&0x08 != 0 {
			return nil, fmt.Errorf("Corrupt Zstandard session log: reserved frame-header bit at byte %d", offset-1)
		}

		contentSizeFlag := descriptor >> 6
		singleSegment := descriptor&0x20 != 0
		hasChecksum := descriptor&0x04 != 0
		dictionaryFlag := descriptor & 0x03
		dictionaryBytes := int(dictionaryFlag)
		if dictionaryFlag == 3 {
			dictionaryBytes = 4
		}
		contentSizeBytes := 0
		if contentSizeFlag == 0 {
			if singleSegment {
				contentSizeBytes = 1
			}
		} else {
			contentSizeBytes = 1 << contentSizeFlag
		}
		remainingHeaderBytes := dictionaryBytes + contentSizeBytes
		if !singleSegment {
			remainingHeaderBytes++
		}
		if len(buffer)-offset < remainingHeaderBytes {
			return frames, nil
		}
		offset += remainingHeaderBytes

		for {
			if len(buffer)-offset < 3 {
				return frames, nil
			}
			blockHeader := uint32(buffer[offset]) | uint32(buffer[offset+1])<<8 | uint32(buffer[offset+2])<<16
			offset += 3
			lastBlock := blockHeader&1 != 0
			blockType := (blockHeader >> 1) & 0x03
			blockSize := int(blockHeader >> 3)
			if blockType == 0x03 {
				return nil, fmt.Errorf("Corrupt Zstandard session log: reserved block type at byte %d", offset-3)
			}
			// An RLE block stores one byte that expands to blockSize bytes.
			payloadBytes := blockSize
			if blockType == 0x01 {
				payloadBytes = 1
			}
			if len(buffer)-offset < payloadBytes {
				return frames, nil
			}
			offset += payloadBytes
			if lastBlock {
				break
			}
		}

		if hasChecksum {
			if len(buffer)-offset < 4 {
				return frames, nil
			}
			offset += 4
		}
		frames = append(frames, FrameRange{Start: start, End: offset})
	}

	return frames, nil
}

// ErrOutputTooLarge marks a frame whose decompressed size exceeds the budget,
// mirroring the TS ERR_BUFFER_TOO_LARGE classification so the caller can
// report "exceeds N bytes" rather than a raw decoder error.
var ErrOutputTooLarge = errors.New("decompressed output exceeds the budget")

// maxWindowBytes bounds the decoder's history window. It is deliberately
// generous — real session frames use the producer's default (well under 8 MiB)
// — but finite, so a hostile frame cannot claim a multi-gigabyte window and
// have the decoder allocate it. It is separate from the output budget, which
// is what actually caps a frame's decoded size.
const maxWindowBytes = 64 * 1024 * 1024

// DecompressFrame decodes one frame, refusing to produce more than maxOutput
// bytes. The budget is enforced on the output itself rather than through a
// decoder memory limit: WithDecoderMaxMemory caps the window, not the decoded
// size, so it would let an over-budget frame decode in full. Reading stops one
// byte past the budget — enough to prove the frame is too large without ever
// materializing the whole expansion — so a decompression bomb is rejected
// before it allocates past the budget.
func DecompressFrame(buffer []byte, frame FrameRange, maxOutput int) ([]byte, error) {
	if maxOutput < 1 {
		// The TS side clamps to 1 so an empty trailing frame stays decodable
		// when the running total lands exactly on the cap.
		maxOutput = 1
	}
	decoder, err := zstd.NewReader(bytes.NewReader(buffer[frame.Start:frame.End]),
		zstd.WithDecoderConcurrency(1),
		zstd.WithDecoderMaxMemory(maxWindowBytes),
	)
	if err != nil {
		return nil, err
	}
	defer decoder.Close()
	decoded, err := io.ReadAll(io.LimitReader(decoder, int64(maxOutput)+1))
	if err != nil {
		return nil, err
	}
	if len(decoded) > maxOutput {
		return nil, ErrOutputTooLarge
	}
	return decoded, nil
}
