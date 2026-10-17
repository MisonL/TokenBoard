package antigravitymeta

import (
	"regexp"
	"strings"
)

// IsUnavailableLanguageServerError reports the language-server failures that
// only mean "the server is not here": the patterns the TS
// isUnavailableLanguageServerError matches. It lives here rather than in a
// provider package so the CLI's availability classifier can share it without
// an import cycle.
func IsUnavailableLanguageServerError(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "Antigravity language server exited before it was ready") ||
		strings.Contains(message, "Timed out starting Antigravity language server") ||
		strings.HasPrefix(message, "Antigravity metadata request failed for ") ||
		strings.HasPrefix(message, "Antigravity metadata request transport failed for ") ||
		strings.HasPrefix(message, "Antigravity metadata request timed out for ") ||
		SpawnENOENTPattern.MatchString(message)
}

// SpawnENOENTPattern is the TS /^spawn .*(Antigravity.*language_server|tokenboard-antigravity-language-server) ENOENT/:
// a language-server binary that is not installed at the path the client tried.
var SpawnENOENTPattern = regexp.MustCompile(
	`^spawn .*(Antigravity.*language_server|tokenboard-antigravity-language-server) ENOENT`)
