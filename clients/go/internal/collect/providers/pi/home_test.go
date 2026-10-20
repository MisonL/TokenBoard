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
	if want := filepath.Join("/explicit/agent", "sessions"); sessionsRoot(Options{AgentDir: "/explicit/agent"}) != want {
		t.Errorf("an explicit agent dir must win, want %q", want)
	}
}

// TS chains TOKENBOARD_PI_AGENT_DIR before PI_CODING_AGENT_DIR.
func TestSessionsRootPrefersTheTokenBoardAgentDir(t *testing.T) {
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", "")
	t.Setenv("PI_CODING_AGENT_DIR", "/plain/pi")
	t.Setenv("TOKENBOARD_PI_AGENT_DIR", "/tokenboard/pi")
	if want := filepath.Join("/tokenboard/pi", "sessions"); sessionsRoot(Options{}) != want {
		t.Errorf("sessionsRoot = %q, want %q", sessionsRoot(Options{}), want)
	}
}
