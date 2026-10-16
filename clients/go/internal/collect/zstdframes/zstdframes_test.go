package zstdframes

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

// compress produces one frame. klauspost writes a content checksum by default,
// the same as DSH's writer, so the checksum path is covered by every case here.
func compress(t *testing.T, payload string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer, err := zstd.NewWriter(&buffer, zstd.WithEncoderConcurrency(1))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte(payload)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func concatenate(parts ...[]byte) []byte {
	var out []byte
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}

// The primitives only. How the frames are combined — the running total against
// the session budget, and the clamp when that budget is exhausted — lives in
// the deepseek-harness reader and is exercised there through real session
// files; re-deriving it here would test a copy that can drift from production.
//
// The TS suite has one further case with no Go analogue: "a Node build without
// zstd support throws the actionable per-source error". Go's zstd support is
// compiled in, so that failure mode does not exist here; the corresponding
// IsOptionalSourceUnavailable branch stays for wire-compatibility with a Node
// collector's error text.

func TestDecodesEveryFrameOfAConcatenatedStream(t *testing.T) {
	// klauspost's reader, like Node's, decodes only the first frame of a
	// concatenated stream, which is why frames are delimited here instead of
	// decompressed in one call. Each frame comes back as a byte range the
	// caller decompresses on its own.
	stream := concatenate(compress(t, "one\n"), compress(t, "two\n"), compress(t, "three\n"))
	frames, err := ScanFrames(stream)
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 3 {
		t.Fatalf("frames = %d, want 3", len(frames))
	}
	for index, want := range []string{"one\n", "two\n", "three\n"} {
		decoded, err := DecompressFrame(stream, frames[index], 4096)
		if err != nil {
			t.Fatal(err)
		}
		if string(decoded) != want {
			t.Errorf("frame %d = %q, want %q", index, decoded, want)
		}
	}
}

func TestDecodesFramesWrittenWithAContentChecksum(t *testing.T) {
	stream := concatenate(compress(t, "a\n"), compress(t, "b\n"))
	frames, err := ScanFrames(stream)
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 2 {
		t.Fatalf("frames = %d, want 2", len(frames))
	}
	for index, want := range []string{"a\n", "b\n"} {
		decoded, err := DecompressFrame(stream, frames[index], 4096)
		if err != nil {
			t.Fatal(err)
		}
		if string(decoded) != want {
			t.Errorf("frame %d = %q, want %q", index, decoded, want)
		}
	}
}

// The caller passes each frame the budget it has left. An over-limit frame is
// classified as ErrOutputTooLarge, which the reader turns into "this session
// log exceeds the cap" instead of a raw decoder error.
func TestEnforcesAPerFrameDecompressedOutputLimit(t *testing.T) {
	stream := compress(t, "0123456789")
	frame := mustFrame(t, stream)

	if _, err := DecompressFrame(stream, frame, 5); !errors.Is(err, ErrOutputTooLarge) {
		t.Errorf("budget 5 err = %v, want ErrOutputTooLarge", err)
	}
	decoded, err := DecompressFrame(stream, frame, 10)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded) != "0123456789" {
		t.Errorf("decoded = %q, want %q", decoded, "0123456789")
	}
}

// A valid producer may set the unused header bit, so the scanner must accept
// it and the frame must stay decodable.
func TestAcceptsTheUnusedFrameHeaderBit(t *testing.T) {
	stream := compress(t, "unused-bit\n")
	stream[4] |= 0x10

	frames, err := ScanFrames(stream)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecompressFrame(stream, frames[0], 1024)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded) != "unused-bit\n" {
		t.Errorf("decoded = %q, want %q", decoded, "unused-bit\n")
	}
}

func TestRejectsTheReservedFrameHeaderBit(t *testing.T) {
	stream := compress(t, "reserved-bit\n")
	stream[4] |= 0x08

	if _, err := ScanFrames(stream); err == nil || !strings.Contains(err.Error(), "reserved frame-header bit") {
		t.Errorf("err = %v, want 'reserved frame-header bit'", err)
	}
}

func TestKeepsCompleteFramesWhenTheLastOneIsTornMidAppend(t *testing.T) {
	complete := concatenate(compress(t, "a\n"), compress(t, "b\n"))
	tail := compress(t, "c\n")
	torn := concatenate(complete, tail[:len(tail)-4])

	frames, err := ScanFrames(torn)
	if err != nil {
		t.Fatal(err)
	}
	intact, err := ScanFrames(complete)
	if err != nil {
		t.Fatal(err)
	}
	// The torn bytes carry no complete frame, so they are not ranges at all.
	if len(frames) != len(intact) {
		t.Fatalf("frames = %d, want %d", len(frames), len(intact))
	}
	for index, want := range []string{"a\n", "b\n"} {
		decoded, err := DecompressFrame(torn, frames[index], 1024)
		if err != nil {
			t.Fatal(err)
		}
		if string(decoded) != want {
			t.Errorf("frame %d = %q, want %q", index, decoded, want)
		}
	}
}

func TestRoundTripsAPayloadLargeEnoughToSpanSeveralBlocks(t *testing.T) {
	var text strings.Builder
	for index := 0; index < 20_000; index++ {
		fmt.Fprintf(&text, `{"n":%d}`+"\n", index)
	}
	stream := concatenate(compress(t, text.String()), compress(t, "tail\n"))
	frames, err := ScanFrames(stream)
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 2 {
		t.Fatalf("frames = %d, want 2", len(frames))
	}
	large, err := DecompressFrame(stream, frames[0], 4*1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	if string(large) != text.String() {
		t.Errorf("large frame = %d bytes, want %d", len(large), text.Len())
	}
	tail, err := DecompressFrame(stream, frames[1], 4*1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	if string(tail) != "tail\n" {
		t.Errorf("tail = %q, want %q", tail, "tail\n")
	}
}

func TestStepsOverASkippableFrame(t *testing.T) {
	skippable := make([]byte, 12)
	binary.LittleEndian.PutUint32(skippable, 0x184d2a50)
	binary.LittleEndian.PutUint32(skippable[4:], 4)
	stream := concatenate(skippable, compress(t, "after\n"))

	frames, err := ScanFrames(stream)
	if err != nil {
		t.Fatal(err)
	}
	// The skippable frame is not reported, and the real frame's range starts
	// after it rather than at the start of the stream.
	if len(frames) != 1 {
		t.Fatalf("frames = %d, want 1", len(frames))
	}
	if frames[0].Start != len(skippable) {
		t.Errorf("start = %d, want %d", frames[0].Start, len(skippable))
	}
	decoded, err := DecompressFrame(stream, frames[0], 1024)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded) != "after\n" {
		t.Errorf("decoded = %q, want %q", decoded, "after\n")
	}
}

func TestRejectsAStreamWhoseFrameMagicIsWrong(t *testing.T) {
	stream := concatenate(compress(t, "a\n"), []byte("plain text tail!!"))

	if _, err := ScanFrames(stream); err == nil || !strings.Contains(err.Error(), "invalid frame magic") {
		t.Errorf("err = %v, want 'invalid frame magic'", err)
	}
}

func TestTreatsAnEmptyOrTruncatedHeaderAsNoFrames(t *testing.T) {
	empty, err := ScanFrames(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(empty) != 0 {
		t.Errorf("empty: frames = %d, want 0", len(empty))
	}
	truncated := compress(t, "a\n")[:3]
	frames, err := ScanFrames(truncated)
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 0 {
		t.Errorf("truncated header: frames = %d, want 0", len(frames))
	}
}

func TestRecognizesAZstandardBuffer(t *testing.T) {
	if !IsZstdBuffer(compress(t, "a\n")) {
		t.Error("compressed buffer: IsZstdBuffer = false, want true")
	}
	if IsZstdBuffer([]byte(`{"type":"session"}`)) {
		t.Error("plain JSON: IsZstdBuffer = true, want false")
	}
	if IsZstdBuffer([]byte{0, 1}) {
		t.Error("two bytes: IsZstdBuffer = true, want false")
	}
}

func mustFrame(t *testing.T, stream []byte) FrameRange {
	t.Helper()
	frames, err := ScanFrames(stream)
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 1 {
		t.Fatalf("frames = %d, want 1", len(frames))
	}
	return frames[0]
}

// The encoder compresses a long run of one byte into an RLE block, which
// stores a single byte that expands to the block's declared size. The scanner
// has to step over exactly one byte for such a block, not over the expanded
// length; getting that wrong would misplace every following frame's header.
func TestRoundTripsFramesContainingRLEBlocks(t *testing.T) {
	payload := strings.Repeat("A", 5000)
	stream := compress(t, payload)

	if kinds := blockTypes(t, stream, mustFrame(t, stream)); !slices.Contains(kinds, 1) {
		t.Fatalf("encoder produced no RLE block (types %v); this test no longer covers the branch", kinds)
	}
	decoded, err := DecompressFrame(stream, mustFrame(t, stream), len(payload)+1)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded) != payload {
		t.Errorf("decoded %d bytes, want %d identical bytes", len(decoded), len(payload))
	}

	// A second frame after the RLE one proves the scan resumed at the right
	// offset rather than inside the run.
	stream = concatenate(stream, compress(t, "tail\n"))
	frames, err := ScanFrames(stream)
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 2 {
		t.Fatalf("frames = %d, want 2", len(frames))
	}
	tail, err := DecompressFrame(stream, frames[1], 1024)
	if err != nil {
		t.Fatal(err)
	}
	if string(tail) != "tail\n" {
		t.Errorf("tail = %q, want %q", tail, "tail\n")
	}
}

func TestRejectsAReservedBlockType(t *testing.T) {
	stream := compress(t, "a\n")
	frame := mustFrame(t, stream)
	offset := firstBlockHeaderOffset(t, stream, frame)
	// Block type lives in bits 1-2 of the first byte of the little-endian
	// 24-bit block header; 0b11 is reserved and no producer may emit it.
	stream[offset] = (stream[offset] &^ 0x06) | 0x06

	if _, err := ScanFrames(stream); err == nil || !strings.Contains(err.Error(), "reserved block type") {
		t.Errorf("err = %v, want 'reserved block type'", err)
	}
}

// A skippable frame whose declared payload runs past the end of the buffer is
// truncated, like any other partial frame: the frames before it still count.
func TestStopsAtATruncatedSkippableFrame(t *testing.T) {
	skippable := make([]byte, 8)
	binary.LittleEndian.PutUint32(skippable, 0x184d2a50)
	binary.LittleEndian.PutUint32(skippable[4:], 1000) // claims 1000 bytes, has none
	stream := concatenate(compress(t, "a\n"), skippable)

	frames, err := ScanFrames(stream)
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 1 {
		t.Fatalf("frames = %d, want 1", len(frames))
	}
	decoded, err := DecompressFrame(stream, frames[0], 1024)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded) != "a\n" {
		t.Errorf("decoded = %q, want %q", decoded, "a\n")
	}
}

// blockTypes reports the block type of each block in a frame, so a test can
// assert the encoder really produced the block kind it claims to cover.
func blockTypes(t *testing.T, stream []byte, frame FrameRange) []int {
	t.Helper()
	offset := firstBlockHeaderOffset(t, stream, frame)
	var kinds []int
	for {
		if offset+3 > frame.End {
			t.Fatalf("block header at %d runs past the frame end %d", offset, frame.End)
		}
		header := uint32(stream[offset]) | uint32(stream[offset+1])<<8 | uint32(stream[offset+2])<<16
		offset += 3
		kind := int((header >> 1) & 0x03)
		size := int(header >> 3)
		kinds = append(kinds, kind)
		payload := size
		if kind == 1 {
			payload = 1
		}
		offset += payload
		if header&1 != 0 {
			return kinds
		}
	}
}

// firstBlockHeaderOffset walks a frame header to where its first block's
// 3-byte header starts.
func firstBlockHeaderOffset(t *testing.T, stream []byte, frame FrameRange) int {
	t.Helper()
	offset := frame.Start + 4 // frame magic
	if offset >= frame.End {
		t.Fatal("frame has no header descriptor")
	}
	descriptor := stream[offset]
	offset++
	contentSizeFlag := descriptor >> 6
	singleSegment := descriptor&0x20 != 0
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
	offset += dictionaryBytes + contentSizeBytes
	if !singleSegment {
		offset++ // window descriptor
	}
	return offset
}
