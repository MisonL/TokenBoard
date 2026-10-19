package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/release"
)

// buildTarball assembles a release tarball holding one executable.
func buildTarball(t *testing.T, name string, body []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	archive := tar.NewWriter(writer)
	if err := archive.WriteHeader(&tar.Header{
		Name:     name,
		Mode:     0o755,
		Size:     int64(len(body)),
		Typeflag: tar.TypeReg,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := archive.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// stubBinary is a script that answers `version` the way the real binary does.
// It stands in for the executable because a test cannot ship a compiled
// binary for the host it runs on.
func stubBinary(version string) []byte {
	return []byte("#!/bin/sh\nif [ \"$1\" = version ]; then echo \"tokenboard (go) " + version + "\"; exit 0; fi\nexit 0\n")
}

type fakeRelease struct {
	tag      string
	platform string
	tarball  []byte
	// omitChecksums publishes a release with no checksums asset.
	omitChecksums bool
	// badChecksum publishes a manifest that does not match the tarball.
	badChecksum bool
}

// server serves the two web endpoints an update uses: the releases-latest
// redirect and the release asset downloads.
func (f fakeRelease) server(t *testing.T) *httptest.Server {
	t.Helper()
	archiveName := release.ArchiveName(f.platform)
	digest := sha256.Sum256(f.tarball)
	sums := fmt.Sprintf("%s  %s\n", hex.EncodeToString(digest[:]), archiveName)
	if f.badChecksum {
		sums = fmt.Sprintf("%s  %s\n", strings.Repeat("0", 64), archiveName)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/MisonL/TokenBoard/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/MisonL/TokenBoard/releases/tag/"+f.tag, http.StatusFound)
	})
	mux.HandleFunc("/MisonL/TokenBoard/releases/tag/"+f.tag, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("<html>release " + f.tag + "</html>"))
	})
	mux.HandleFunc("/MisonL/TokenBoard/releases/download/"+f.tag+"/"+archiveName,
		func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write(f.tarball)
		})
	mux.HandleFunc("/MisonL/TokenBoard/releases/download/"+f.tag+"/"+release.ChecksumsName(),
		func(w http.ResponseWriter, r *http.Request) {
			if f.omitChecksums {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write([]byte(sums))
		})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

// A successful update replaces the binary and keeps the old one beside it.
func TestRunReplacesTheBinaryAndKeepsABackup(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	if err := os.WriteFile(target, stubBinary("0.0.1"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("0.0.1")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	body := stubBinary("1.2.3")
	fake := fakeRelease{tag: "v1.2.3", platform: "darwin_arm64", tarball: buildTarball(t, "tokenboard", body)}
	server := fake.server(t)

	result, err := runAgainst(t, server, target, "")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !result.Updated || result.Version != "1.2.3" {
		t.Fatalf("result = %+v, want updated 1.2.3", result)
	}
	installed, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(installed, body) {
		t.Errorf("installed binary is not the downloaded one")
	}
	if _, err := os.Stat(result.BackupPath); err != nil {
		t.Errorf("backup missing at %s: %v", result.BackupPath, err)
	}
	previous, err := os.ReadFile(result.BackupPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(previous, []byte("0.0.1")) {
		t.Errorf("backup does not hold the previous binary: %q", previous)
	}
	// The staged copy must not survive a successful swap.
	if _, err := os.Stat(filepath.Join(dir, "tokenboard.new")); !os.IsNotExist(err) {
		t.Errorf("staged file left behind: %v", err)
	}
}

func runAgainst(t *testing.T, server *httptest.Server, target, tag string) (Result, error) {
	t.Helper()
	return Run(Input{
		Repo:       "MisonL/TokenBoard",
		Tag:        tag,
		Target:     target,
		Platform:   "darwin",
		Arch:       "arm64",
		HTTPClient: server.Client(),
		Env: func(key string) string {
			if key == "TOKENBOARD_RELEASE_BASE_URL" {
				return server.URL
			}
			return ""
		},
		Stderr: func(string) {},
	})
}

// A release already installed is a no-op, so the scheduled path stays quiet.
func TestRunIsANoopWhenTheVersionMatches(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	if err := os.WriteFile(target, stubBinary("1.2.3"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("1.2.3")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	fake := fakeRelease{tag: "v1.2.3", platform: "darwin_arm64", tarball: buildTarball(t, "tokenboard", stubBinary("1.2.3"))}
	server := fake.server(t)

	result, err := runAgainst(t, server, target, "")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Updated {
		t.Errorf("updated = true, want a no-op")
	}
	if result.BackupPath != "" {
		t.Errorf("backup = %q, want none", result.BackupPath)
	}
}

// A checksum mismatch must refuse the install and leave the original binary
// in place — a wrong binary breaks the collector that would otherwise fix it.
func TestRunRefusesAChecksumMismatchAndKeepsTheOriginal(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	original := stubBinary("0.0.1")
	if err := os.WriteFile(target, original, 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("0.0.1")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	fake := fakeRelease{
		tag: "v1.2.3", platform: "darwin_arm64",
		tarball:     buildTarball(t, "tokenboard", stubBinary("1.2.3")),
		badChecksum: true,
	}
	server := fake.server(t)

	if _, err := runAgainst(t, server, target, ""); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("err = %v, want a checksum mismatch", err)
	}
	installed, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(installed, original) {
		t.Errorf("the original binary was replaced despite the mismatch")
	}
	if _, err := os.Stat(filepath.Join(dir, "tokenboard.new")); !os.IsNotExist(err) {
		t.Errorf("staged file left behind after a refusal: %v", err)
	}
}

// A release without a checksums manifest cannot be verified, so it is not
// installed even though the download itself would succeed.
func TestRunRefusesAReleaseWithoutChecksums(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	if err := os.WriteFile(target, stubBinary("0.0.1"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("0.0.1")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	fake := fakeRelease{
		tag: "v1.2.3", platform: "darwin_arm64",
		tarball:       buildTarball(t, "tokenboard", stubBinary("1.2.3")),
		omitChecksums: true,
	}
	server := fake.server(t)

	if _, err := runAgainst(t, server, target, ""); err == nil || !strings.Contains(err.Error(), "checksums.txt") {
		t.Fatalf("err = %v, want a missing checksums manifest", err)
	}
}

// A downloaded binary that cannot answer `version` is not installed: swapping
// it in would leave a machine whose collector never runs again.
func TestRunRefusesABinaryThatDoesNotRun(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	if err := os.WriteFile(target, stubBinary("0.0.1"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("0.0.1")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	// The tarball carries a binary that answers nothing.
	fake := fakeRelease{
		tag: "v1.2.3", platform: "darwin_arm64",
		tarball: buildTarball(t, "tokenboard", []byte("#!/bin/sh\nexit 1\n")),
	}
	server := fake.server(t)

	if _, err := runAgainst(t, server, target, ""); err == nil || !strings.Contains(err.Error(), "does not run") {
		t.Fatalf("err = %v, want a verification failure", err)
	}
	installed, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(installed, []byte("0.0.1")) {
		t.Errorf("the original binary was replaced by one that cannot run")
	}
}

// An unsupported platform is refused before any network call.
func TestRunRefusesAnUnsupportedPlatform(t *testing.T) {
	if _, err := Run(Input{Platform: "plan9", Arch: "mips"}); err == nil ||
		!strings.Contains(err.Error(), "no release for plan9/mips") {
		t.Fatalf("err = %v, want an unsupported-platform refusal", err)
	}
}

// A malformed repository is refused rather than resolved into a URL that 404s.
func TestRunRefusesAMalformedRepo(t *testing.T) {
	if _, err := Run(Input{Repo: "not-a-repo", Platform: "darwin", Arch: "arm64"}); err == nil ||
		!strings.Contains(err.Error(), "expected owner/repo") {
		t.Fatalf("err = %v, want a malformed repo refusal", err)
	}
}

// A tag pinned explicitly skips the latest-release lookup entirely: the
// download URL is built from the tag, so no redirect request is made.
func TestRunPinsAnExplicitTag(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	if err := os.WriteFile(target, stubBinary("0.0.1"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("0.0.1")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	fake := fakeRelease{tag: "v9.9.9", platform: "darwin_arm64", tarball: buildTarball(t, "tokenboard", stubBinary("9.9.9"))}
	server := fake.server(t)

	result, err := runAgainst(t, server, target, "v9.9.9")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Version != "9.9.9" || !result.Updated {
		t.Fatalf("result = %+v, want an update to 9.9.9", result)
	}
}

// The version comparison must match a whole token: "1.2.30" is not "1.2.3",
// and accepting it would install a binary whose version does not match the
// release the checksums came from.
func TestNamesVersionRequiresAWholeToken(t *testing.T) {
	cases := []struct {
		output  string
		version string
		want    bool
	}{
		{"tokenboard (go) 1.2.3", "1.2.3", true},
		{"tokenboard (go) 1.2.30", "1.2.3", false},
		{"tokenboard (go) 11.2.3", "1.2.3", false},
		{"tokenboard (go) 1.2.3.4", "1.2.3", false},
		{"tokenboard (go) v1.2.3", "1.2.3", true},
		{"1.2.3", "1.2.3", true},
		{"tokenboard (go) 1.2.4", "1.2.3", false},
		{"no version here", "1.2.3", false},
	}
	for _, testCase := range cases {
		if got := namesVersion(testCase.output, testCase.version); got != testCase.want {
			t.Errorf("namesVersion(%q, %q) = %v, want %v", testCase.output, testCase.version, got, testCase.want)
		}
	}
}

// Each backup is a full copy of the binary; a machine that updates on every
// scheduled sync would accumulate one per release forever. Only the newest is
// kept.
func TestRunPrunesOldBackupsKeepingTheNewest(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	if err := os.WriteFile(target, stubBinary("0.0.1"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Two backups from earlier updates, and an unrelated file that must not be
	// touched.
	if err := os.WriteFile(target+".backup-20260101T000000Z", []byte("older"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target+".backup-20260102T000000Z", []byte("previous"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target+".unrelated", []byte("keep me"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("0.0.1")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	fake := fakeRelease{tag: "v1.2.3", platform: "darwin_arm64", tarball: buildTarball(t, "tokenboard", stubBinary("1.2.3"))}
	server := fake.server(t)

	result, err := runAgainst(t, server, target, "")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if _, err := os.Stat(result.BackupPath); err != nil {
		t.Errorf("this update's backup missing: %v", err)
	}
	if _, err := os.Stat(target + ".backup-20260101T000000Z"); !os.IsNotExist(err) {
		t.Errorf("the older backup survived: %v", err)
	}
	if _, err := os.Stat(target + ".backup-20260102T000000Z"); !os.IsNotExist(err) {
		t.Errorf("the previous backup survived: %v", err)
	}
	if data, readErr := os.ReadFile(target + ".unrelated"); readErr != nil || string(data) != "keep me" {
		t.Errorf("unrelated file disturbed: %v", readErr)
	}
}

// The glob pattern is escaped, so a binary living in a directory whose name
// carries glob metacharacters prunes its own backups, not another binary's.
func TestPruneBackupsEscapesGlobMeta(t *testing.T) {
	dir := t.TempDir()
	// Two binaries in sibling directories whose names differ only by a glob
	// character in one of them: pruning one must not match the other's files.
	plainDir := filepath.Join(dir, "bin")
	metaDir := filepath.Join(dir, "bin[1]")
	if err := os.MkdirAll(plainDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(metaDir, 0o700); err != nil {
		t.Fatal(err)
	}
	plainBackup := filepath.Join(plainDir, "tokenboard.backup-20260101T000000Z")
	if err := os.WriteFile(plainBackup, []byte("plain"), 0o755); err != nil {
		t.Fatal(err)
	}
	pruneBackups(filepath.Join(metaDir, "tokenboard"), filepath.Join(metaDir, "tokenboard.backup-new"))
	if _, err := os.Stat(plainBackup); err != nil {
		t.Errorf("the sibling directory's backup was removed by an escaped-name pattern: %v", err)
	}
}
