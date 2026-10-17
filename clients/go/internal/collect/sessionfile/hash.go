package sessionfile

import (
	"crypto/sha256"
	"fmt"
	"hash"
	"io"
	"os"
)

// FingerprintFile hashes a session file (or its first endOffset bytes) with
// the current content algorithm. It returns the digest and, when endOffset is
// nil, the size it observed.
//
// The scan always fingerprints with the current algorithm; only a *recorded*
// algorithm dispatches (see FingerprintWithAlgorithm), where an absent field
// means the legacy sha256.
func FingerprintFile(filePath string, endOffset *int64) (string, int64, error) {
	return FingerprintWithAlgorithm(filePath, endOffset, ContentHashAlgorithm)
}

// FingerprintWithAlgorithm hashes a file with the algorithm a cursor entry
// records. An empty algorithm means the current one; a recorded sha256 names
// the legacy digest. An unknown algorithm is an error: guessing would compare
// two digests that were never meant to be equal and silently drop the entry.
func FingerprintWithAlgorithm(filePath string, endOffset *int64, algorithm string) (string, int64, error) {
	hasher, err := contentHasherFor(algorithm)
	if err != nil {
		return "", 0, err
	}
	file, err := os.Open(filePath)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", 0, err
	}
	size := info.Size()
	limit := size
	if endOffset != nil {
		limit = *endOffset
		if limit > size {
			return "", 0, fmt.Errorf("Session file changed while hashing: %s", filePath)
		}
	}
	buffer := make([]byte, HashBufferBytes)
	position := int64(0)
	for position < limit {
		length := int64(len(buffer))
		if remaining := limit - position; remaining < length {
			length = remaining
		}
		read, err := file.ReadAt(buffer[:length], position)
		if read > 0 {
			hasher.Write(buffer[:read])
			position += int64(read)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", 0, err
		}
	}
	if position != limit {
		return "", 0, fmt.Errorf("Session file changed while hashing: %s", filePath)
	}
	return fmt.Sprintf("%x", hasher.Sum(nil)), size, nil
}

// contentHasherFor mirrors the TS createSessionContentHasherFor: the current
// algorithm (or an absent field, which means the legacy sha256) dispatches by
// name, and anything else fails closed.
func contentHasherFor(algorithm string) (hash.Hash, error) {
	if algorithm == "" {
		algorithm = LegacyContentHashAlgorithm
	}
	switch algorithm {
	case ContentHashAlgorithm:
		return newBlake2b512(), nil
	case LegacyContentHashAlgorithm:
		return sha256.New(), nil
	}
	return nil, fmt.Errorf("Unsupported session content hash algorithm: %s", algorithm)
}

// NewContentHasherFor exposes the algorithm dispatch to callers that stream a
// file themselves (the Codex legacy-cursor migration verifies the file
// identity around its own read loop).
func NewContentHasherFor(algorithm string) (hash.Hash, error) {
	return contentHasherFor(algorithm)
}

// FingerprintFileAndPrefix hashes the whole file and its first
// prefixEndOffset bytes in one pass, which is the append-only fast path's
// check: an unchanged prefix means the new bytes are an append.
func FingerprintFileAndPrefix(filePath string, prefixEndOffset, endOffset int64) (string, string, error) {
	if prefixEndOffset < 0 || prefixEndOffset > endOffset {
		return "", "", fmt.Errorf("Invalid session hash range: %s", filePath)
	}
	file, err := os.Open(filePath)
	if err != nil {
		return "", "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", "", err
	}
	if info.Size() < endOffset {
		return "", "", fmt.Errorf("Session file changed while hashing: %s", filePath)
	}
	prefixHasher := newContentHasher()
	fullHasher := newContentHasher()
	buffer := make([]byte, HashBufferBytes)
	position := int64(0)
	for position < endOffset {
		length := int64(len(buffer))
		if remaining := endOffset - position; remaining < length {
			length = remaining
		}
		read, err := file.ReadAt(buffer[:length], position)
		if read > 0 {
			prefixLength := int64(0)
			if remaining := prefixEndOffset - position; remaining > 0 {
				prefixLength = remaining
				if int64(read) < prefixLength {
					prefixLength = int64(read)
				}
			}
			if prefixLength > 0 {
				prefixHasher.Write(buffer[:prefixLength])
			}
			fullHasher.Write(buffer[:read])
			position += int64(read)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", "", err
		}
	}
	if position != endOffset {
		return "", "", fmt.Errorf("Session file changed while hashing: %s", filePath)
	}
	return fmt.Sprintf("%x", prefixHasher.Sum(nil)), fmt.Sprintf("%x", fullHasher.Sum(nil)), nil
}

// FileEndsWithNewline reports whether the last byte of the file is CR or LF.
// The caller has already statted the file, so an empty size is answered
// without opening it.
func FileEndsWithNewline(filePath string, size int64) (bool, error) {
	if size == 0 {
		return false, nil
	}
	file, err := os.Open(filePath)
	if err != nil {
		return false, err
	}
	defer file.Close()
	buffer := make([]byte, 1)
	read, err := file.ReadAt(buffer, size-1)
	if err != nil && err != io.EOF {
		return false, err
	}
	if read != 1 {
		return false, fmt.Errorf("Could not read the final byte of session file: %s", filePath)
	}
	return buffer[0] == '\n' || buffer[0] == '\r', nil
}

// FileIdentity exposes the platform device/inode pair for a fingerprint.
func FileIdentity(info os.FileInfo) (uint64, uint64, bool) {
	return fileIdentity(info)
}
