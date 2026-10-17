package antigravitygui

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// newLanguageServerStub serves the language-server endpoint over TLS, the way
// the real one does (self-signed certificate on loopback).
func newLanguageServerStub(t *testing.T, handler http.HandlerFunc) int {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	_, portText, err := splitHostPort(server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}
	return port
}

func splitHostPort(address string) (string, string, error) {
	index := strings.LastIndex(address, ":")
	if index < 0 {
		return "", "", &MetadataRequestError{Message: "no port in " + address}
	}
	return address[:index], address[index+1:], nil
}

func TestRequestGeneratorMetadataRejectsHTTPError(t *testing.T) {
	port := newLanguageServerStub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	_, err := RequestGeneratorMetadata(GeneratorMetadataRequest{Source: "antigravity", CascadeID: "c"}, port, "token")
	if err == nil {
		t.Fatal("expected the HTTP error to surface")
	}
	if want := "Antigravity metadata request failed for antigravity: HTTP 500"; !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %v, want it to name %q", err, want)
	}
}

func TestRequestGeneratorMetadataRejectsOversizedResponse(t *testing.T) {
	port := newLanguageServerStub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(maxMetadataResponseBytes+1))
		_, _ = io.CopyN(w, neverEndingReader{}, int64(maxMetadataResponseBytes)+1)
	})

	_, err := RequestGeneratorMetadata(GeneratorMetadataRequest{Source: "antigravity", CascadeID: "c"}, port, "token")
	if err == nil || !strings.Contains(err.Error(), "metadata response exceeded the") {
		t.Fatalf("err = %v, want the response-limit message", err)
	}
}

func TestRequestGeneratorMetadataRejectsInvalidJSON(t *testing.T) {
	port := newLanguageServerStub(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not json"))
	})

	_, err := RequestGeneratorMetadata(GeneratorMetadataRequest{Source: "antigravity", CascadeID: "c"}, port, "token")
	if err == nil || !strings.Contains(err.Error(), "invalid JSON") {
		t.Fatalf("err = %v, want the invalid-JSON message", err)
	}
}

func TestRequestGeneratorMetadataDecodesValidResponse(t *testing.T) {
	port := newLanguageServerStub(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"conversation":{"genMetadata":{"data":""}}}`))
	})

	decoded, err := RequestGeneratorMetadata(
		GeneratorMetadataRequest{Source: "antigravity", CascadeID: "c"}, port, "token")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if _, ok := decoded.(map[string]any); !ok {
		t.Fatalf("decoded = %T, want an object", decoded)
	}
}

func TestRequestGeneratorMetadataSendsCascadeIDAndCSRFToken(t *testing.T) {
	var gotPath, gotToken, gotBody string
	port := newLanguageServerStub(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotToken = r.Header.Get("X-Codeium-Csrf-Token")
		payload, _ := io.ReadAll(r.Body)
		gotBody = string(payload)
		_, _ = w.Write([]byte(`{}`))
	})

	if _, err := RequestGeneratorMetadata(
		GeneratorMetadataRequest{Source: "antigravity-ide", CascadeID: "cascade-7"}, port, "csrf-1"); err != nil {
		t.Fatalf("request: %v", err)
	}
	if !strings.HasSuffix(gotPath, "/GetCascadeTrajectoryGeneratorMetadata") {
		t.Fatalf("path = %q", gotPath)
	}
	if gotToken != "csrf-1" {
		t.Fatalf("csrf token = %q", gotToken)
	}
	if !strings.Contains(gotBody, `"cascadeId":"cascade-7"`) {
		t.Fatalf("body = %q", gotBody)
	}
}

func TestWaitForReadyReportsExitedProcess(t *testing.T) {
	command := exec.Command("false")
	process := &languageServerProcess{command: command, exited: make(chan struct{})}
	go func() {
		_ = command.Run()
		close(process.exited)
	}()

	err := process.waitForReady(54321, func(int) error { return io.EOF })
	if err == nil || !strings.Contains(err.Error(), "exited before it was ready") {
		t.Fatalf("err = %v, want the exit message", err)
	}
}

func TestWaitForReadyTimesOut(t *testing.T) {
	// A command that never exits and a probe that never succeeds: the deadline
	// must end the wait. The env override keeps the test fast.
	t.Setenv("TOKENBOARD_ANTIGRAVITY_READY_TIMEOUT_MS", "150")
	command := exec.Command("sleep", "5")
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = command.Process.Kill() })
	process := &languageServerProcess{command: command, exited: make(chan struct{})}
	go func() {
		process.waitErr = command.Wait()
		close(process.exited)
	}()

	err := process.waitForReady(54322, func(int) error { return io.EOF })
	if err == nil || !strings.Contains(err.Error(), "Timed out starting") {
		t.Fatalf("err = %v, want the timeout message", err)
	}
}

func TestWaitForReadySucceedsOnFirstProbe(t *testing.T) {
	process := &languageServerProcess{command: &exec.Cmd{}, exited: make(chan struct{})}
	if err := process.waitForReady(54323, func(int) error { return nil }); err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
}

// neverEndingReader yields zeros, so the oversized-response test does not have
// to materialise a 32MiB slice up front.
type neverEndingReader struct{}

func (neverEndingReader) Read(buffer []byte) (int, error) {
	for index := range buffer {
		buffer[index] = 'x'
	}
	return len(buffer), nil
}

func TestRequestGeneratorMetadataDoesNotFollowRedirects(t *testing.T) {
	// The TS request() rejects a non-200 status outright. Following a redirect
	// would carry the loopback CSRF token to whatever the server names.
	var redirected int
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		redirected++
		_, _ = w.Write([]byte(`{"generatorMetadata":[]}`))
	}))
	t.Cleanup(target.Close)
	port := newLanguageServerStub(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	})

	_, err := RequestGeneratorMetadata(GeneratorMetadataRequest{Source: "antigravity", CascadeID: "c"}, port, "token")
	if err == nil {
		t.Fatal("a redirect response must be rejected, not followed")
	}
	if redirected != 0 {
		t.Fatal("the request followed the redirect and sent the CSRF token to another server")
	}
}

func TestCloseGivesTheServerAGracefulShutdownFirst(t *testing.T) {
	// The TS closeLanguageServer sends SIGTERM and only escalates to SIGKILL
	// after two seconds, so the server can flush its own state. The child here
	// records whether it saw SIGTERM; an immediate SIGKILL leaves no marker.
	dir := t.TempDir()
	marker := filepath.Join(dir, "terminated")
	ready := filepath.Join(dir, "ready")
	// The ready marker closes the race between Start and the shell installing
	// its trap: SIGTERM before the trap exists would use the default action.
	command := exec.Command("sh", "-c",
		`trap 'touch "$1"; exit 0' TERM; touch "$2"; while true; do sleep 0.05; done`,
		"sh", marker, ready)
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the child never signalled readiness")
		}
		time.Sleep(10 * time.Millisecond)
	}
	process := &languageServerProcess{command: command, exited: make(chan struct{})}
	go func() {
		process.waitErr = command.Wait()
		close(process.exited)
	}()

	if err := process.close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	select {
	case <-process.exited:
	case <-time.After(5 * time.Second):
		t.Fatal("the process did not exit")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("the server was killed without a chance to handle SIGTERM")
	}
}
