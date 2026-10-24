package sessioncursor

import (
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Every expectation below is the exact output of the TS cursorFileName with
// the same inputs (hashes printed by Node's createHash('sha256')).
func TestFileNameMatchesTS(t *testing.T) {
	cases := []struct {
		source contract.Source
		scope  string
		want   string
	}{
		{"antigravity", "https://tokenboard.example", "antigravity-cursor.server-786d4864ea226bf44d1349b90d756186568dc1a15b89b24fd6fbcc51d8ad18ad.json"},
		{"codex", "/Users/x/.codex", "codex-cursor.profile-3b125282c29110fef38f8d4e90dcb93ce31d03a59405debf8b6ff08cfe960e70.json"},
		{"claude-code", "https://tb.example:8443", "claude-code-cursor.server-39fad724a099907c07644f45be979639721957a0026579a84d2190d8f339f93c.json"},
		{"pi", "", "pi-cursor.json"},
		{"claude-code", "", "claude-code-cursor.json"},
		{"deepseek-harness", "", "deepseek-harness-cursor.json"},
	}
	for _, tc := range cases {
		if got := FileName(tc.source, tc.scope); got != tc.want {
			t.Errorf("FileName(%q, %q) = %q, want %q", tc.source, tc.scope, got, tc.want)
		}
	}
}
