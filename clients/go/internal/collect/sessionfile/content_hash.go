package sessionfile

import (
	"crypto/sha256"
	"hash"

	"golang.org/x/crypto/blake2b"
)

// ContentHashAlgorithm is the algorithm recorded in each cursor entry's
// contentHashAlgo field. The TS collector moved from sha256 to blake2b512
// (1.35x faster on hosts without SHA-NI); an entry without the field predates
// it and holds a sha256 digest.
const ContentHashAlgorithm = "blake2b512"

// LegacyContentHashAlgorithm is the digest algorithm of entries written before
// contentHashAlgo existed.
const LegacyContentHashAlgorithm = "sha256"

// newBlake2b512 builds the content hasher. blake2b.New512 only fails for an
// out-of-range size, which this constant cannot produce.
func newBlake2b512() hash.Hash {
	hasher, err := blake2b.New512(nil)
	if err != nil {
		return sha256.New()
	}
	return hasher
}

// IsCurrentContentHashAlgorithm reports whether a recorded algorithm is the
// current one. A legacy entry cannot take the append-only fast path: its
// prefix digest was made with sha256, so it is re-read once and upgraded.
func IsCurrentContentHashAlgorithm(algorithm string) bool {
	if algorithm == "" {
		algorithm = LegacyContentHashAlgorithm
	}
	return algorithm == ContentHashAlgorithm
}
