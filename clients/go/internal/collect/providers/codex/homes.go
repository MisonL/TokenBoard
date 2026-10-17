package codex

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Port of codex-homes.ts: which Codex homes this run reads. A machine may have
// several (a personal and a work profile), and each keeps its own session tree
// and hook cursor.

// ResolveHomesInput mirrors ResolveCodexHomesInput.
type ResolveHomesInput struct {
	// ExplicitHomes wins over every environment variable. A non-nil empty
	// slice still means "explicitly none", which falls back to the default
	// home the way the TS normalizer does.
	ExplicitHomes []string
	JSONValue     string
	LegacyValue   string
	// HomeDir is the user's home; empty uses os.UserHomeDir.
	HomeDir string
	// FileExists is injectable for tests.
	FileExists func(string) bool
}

// ResolveHomes ports resolveCodexHomes.
func ResolveHomes(input ResolveHomesInput) ([]string, error) {
	if input.ExplicitHomes != nil {
		return normalizeHomes(input.ExplicitHomes, input.HomeDir)
	}
	if strings.TrimSpace(input.JSONValue) != "" {
		parsed, err := parseHomesJSON(input.JSONValue)
		if err != nil {
			return nil, err
		}
		return normalizeHomes(parsed, input.HomeDir)
	}
	configured := strings.TrimSpace(input.LegacyValue)
	if configured == "" {
		home, err := defaultCodexHome(input.HomeDir)
		if err != nil {
			return nil, err
		}
		return []string{home}, nil
	}
	fileExists := input.FileExists
	if fileExists == nil {
		fileExists = func(path string) bool {
			_, err := os.Stat(path)
			return err == nil
		}
	}
	// A comma is the multi-home separator, so a single path that contains one
	// cannot be expressed through this variable. Only complain when the value
	// is also a real directory: otherwise the comma is the separator the user
	// meant.
	if strings.Contains(configured, ",") && fileExists(configured) {
		return nil, errors.New(
			"CODEX_HOME is ambiguous because the configured path contains a comma; " +
				"use TOKENBOARD_CODEX_HOMES_JSON or the codexHomes array instead")
	}
	return normalizeHomes(strings.Split(configured, ","), input.HomeDir)
}

func parseHomesJSON(value string) ([]string, error) {
	var parsed any
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return nil, fmt.Errorf("Invalid TOKENBOARD_CODEX_HOMES_JSON: expected a JSON array of paths: %w", err)
	}
	items, ok := parsed.([]any)
	if !ok || len(items) == 0 {
		return nil, errors.New("Invalid TOKENBOARD_CODEX_HOMES_JSON: expected a non-empty JSON array of paths")
	}
	homes := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok || strings.TrimSpace(text) == "" {
			return nil, errors.New("Invalid TOKENBOARD_CODEX_HOMES_JSON: expected a non-empty JSON array of paths")
		}
		homes = append(homes, text)
	}
	return homes, nil
}

// normalizeHomes trims, resolves, dedupes and falls back to the default home,
// in that order (the TS normalizer's pipeline).
func normalizeHomes(values []string, homeDir string) ([]string, error) {
	seen := map[string]bool{}
	homes := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		absolute, err := filepath.Abs(trimmed)
		if err != nil {
			return nil, err
		}
		absolute = resolvePath(absolute)
		if seen[absolute] {
			continue
		}
		seen[absolute] = true
		homes = append(homes, absolute)
	}
	if len(homes) == 0 {
		home, err := defaultCodexHome(homeDir)
		if err != nil {
			return nil, err
		}
		return []string{home}, nil
	}
	return homes, nil
}

func defaultCodexHome(homeDir string) (string, error) {
	if homeDir == "" {
		var err error
		homeDir, err = os.UserHomeDir()
		if err != nil {
			return "", err
		}
	}
	return resolvePath(filepath.Join(homeDir, ".codex")), nil
}

// resolvePath mirrors path.resolve: an absolute, cleaned path. It does not
// follow symlinks (the TS normalizer does not either).
func resolvePath(path string) string {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	return filepath.Clean(absolute)
}

// NormalizeSymlinkRoots ports normalizeCodexSymlinkRoots: absolute paths only,
// deduped. A nil input means "not configured" and yields no roots.
func NormalizeSymlinkRoots(values []string) ([]string, error) {
	if values == nil {
		return nil, nil
	}
	const hint = "Set TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON to a JSON array of absolute allowed target paths"
	if len(values) == 0 {
		return nil, fmt.Errorf(
			"Invalid Codex symlink roots: expected a non-empty JSON array of paths. %s", hint)
	}
	trimmed := make([]string, 0, len(values))
	for _, value := range values {
		text := strings.TrimSpace(value)
		if text == "" {
			return nil, fmt.Errorf(
				"Invalid Codex symlink roots: expected a non-empty JSON array of paths. %s", hint)
		}
		if !filepath.IsAbs(text) {
			return nil, fmt.Errorf("Invalid Codex symlink roots: expected absolute paths. %s", hint)
		}
		trimmed = append(trimmed, text)
	}
	seen := map[string]bool{}
	roots := make([]string, 0, len(trimmed))
	for _, value := range trimmed {
		resolved := resolvePath(value)
		if seen[resolved] {
			continue
		}
		seen[resolved] = true
		roots = append(roots, resolved)
	}
	return roots, nil
}

// ParseSymlinkRootsJSON ports parseCodexSymlinkRootsJson.
func ParseSymlinkRootsJSON(value string) ([]string, error) {
	var parsed any
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return nil, fmt.Errorf("Invalid TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON: expected a JSON array of paths: %w", err)
	}
	items, ok := parsed.([]any)
	if !ok {
		return nil, errors.New(
			"Invalid Codex symlink roots: expected a non-empty JSON array of paths. " +
				"Set TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON to a JSON array of absolute allowed target paths")
	}
	values := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			return nil, errors.New(
				"Invalid Codex symlink roots: expected a non-empty JSON array of paths. " +
					"Set TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON to a JSON array of absolute allowed target paths")
		}
		values = append(values, text)
	}
	return NormalizeSymlinkRoots(values)
}
