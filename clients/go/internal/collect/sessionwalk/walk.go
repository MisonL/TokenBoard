// Package sessionwalk ports session-file-walk.ts and the root-resolution half
// of codex-symlink-policy.ts: bounded enumeration of the JSONL files under an
// AI tool's session tree.
//
// The tree belongs to another program, so the walk carries the same ceilings
// its sibling scanners use: depth 8, 10k entries per directory, and no
// symlinks anywhere inside. A symlink would either escape the tree or form a
// cycle; both are refused rather than followed.
package sessionwalk

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// MaxWalkDepth caps recursion below the root (the root itself is depth 0).
const MaxWalkDepth = 8

// MaxWalkEntries caps one directory listing.
const MaxWalkEntries = 10_000

// Options mirrors SessionJsonlResolutionOptions.
type Options struct {
	// RejectRootSymlink refuses a root that is itself a symlink unless it
	// resolves inside one of AllowedRootSymlinks.
	RejectRootSymlink bool
	// RootBoundary, when set, is a path the resolved root must stay inside.
	RootBoundary string
	// AllowedRootSymlinks are absolute targets a symlinked root may resolve to.
	AllowedRootSymlinks []string
	MaxDepth            int
	MaxEntries          int
}

// SymlinkRootsHint is the TS symlinkRootsConfigHint, printed with every
// symlink refusal so an operator knows which variable fixes it.
const SymlinkRootsHint = "Set TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON to a JSON array of absolute allowed target paths"

// Files is a resolved session tree.
type Files struct {
	RootDir string
	// Paths yields root-relative paths with forward slashes, in the TS walk's
	// sorted order (directories sort as `name/`).
	Paths []string
}

// Resolve enumerates the .jsonl files under rootDir. A missing root yields
// (Files{}, false, nil): the tool is simply not installed.
func Resolve(rootDir string, options Options) (Files, bool, error) {
	resolvedRoot, ok, err := resolveRoot(rootDir, options)
	if err != nil || !ok {
		return Files{}, false, err
	}
	maxDepth := options.MaxDepth
	if maxDepth == 0 {
		maxDepth = MaxWalkDepth
	}
	maxEntries := options.MaxEntries
	if maxEntries == 0 {
		maxEntries = MaxWalkEntries
	}
	paths := []string{}
	if err := walkDirectory(resolvedRoot, resolvedRoot, options, maxDepth, maxEntries, 0, &paths); err != nil {
		return Files{}, false, err
	}
	return Files{RootDir: resolvedRoot, Paths: paths}, true, nil
}

// ResolveRoot exposes the root half of Resolve without walking the tree. The
// Codex legacy-cursor migration needs the resolved root alone: it addresses one
// known relative path under it rather than enumerating.
func ResolveRoot(rootDir string, options Options) (string, bool, error) {
	return resolveRoot(rootDir, options)
}

func resolveRoot(rootPath string, options Options) (string, bool, error) {
	details, err := os.Lstat(rootPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("Unable to inspect session directory %s: %s", rootPath, errorText(err))
	}
	isRootSymlink := details.Mode()&os.ModeSymlink != 0
	if isRootSymlink && options.RejectRootSymlink && len(options.AllowedRootSymlinks) == 0 {
		return "", false, fmt.Errorf(
			"Unable to inspect session directory %s: symbolic links are not supported. %s",
			rootPath, SymlinkRootsHint)
	}
	if !details.IsDir() && !isRootSymlink {
		return "", false, fmt.Errorf("Unable to inspect session directory %s: path is not a directory", rootPath)
	}

	resolved, err := filepath.EvalSymlinks(rootPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) && !isRootSymlink {
			return "", false, nil
		}
		if errors.Is(err, fs.ErrNotExist) && isRootSymlink {
			return "", false, fmt.Errorf(
				"Unable to resolve session directory %s: configured symbolic link target does not exist", rootPath)
		}
		return "", false, fmt.Errorf("Unable to resolve session directory %s: %s", rootPath, errorText(err))
	}
	resolvedDetails, err := os.Stat(resolved)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) && !isRootSymlink {
			return "", false, nil
		}
		return "", false, fmt.Errorf("Unable to inspect resolved session directory %s: %s", resolved, errorText(err))
	}
	if !resolvedDetails.IsDir() {
		return "", false, fmt.Errorf("Unable to inspect session directory %s: resolved path is not a directory", rootPath)
	}

	if isRootSymlink && options.RejectRootSymlink {
		allowedTargets := make([]string, 0, len(options.AllowedRootSymlinks))
		for _, allowedRoot := range options.AllowedRootSymlinks {
			resolvedAllowed, err := filepath.EvalSymlinks(allowedRoot)
			if err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					return "", false, fmt.Errorf("Configured Codex symlink root does not exist: %s", allowedRoot)
				}
				return "", false, fmt.Errorf("Unable to resolve configured Codex symlink root %s: %s", allowedRoot, errorText(err))
			}
			allowedTargets = append(allowedTargets, resolvedAllowed)
		}
		allowed := false
		for _, target := range allowedTargets {
			if isPathInside(target, resolved) {
				allowed = true
				break
			}
		}
		if !allowed {
			return "", false, fmt.Errorf(
				"Unable to inspect session directory %s: symlink target is outside configured Codex symlink roots. %s",
				rootPath, SymlinkRootsHint)
		}
		return resolved, true, nil
	}

	if options.RootBoundary != "" {
		boundary, err := filepath.EvalSymlinks(options.RootBoundary)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return "", false, fmt.Errorf(
					"Unable to resolve session root boundary %s: configured boundary does not exist", options.RootBoundary)
			}
			return "", false, fmt.Errorf("Unable to resolve session root boundary %s: %s", options.RootBoundary, errorText(err))
		}
		if !isPathInside(boundary, resolved) {
			return "", false, fmt.Errorf(
				"Unable to inspect session directory %s: resolved path escapes its configured boundary", rootPath)
		}
	}
	return resolved, true, nil
}

func isPathInside(parent, child string) bool {
	relative, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return !filepath.IsAbs(relative) && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

type directoryEntry struct {
	name  string
	isDir bool
}

func walkDirectory(
	rootDir, currentDir string,
	options Options,
	maxDepth, maxEntries, depth int,
	paths *[]string,
) error {
	if depth > maxDepth {
		return fmt.Errorf("Session directory %s exceeds the %d-level scan depth limit", currentDir, maxDepth)
	}
	ok, err := assertSessionDirectory(currentDir)
	if err != nil || !ok {
		return err
	}
	entries, ok, err := readDirectoryEntries(currentDir, maxEntries)
	if err != nil || !ok {
		return err
	}
	sort.SliceStable(entries, func(i, j int) bool {
		return entrySortPath(rootDir, currentDir, entries[i]) < entrySortPath(rootDir, currentDir, entries[j])
	})
	for _, entry := range entries {
		entryPath := filepath.Join(currentDir, entry.name)
		info, err := os.Lstat(entryPath)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return fmt.Errorf("Unable to inspect session entry %s: %s", entryPath, errorText(err))
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("Unable to read session entry %s: symbolic links are not supported", entryPath)
		}
		if entry.isDir {
			if err := walkDirectory(rootDir, entryPath, options, maxDepth, maxEntries, depth+1, paths); err != nil {
				return err
			}
			continue
		}
		if strings.HasSuffix(entry.name, ".jsonl") {
			relative, err := filepath.Rel(rootDir, entryPath)
			if err != nil {
				return err
			}
			*paths = append(*paths, NormalizeRelativePath(relative))
		}
	}
	return nil
}

func assertSessionDirectory(path string) (bool, error) {
	details, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("Unable to inspect session directory %s: %s", path, errorText(err))
	}
	if details.Mode()&os.ModeSymlink != 0 {
		return false, fmt.Errorf("Unable to inspect session directory %s: symbolic links are not supported", path)
	}
	if !details.IsDir() {
		return false, fmt.Errorf("Unable to inspect session directory %s: path is not a directory", path)
	}
	return true, nil
}

// readDirectoryEntries lists a directory in bounded batches. Reading it whole
// first (`os.ReadDir`) would allocate one entry per dirent before the caller's
// entry cap could refuse the directory, which is the situation the cap exists
// for — a session tree that picked up a directory with millions of children.
func readDirectoryEntries(currentDir string, maxEntries int) ([]directoryEntry, bool, error) {
	directory, err := os.Open(currentDir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("Unable to read session directory %s: %s", currentDir, errorText(err))
	}
	defer directory.Close()

	result := []directoryEntry{}
	for {
		batch, readErr := directory.ReadDir(256)
		for _, entry := range batch {
			isDir := entry.IsDir()
			if entry.Type()&os.ModeSymlink != 0 {
				// Keep the dirent classification but let the lstat below
				// surface the symlink refusal with the entry's full path.
				isDir = false
			}
			result = append(result, directoryEntry{name: entry.Name(), isDir: isDir})
		}
		if maxEntries > 0 && len(result) > maxEntries {
			return nil, false, fmt.Errorf("Session directory %s exceeds the %d-entry scan limit", currentDir, maxEntries)
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			if errors.Is(readErr, fs.ErrNotExist) {
				return nil, false, nil
			}
			return nil, false, fmt.Errorf("Unable to read session directory %s: %s", currentDir, errorText(readErr))
		}
	}
	if maxEntries > 0 && len(result) > maxEntries {
		return nil, false, fmt.Errorf("Session directory %s exceeds the %d-entry scan limit", currentDir, maxEntries)
	}
	return result, true, nil
}

func entrySortPath(rootDir, currentDir string, entry directoryEntry) string {
	relative, err := filepath.Rel(rootDir, filepath.Join(currentDir, entry.name))
	if err != nil {
		relative = entry.name
	}
	normalized := NormalizeRelativePath(relative)
	if entry.isDir {
		return normalized + "/"
	}
	return normalized
}

// NormalizeRelativePath converts the platform separator to "/" so cursor keys
// are identical on every platform, the way the TS normalizeSessionRelativePath
// does on Windows.
func NormalizeRelativePath(value string) string {
	if filepath.Separator == '\\' {
		return strings.ReplaceAll(value, "\\", "/")
	}
	return value
}

func errorText(err error) string {
	var pathErr *fs.PathError
	if errors.As(err, &pathErr) {
		return pathErr.Err.Error()
	}
	return err.Error()
}
