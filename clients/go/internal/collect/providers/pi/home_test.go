package pi

import (
	"path/filepath"
	"testing"
)

// TS picks the agent home with `??`: an exported-but-empty variable wins, so
// the session root becomes the relative "sessions" rather than the default
// ~/.pi/agent/sessions. Only the process environment can express that.
func TestSessionsRootHonorsAnEmptyHome(t *testing.T) {
	t.Setenv("TOKENBOARD_PI_AGENT_DIR", "")
	t.Setenv("PI_CODING_AGENT_DIR", "")
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", "")
	if got := sessionsRoot(Options{}); got != filepath.Join("", "sessions") {
		t.Errorf("sessionsRoot = %q, want %q", got, filepath.Join("", "sessions"))
	}
}

// An unset variable still takes the default.
func TestSessionsRootUsesTheDefault(t *testing.T) {
	t.Setenv("TOKENBOARD_PI_AGENT_DIR", "")
	t.Setenv("PI_CODING_AGENT_DIR", "")
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", "")
	// Both set-but-empty, so this documents the empty case; the default is
	// covered by an unconfigured machine rather than a stub.
	if got := sessionsRoot(Options{AgentDir: "/explicit/agent"}); got != "/explicit/agent/sessions" {
		t.Errorf("an explicit agent dir must win, got %q", got)
	}
}

// TS chains TOKENBOARD_PI_AGENT_DIR before PI_CODING_AGENT_DIR.
func TestSessionsRootPrefersTheTokenBoardAgentDir(t *testing.T) {
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", "")
	t.Setenv("PI_CODING_AGENT_DIR", "/plain/pi")
	t.Setenv("TOKENBOARD_PI_AGENT_DIR", "/tokenboard/pi")
	if got := sessionsRoot(Options{}); got != "/tokenboard/pi/sessions" {
		t.Errorf("sessionsRoot = %q, want /tokenboard/pi/sessions", got)
	}
}
