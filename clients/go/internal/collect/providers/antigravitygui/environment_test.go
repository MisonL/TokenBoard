package antigravitygui

import (
	"errors"
	"testing"
)

func TestIsUnavailableDbError(t *testing.T) {
	unavailable := []error{
		errors.New("Antigravity SQLite reader unavailable: sqlite3 not found"),
		errors.New("Antigravity conversations directory not found: /tmp/x"),
	}
	for _, err := range unavailable {
		if !IsUnavailableDBError(err) {
			t.Fatalf("%v should classify as unavailable", err)
		}
	}
	if IsUnavailableDBError(errors.New("Antigravity SQLite metadata query failed")) {
		t.Fatal("a real SQLite failure must not classify as unavailable")
	}
	if IsUnavailableDBError(nil) {
		t.Fatal("nil is not an unavailable error")
	}
}

func TestIsUnavailableLanguageServerErrorMatchesTheTsPatterns(t *testing.T) {
	unavailable := []error{
		errors.New("Antigravity language server exited before it was ready"),
		errors.New("Timed out starting Antigravity language server on port 1234"),
		errors.New("Antigravity metadata request failed for antigravity: HTTP 500"),
		errors.New("Antigravity metadata request transport failed for antigravity: EOF"),
		errors.New("Antigravity metadata request timed out for antigravity"),
		// The spawn failure the TS regex matches: a language-server binary that
		// is not installed here.
		errors.New("spawn /missing/tokenboard-antigravity-language-server ENOENT"),
	}
	for _, err := range unavailable {
		if !IsUnavailableLanguageServerError(err) {
			t.Fatalf("%v should classify as unavailable", err)
		}
	}
	if IsUnavailableLanguageServerError(errors.New("metadata unavailable")) {
		t.Fatal("an unrecognized failure must not classify as unavailable")
	}
	if IsUnavailableLanguageServerError(nil) {
		t.Fatal("nil is not an unavailable error")
	}
}

func TestSpawnFailureNamesAMissingLanguageServer(t *testing.T) {
	// The Go exec error for a missing binary reads "fork/exec …: no such file
	// or directory", which matches no TS pattern; the collector has to render
	// it in the shape the classifier (and the TS log contract) expects.
	_, err := CreateLanguageServerClient(
		Options{Source: "antigravity"}, "/missing/tokenboard-antigravity-language-server", "", 0)
	if err == nil {
		t.Fatal("expected the missing binary to fail the spawn")
	}
	if !IsUnavailableLanguageServerError(err) {
		t.Fatalf("err = %v, want a missing language server to classify as unavailable", err)
	}
}
