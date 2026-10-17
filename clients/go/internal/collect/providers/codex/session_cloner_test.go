package codex

// Port of codex-session-cloner.test.ts. The TS suite drives a fake Ruby
// clonefile helper over pipes; the Go cloner has no helper subprocess, so the
// same observable contract is exercised through the injectable clone and copy
// primitives: which primitive runs, when the fallback diagnostic fires, and
// which errors are allowed to propagate.

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestCodexSessionClonerCopiesThroughOneCloneForMultipleFiles(t *testing.T) {
	root := t.TempDir()
	firstSource := filepath.Join(root, "first-source.jsonl")
	secondSource := filepath.Join(root, "second-source.jsonl")
	firstTarget := filepath.Join(root, "first-target.jsonl")
	secondTarget := filepath.Join(root, "second-target.jsonl")
	writeClonerFixture(t, firstSource, "first\n")
	writeClonerFixture(t, secondSource, "second\n")

	cloneCalls := 0
	cloner := CreateCodexSessionCloner(CodexSessionClonerOptions{
		CloneFile: func(source, target string) error {
			cloneCalls++
			return copyClonerFixture(source, target)
		},
	})
	if err := cloner.Copy(firstSource, firstTarget); err != nil {
		t.Fatal(err)
	}
	if err := cloner.Copy(secondSource, secondTarget); err != nil {
		t.Fatal(err)
	}
	if err := cloner.Close(); err != nil {
		t.Fatal(err)
	}

	if cloneCalls != 2 {
		t.Errorf("clone calls = %d, want 2", cloneCalls)
	}
	if got := readClonerFixture(t, firstTarget); got != "first\n" {
		t.Errorf("first target = %q", got)
	}
	if got := readClonerFixture(t, secondTarget); got != "second\n" {
		t.Errorf("second target = %q", got)
	}
}

func TestCodexSessionClonerFallsBackOnceToBoundedCopiesWhenTheCloneIsUnavailable(t *testing.T) {
	root := t.TempDir()
	firstSource := filepath.Join(root, "first-source.jsonl")
	secondSource := filepath.Join(root, "second-source.jsonl")
	firstTarget := filepath.Join(root, "first-target.jsonl")
	secondTarget := filepath.Join(root, "second-target.jsonl")
	writeClonerFixture(t, firstSource, "first\n")
	writeClonerFixture(t, secondSource, "second\n")

	cloneCalls := 0
	copyCalls := 0
	fallbackCalls := 0
	cloner := CreateCodexSessionCloner(CodexSessionClonerOptions{
		OnFallback: func() { fallbackCalls++ },
		CloneFile: func(_, _ string) error {
			cloneCalls++
			return syscall.ENOTSUP
		},
		CopyFile: func(source, target string) error {
			copyCalls++
			return copyClonerFixture(source, target)
		},
	})
	if err := cloner.Copy(firstSource, firstTarget); err != nil {
		t.Fatal(err)
	}
	if err := cloner.Copy(secondSource, secondTarget); err != nil {
		t.Fatal(err)
	}
	if err := cloner.Close(); err != nil {
		t.Fatal(err)
	}

	if fallbackCalls != 1 {
		t.Errorf("fallback calls = %d, want 1", fallbackCalls)
	}
	if cloneCalls != 1 {
		t.Errorf("clone calls = %d, want 1 (the cloner must latch into the copy path)", cloneCalls)
	}
	if copyCalls != 2 {
		t.Errorf("copy calls = %d, want 2", copyCalls)
	}
	if got := readClonerFixture(t, firstTarget); got != "first\n" {
		t.Errorf("first target = %q", got)
	}
	if got := readClonerFixture(t, secondTarget); got != "second\n" {
		t.Errorf("second target = %q", got)
	}
}

func TestCodexSessionClonerFallsBackWhenTheClonePrimitiveIsUnavailable(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source.jsonl")
	target := filepath.Join(root, "target.jsonl")
	writeClonerFixture(t, source, "source\n")

	fallbackCalls := 0
	cloner := CreateCodexSessionCloner(CodexSessionClonerOptions{
		OnFallback: func() { fallbackCalls++ },
		CloneFile:  func(_, _ string) error { return errCloneFileUnavailable },
		CopyFile:   copyClonerFixture,
	})
	if err := cloner.Copy(source, target); err != nil {
		t.Fatal(err)
	}
	if err := cloner.Close(); err != nil {
		t.Fatal(err)
	}

	if fallbackCalls != 1 {
		t.Errorf("fallback calls = %d, want 1", fallbackCalls)
	}
	if got := readClonerFixture(t, target); got != "source\n" {
		t.Errorf("target = %q", got)
	}
}

func TestCodexSessionClonerDoesNotSilentlyDowngradeAPermissionFailure(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source.jsonl")
	target := filepath.Join(root, "target.jsonl")
	writeClonerFixture(t, source, "source\n")

	fallbackCalls := 0
	copyCalls := 0
	cloner := CreateCodexSessionCloner(CodexSessionClonerOptions{
		OnFallback: func() { fallbackCalls++ },
		CloneFile: func(_, _ string) error {
			return &os.LinkError{Op: "link", Old: source, New: target, Err: syscall.EPERM}
		},
		CopyFile: func(_, _ string) error {
			copyCalls++
			return nil
		},
	})
	err := cloner.Copy(source, target)
	if err == nil {
		t.Fatal("expected the permission failure to propagate")
	}
	if !errors.Is(err, syscall.EPERM) {
		t.Errorf("error = %v, want EPERM", err)
	}
	if err := cloner.Close(); err != nil {
		t.Fatal(err)
	}
	if fallbackCalls != 0 {
		t.Errorf("fallback calls = %d, want 0", fallbackCalls)
	}
	if copyCalls != 0 {
		t.Errorf("copy calls = %d, want 0", copyCalls)
	}
}

func TestCodexSessionClonerRetriesTheCloneAfterACrossDeviceFailure(t *testing.T) {
	root := t.TempDir()
	firstSource := filepath.Join(root, "first-source.jsonl")
	secondSource := filepath.Join(root, "second-source.jsonl")
	firstTarget := filepath.Join(root, "first-target.jsonl")
	secondTarget := filepath.Join(root, "second-target.jsonl")
	writeClonerFixture(t, firstSource, "first\n")
	writeClonerFixture(t, secondSource, "second\n")

	cloneCalls := 0
	copyCalls := 0
	fallbackCalls := 0
	cloner := CreateCodexSessionCloner(CodexSessionClonerOptions{
		OnFallback: func() { fallbackCalls++ },
		CloneFile: func(source, target string) error {
			cloneCalls++
			if cloneCalls == 1 {
				return syscall.EXDEV
			}
			return copyClonerFixture(source, target)
		},
		CopyFile: func(source, target string) error {
			copyCalls++
			return copyClonerFixture(source, target)
		},
	})
	if err := cloner.Copy(firstSource, firstTarget); err != nil {
		t.Fatal(err)
	}
	if err := cloner.Copy(secondSource, secondTarget); err != nil {
		t.Fatal(err)
	}
	if err := cloner.Close(); err != nil {
		t.Fatal(err)
	}

	// EXDEV says nothing about the next pair, so the second copy still tries
	// the clone first.
	if cloneCalls != 2 {
		t.Errorf("clone calls = %d, want 2", cloneCalls)
	}
	if copyCalls != 1 {
		t.Errorf("copy calls = %d, want 1", copyCalls)
	}
	if fallbackCalls != 1 {
		t.Errorf("fallback calls = %d, want 1", fallbackCalls)
	}
}

func TestCodexSessionClonerDefaultCopyCreatesTheTargetExclusively(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source.jsonl")
	target := filepath.Join(root, "target.jsonl")
	writeClonerFixture(t, source, "source\n")

	cloner := CreateCodexSessionCloner(CodexSessionClonerOptions{CloneFile: func(_, _ string) error { return errCloneFileUnavailable }})
	if err := cloner.Copy(source, target); err != nil {
		t.Fatal(err)
	}
	if err := cloner.Copy(source, target); err == nil {
		t.Fatal("expected the second copy to fail on the existing target")
	} else if !errors.Is(err, os.ErrExist) {
		t.Errorf("error = %v, want a file-exists error", err)
	}
	if got := readClonerFixture(t, target); got != "source\n" {
		t.Errorf("target = %q", got)
	}
}

func TestCodexSessionClonerDefaultCopyLeavesAnIndependentFile(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source.jsonl")
	target := filepath.Join(root, "target.jsonl")
	writeClonerFixture(t, source, "first\n")

	cloner := CreateCodexSessionCloner(CodexSessionClonerOptions{CloneFile: func(_, _ string) error { return errCloneFileUnavailable }})
	if err := cloner.Copy(source, target); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("first\nsecond\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readClonerFixture(t, target); got != "first\n" {
		t.Errorf("target = %q, want the copied snapshot", got)
	}
}

func TestCodexSessionClonerCloseReleasesTheCloner(t *testing.T) {
	cloner := CreateCodexSessionCloner(CodexSessionClonerOptions{})
	if err := cloner.Close(); err != nil {
		t.Errorf("first close = %v", err)
	}
	if err := cloner.Close(); err != nil {
		t.Errorf("second close = %v", err)
	}
}

func TestCodexSessionCopyFallbackMessageMatchesTheTypeScriptConstant(t *testing.T) {
	const want = "Codex copy-on-write clone is unavailable; using a bounded standard file copy"
	if CodexSessionCopyFallbackMessage != want {
		t.Errorf("fallback message = %q, want %q", CodexSessionCopyFallbackMessage, want)
	}
}

func writeClonerFixture(t *testing.T, file, content string) {
	t.Helper()
	if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readClonerFixture(t *testing.T, file string) string {
	t.Helper()
	content, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

// copyClonerFixture is the injected copy: exclusive create plus the source
// bytes, the semantics the default copy has.
func copyClonerFixture(source, target string) error {
	content, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := file.Write(content); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}
