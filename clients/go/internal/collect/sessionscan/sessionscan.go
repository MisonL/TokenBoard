// Package sessionscan ports bounded-session-scan.ts: bounded, symlink-safe
// scanning for session logs under a user's home directory.
//
// These roots are outside TokenBoard's control, so a scan must not be able to
// hang or exhaust memory: recursion is depth-capped, symlinked directories are
// never followed (a cycle would otherwise recurse forever), directory
// listings are bounded before they are sorted, and oversized files are
// skipped. Session logs are read line by line because a single one can be
// tens of megabytes.
package sessionscan

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"syscall"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/mtime"
)

const (
	// MaxScanDepth caps recursion below each root.
	MaxScanDepth = 8
	// MaxSessionFileBytes skips files too large to be a session log.
	MaxSessionFileBytes = 256 * 1024 * 1024
	// MaxScanDirectoryEntries rejects a listing that is too large to sort
	// in one go, matching the TS scanner's ceiling: a single abnormal
	// directory must not be able to exhaust memory just by existing.
	MaxScanDirectoryEntries = 10_000
	// maxLineBytes caps one JSONL line. The TS readerline has no cap; this
	// one fails loudly instead of growing without bound on a pathological
	// line. Real session events are far below it.
	maxLineBytes = 64 * 1024 * 1024
)

// ScannedSessionFile is one accepted session log.
type ScannedSessionFile struct {
	Path    string
	MtimeMs float64
	Size    int64
}

// Options configures a scan. Zero values select the Max* defaults.
type Options struct {
	// Matches accepts a file name and returns whether it is a session log.
	Matches func(fileName string) bool
	// MaxDepth caps recursion; the root itself is depth 0.
	MaxDepth int
	// MaxFileBytes skips larger files.
	MaxFileBytes int64
	// MaxDirectoryEntries rejects larger listings.
	MaxDirectoryEntries int
	// OnSkipped reports a path the scan deliberately passed over. Reasons:
	// max-depth, symlink, max-size, max-entries, unreadable, vanished.
	OnSkipped func(path, reason string)
}

// Scan walks rootDir in a stable order (directories depth-first, entries by
// name) and calls visit for every accepted session log. A missing root is not
// an error: the tool simply is not installed.
func Scan(rootDir string, options Options, visit func(ScannedSessionFile) error) error {
	return scanDirectory(rootDir, options, 0, visit)
}

func scanDirectory(currentDir string, options Options, depth int, visit func(ScannedSessionFile) error) error {
	maxDepth := options.MaxDepth
	if maxDepth == 0 {
		maxDepth = MaxScanDepth
	}
	if depth > maxDepth {
		options.OnSkipped(currentDir, "max-depth")
		return nil
	}

	entries, ok, err := readDirectoryEntries(currentDir, options)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}

	for _, entry := range entries {
		entryPath := filepath.Join(currentDir, entry.Name())
		if entry.Type()&os.ModeSymlink != 0 {
			// Never follow a link: a cycle under the root would recurse
			// forever.
			options.OnSkipped(entryPath, "symlink")
			continue
		}
		if entry.IsDir() {
			if err := scanDirectory(entryPath, options, depth+1, visit); err != nil {
				return err
			}
			continue
		}
		if !options.Matches(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			// A session log can be rotated away mid-scan; that is not a
			// failure. A file the scan is not allowed to read is reported
			// rather than dropped.
			if reason, ignorable := ignorableScanError(err); ignorable {
				options.OnSkipped(entryPath, reason)
				continue
			}
			return err
		}
		// Info().Mode() rather than entry.Type(): on filesystems that
		// return DT_UNKNOWN, the dirent type bits are zero and a regular
		// file would be indistinguishable from an unknown one.
		if !info.Mode().IsRegular() {
			continue
		}
		maxBytes := options.MaxFileBytes
		if maxBytes == 0 {
			maxBytes = MaxSessionFileBytes
		}
		if info.Size() > maxBytes {
			options.OnSkipped(entryPath, "max-size")
			continue
		}
		if err := visit(ScannedSessionFile{
			Path:    entryPath,
			MtimeMs: mtime.Millis(info.ModTime()),
			Size:    info.Size(),
		}); err != nil {
			return err
		}
	}
	return nil
}

// readDirectoryEntries lists a directory, bounding the listing before it is
// sorted. ok=false means the directory was skipped (reported via OnSkipped).
func readDirectoryEntries(currentDir string, options Options) ([]os.DirEntry, bool, error) {
	maxEntries := options.MaxDirectoryEntries
	if maxEntries == 0 {
		maxEntries = MaxScanDirectoryEntries
	}
	// Open and read both sit inside the error handling: opening succeeds on
	// an unreadable directory on some platforms and the EACCES surfaces on
	// the first read.
	directory, err := os.Open(currentDir)
	if err != nil {
		if reason, ignorable := ignorableScanError(err); ignorable {
			// A directory the scan cannot read is skipped, but never
			// silently: a whole root that is unreadable would otherwise look
			// like an uninstalled tool and its usage would vanish without a
			// trace.
			options.OnSkipped(currentDir, reason)
			return nil, false, nil
		}
		return nil, false, scanDirectoryError(currentDir, err)
	}
	defer directory.Close()

	var entries []os.DirEntry
	for {
		batch, readErr := directory.ReadDir(256)
		entries = append(entries, batch...)
		// Bound the listing before sorting it, so a directory with an
		// unbounded number of entries cannot be loaded whole. The cap is a
		// hard ceiling: exceeding it is reported and the directory skipped,
		// the same way an oversized file is.
		if len(entries) > maxEntries {
			options.OnSkipped(currentDir, "max-entries")
			return nil, false, nil
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			if reason, ignorable := ignorableScanError(readErr); ignorable {
				options.OnSkipped(currentDir, reason)
				return nil, false, nil
			}
			return nil, false, scanDirectoryError(currentDir, readErr)
		}
	}
	// Stable order keeps repeated scans and their diagnostics reproducible.
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	return entries, true, nil
}

func scanDirectoryError(currentDir string, err error) error {
	message := err.Error()
	var pathErr *fs.PathError
	if errors.As(err, &pathErr) {
		message = pathErr.Err.Error()
	}
	return fmt.Errorf("Unable to read session directory %s: %s", currentDir, message)
}

// ignorableScanError maps an OS error to the skip reason, mirroring the TS
// isIgnorableScanError: ENOENT (removed mid-scan), EACCES/EPERM (not ours to
// read), ENOTDIR (raced).
func ignorableScanError(err error) (string, bool) {
	switch {
	case errors.Is(err, fs.ErrPermission):
		return "unreadable", true
	case errors.Is(err, fs.ErrNotExist):
		return "vanished", true
	case errors.Is(err, syscall.ENOTDIR):
		return "vanished", true
	}
	return "", false
}

// ReadLines reads a session log line by line so a large file never lands in
// memory. yield returning an error stops the read.
func ReadLines(filePath string, yield func(line string) error) error {
	file, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), maxLineBytes)
	for scanner.Scan() {
		if err := yield(scanner.Text()); err != nil {
			return err
		}
	}
	return scanner.Err()
}
