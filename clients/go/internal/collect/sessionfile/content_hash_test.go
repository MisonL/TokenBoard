package sessionfile

import (
	"encoding/hex"
	"regexp"
	"testing"
)

// Mirrors session-content-hash.test.ts: the recorded algorithm name and the
// digest shape are cursor-contract values, so these pin both.

func sessionContentDigestHex(t *testing.T, content string) string {
	t.Helper()
	hasher := newContentHasher()
	if _, err := hasher.Write([]byte(content)); err != nil {
		t.Fatalf("hash write: %v", err)
	}
	return hex.EncodeToString(hasher.Sum(nil))
}

func TestSessionContentHashStableDigest(t *testing.T) {
	first := sessionContentDigestHex(t, "session bytes")
	second := sessionContentDigestHex(t, "session bytes")

	if first != second {
		t.Fatalf("digests differ: %q vs %q", first, second)
	}
	if !regexp.MustCompile(`^[a-f0-9]{128}$`).MatchString(first) {
		t.Fatalf("digest %q is not 128 lowercase hex characters", first)
	}
}

func TestSessionContentHashDistinguishesDifferentContent(t *testing.T) {
	left := sessionContentDigestHex(t, "first")
	right := sessionContentDigestHex(t, "second")
	if left == right {
		t.Fatalf("different content produced the same digest %q", left)
	}
}

func TestSessionContentHashCannotCollideWithLegacyShape(t *testing.T) {
	digest := sessionContentDigestHex(t, "session bytes")

	// Legacy entries store 64 hex characters. Recording the algorithm
	// alongside the digest is what keeps the two apart; this guards the shape
	// that assumption rests on.
	if len(digest) != 128 {
		t.Fatalf("digest length = %d, want 128", len(digest))
	}
	if len(digest) == 64 {
		t.Fatal("digest has the legacy sha256 shape")
	}
}

func TestIsCurrentContentHashAlgorithmTreatsMissingAlgorithmAsLegacy(t *testing.T) {
	if IsCurrentContentHashAlgorithm("") {
		t.Fatal(`IsCurrentContentHashAlgorithm("") = true, want false (an entry without a recorded algorithm is legacy)`)
	}
	if IsCurrentContentHashAlgorithm(LegacyContentHashAlgorithm) {
		t.Fatalf("IsCurrentContentHashAlgorithm(%q) = true, want false", LegacyContentHashAlgorithm)
	}
}

func TestIsCurrentContentHashAlgorithmAcceptsCurrentAlgorithm(t *testing.T) {
	if !IsCurrentContentHashAlgorithm(ContentHashAlgorithm) {
		t.Fatalf("IsCurrentContentHashAlgorithm(%q) = false, want true", ContentHashAlgorithm)
	}
}

func TestIsCurrentContentHashAlgorithmTreatsUnknownAlgorithmAsNotCurrent(t *testing.T) {
	// An entry written by a newer collector with an algorithm this build does
	// not know must not be compared against a digest this build produces.
	if IsCurrentContentHashAlgorithm("sha3-256") {
		t.Fatal(`IsCurrentContentHashAlgorithm("sha3-256") = true, want false`)
	}
	if IsCurrentContentHashAlgorithm("") {
		t.Fatal(`IsCurrentContentHashAlgorithm("") = true, want false`)
	}
}
