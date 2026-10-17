package antigravitygui

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeCascadeFile creates one conversation file with an exact mtime, so the
// listing's mtime/size selection can be asserted rather than approximated.
func writeCascadeFile(t *testing.T, dir, name string, size int, at time.Time) {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, make([]byte, size), 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatalf("chtimes %s: %v", name, err)
	}
}

func listCascades(t *testing.T, dir string) []CascadeRef {
	t.Helper()
	cascades, err := ListAntigravityCascades(ListCascadesInput{
		Source:          "antigravity",
		ConversationDir: dir,
		Limit:           12,
	})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	return cascades
}

func TestListsCascadesThatOnlyHaveAPbFile(t *testing.T) {
	// The .pb trajectory is the cascade's own file; a conversation that has one
	// and no database is exactly what the language-server route exists for.
	dir := t.TempDir()
	writeCascadeFile(t, dir, "11111111-1111-1111-1111-111111111111.pb", 9,
		time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC))

	cascades := listCascades(t, dir)
	if len(cascades) != 1 {
		t.Fatalf("cascades = %d, want the .pb-only conversation listed", len(cascades))
	}
	if cascades[0].ID != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("id = %q", cascades[0].ID)
	}
	if cascades[0].HasDatabaseFile {
		t.Fatal("hasDatabaseFile = true, want false without a .db")
	}
	if cascades[0].Size != 9 {
		t.Fatalf("size = %d, want the .pb size 9", cascades[0].Size)
	}
}

func TestCascadeRefUsesTheNewestFilesMtimeAndSize(t *testing.T) {
	// Both files present: the newer one supplies mtime *and* size together, so
	// the cursor's (mtime, size) comparison cannot mix the two sources.
	dir := t.TempDir()
	id := "22222222-2222-2222-2222-222222222222"
	writeCascadeFile(t, dir, id+".db", 2, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	writeCascadeFile(t, dir, id+".pb", 9, time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC))

	cascades := listCascades(t, dir)
	if len(cascades) != 1 {
		t.Fatalf("cascades = %d, want 1", len(cascades))
	}
	cascade := cascades[0]
	if !cascade.HasDatabaseFile {
		t.Fatal("hasDatabaseFile = false, want true when the .db exists")
	}
	wantMtime := float64(time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC).UnixMilli())
	if cascade.MtimeMs != wantMtime {
		t.Fatalf("mtimeMs = %v, want the newer .pb's %v", cascade.MtimeMs, wantMtime)
	}
	if cascade.Size != 9 {
		t.Fatalf("size = %d, want the newer .pb's 9 (mtime and size come from one file)", cascade.Size)
	}
}

func TestCascadeRefPrefersThePbOnAnMtimeTie(t *testing.T) {
	// The TS reduce keeps the first candidate on a tie, and .pb is stat'ed
	// first, so an equal-mtime pair reports the .pb's size.
	dir := t.TempDir()
	id := "33333333-3333-3333-3333-333333333333"
	at := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	writeCascadeFile(t, dir, id+".pb", 9, at)
	writeCascadeFile(t, dir, id+".db", 2, at)

	cascades := listCascades(t, dir)
	if len(cascades) != 1 {
		t.Fatalf("cascades = %d, want 1", len(cascades))
	}
	if cascades[0].Size != 9 {
		t.Fatalf("size = %d, want the .pb's 9 on an mtime tie", cascades[0].Size)
	}
}

func TestIgnoresFilesThatAreNotCascadeFiles(t *testing.T) {
	// Only .pb and .db name a conversation. A .agc, .txt, or extensionless file
	// with a UUID-shaped name is not one.
	dir := t.TempDir()
	id := "44444444-4444-4444-4444-444444444444"
	writeCascadeFile(t, dir, id+".agc", 3, time.Now())
	writeCascadeFile(t, dir, id+".txt", 3, time.Now())

	if _, err := ListAntigravityCascades(ListCascadesInput{
		Source: "antigravity", ConversationDir: dir, Limit: 12,
	}); err == nil || err.Error() != "No Antigravity conversations found in "+dir {
		t.Fatalf("err = %v, want the no-conversations classification", err)
	}
}

func TestNonEmptyDirectoryWithoutConversationsIsUnavailable(t *testing.T) {
	// A directory holding unrelated files is still "no conversations here": the
	// TS side reports it as unavailable, and the all-source run skips on it
	// rather than reporting a successful empty collection.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := ListAntigravityCascades(ListCascadesInput{
		Source: "antigravity", ConversationDir: dir, Limit: 12,
	})
	if err == nil {
		t.Fatal("a directory with no conversations must report unavailable")
	}
	if err.Error() != "No Antigravity conversations found in "+dir {
		t.Fatalf("err = %v, want the no-conversations message", err)
	}
}
