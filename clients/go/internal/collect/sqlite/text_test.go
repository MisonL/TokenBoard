package sqlite

import (
	dbsql "database/sql"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The text reader exists so a caller whose SQL renders its result set as text
// (the Antigravity sources parse `idx|hex` lines) can use the embedded driver,
// which needs nothing installed. The contract is that both readers produce the
// same bytes — a cursor hashes that text, so a rendering difference would
// silently change row identity depending on which reader ran.
func TestQueryTextRendersRowsExactlyAsTheExecutableDoes(t *testing.T) {
	if _, err := exec.LookPath("sqlite3"); err != nil {
		t.Skip("sqlite3 executable not installed; the external rendering is covered by its own cases")
	}
	root := t.TempDir()
	dbPath := filepath.Join(root, "probe.db")
	seedDatabase(t, dbPath,
		"CREATE TABLE t (n INTEGER, b BLOB, s TEXT);",
		// Every shape the CLI renders differently: a blob through hex(), a null
		// column, an empty blob, a string containing the delimiter, and a
		// multi-byte value.
		"INSERT INTO t VALUES (1, x'0A0B0C', 'a|b'), (2, NULL, ''), (3, x'', '多字节'), (4, NULL, NULL);",
	)

	for _, sql := range []string{
		"select n, hex(b) from t order by n",
		"select max(n) from t",
		"select n, s from t order by n",
		"select n from t where n > 999",
	} {
		embedded, err := QueryText(dbPath, sql, QueryOptions{Label: "Probe"})
		if err != nil {
			t.Fatalf("embedded read of %q: %v", sql, err)
		}
		external, err := QueryText(dbPath, sql, QueryOptions{Label: "Probe", ForceExternal: true})
		if err != nil {
			t.Fatalf("external read of %q: %v", sql, err)
		}
		if embedded != external {
			t.Errorf("readers disagree for %q:\nembedded: %q\nexternal: %q", sql, embedded, external)
		}
	}

	// And the rendering itself, so a change to both readers at once cannot hide here.
	rendering, err := QueryText(dbPath, "select n, hex(b) from t order by n", QueryOptions{Label: "Probe"})
	if err != nil {
		t.Fatal(err)
	}
	want := "1|0A0B0C\n2|\n3|\n4|\n"
	if rendering != want {
		t.Errorf("rendering = %q, want %q", rendering, want)
	}
}

func TestQueryTextAppliesTheOutputCeilingToTheEmbeddedReader(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "big.db")
	seedDatabase(t, dbPath,
		"CREATE TABLE t (s TEXT);",
		// Built inside SQLite so the test's own allocation stays small; the row
		// count is the minimum that crosses 64 MiB.
		"WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 20) "+
			"INSERT INTO t SELECT hex(zeroblob(2 * 1024 * 1024)) FROM c;",
	)

	if _, err := QueryText(dbPath, "select s from t", QueryOptions{Label: "Probe"}); err == nil {
		t.Fatal("a result far above the default ceiling was accepted")
	} else if !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("error = %v, want the output-budget rejection", err)
	}
}

// The budget has to be measured on the bytes this path actually returns.
// Measuring the rows as JSON while emitting the `|`-separated rendering sizes
// them differently, so the reader would reject at a different point than the
// executable's own cap.
func TestQueryTextMeasuresTheBudgetOnTheTextItEmits(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "text-budget.db")
	seedDatabase(t, dbPath,
		"CREATE TABLE t (idx INTEGER, data TEXT);",
		// Two rows whose JSON encoding is larger than their `idx|data`
		// rendering: JSON adds the key names, quotes and braces, while the text
		// form adds only a `|`.
		"INSERT INTO t VALUES (1, printf('%.*c', 4096, 'a')), (2, printf('%.*c', 4096, 'b'));",
	)

	const renderedBytes = 2*2 + 2*4100 + 2 // "idx|data\n" per row
	const jsonBytes = 4096 + 4096 + len(`{"idx":1,"data":"..."}`) + len(`{"idx":2,"data":"..."}`)
	if jsonBytes <= renderedBytes {
		t.Fatalf("premise broken: jsonBytes %d <= renderedBytes %d", jsonBytes, renderedBytes)
	}

	// Just below the JSON size and just above the rendered size: measured on
	// the real output the read succeeds; measured on JSON it would throw.
	ceiling := (renderedBytes + jsonBytes) / 2
	text, err := QueryText(dbPath, "select idx, data from t order by idx",
		QueryOptions{Label: "Probe", MaxOutputBytes: ceiling})
	if err != nil {
		t.Fatalf("a rendered-size result was rejected under a ceiling of %d: %v", ceiling, err)
	}
	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	if len(lines) != 2 || len(lines[0]) != 1+1+4096 || len(lines[1]) != 1+1+4096 {
		t.Errorf("unexpected rendering: %d lines, lengths %v", len(lines), []int{len(lines[0]), len(lines[1])})
	}
}

// The Antigravity sources carry a larger ceiling than the shared default
// because they read whole pages of hex(data), which doubles each blob.
func TestKeepsTheAntigravityCeilingAboveTheSharedDefault(t *testing.T) {
	if AntigravityMaxOutputBytes != 128*1024*1024 {
		t.Fatalf("AntigravityMaxOutputBytes = %d, want 128MiB", AntigravityMaxOutputBytes)
	}
	if AntigravityMaxOutputBytes <= MaxOutputBytes {
		t.Fatal("the Antigravity ceiling must sit above the shared default")
	}
}

// The Antigravity sources carry a larger ceiling than the shared default; this
// pins the override mechanism itself.
func TestHonoursACallerSuppliedOutputCeiling(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "override.db")
	seedDatabase(t, dbPath,
		"CREATE TABLE t (s TEXT);",
		"WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 20) "+
			"INSERT INTO t SELECT hex(zeroblob(2 * 1024 * 1024)) FROM c;",
	)

	// Above the default this result set is rejected...
	if _, err := QueryText(dbPath, "select s from t", QueryOptions{Label: "Probe"}); err == nil {
		t.Fatal("the default ceiling was not applied")
	}
	// ...and with the Antigravity ceiling it is read, which is the behaviour
	// the unified reader had to preserve.
	text, err := QueryText(dbPath, "select s from t",
		QueryOptions{Label: "Probe", MaxOutputBytes: AntigravityMaxOutputBytes})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "00") {
		t.Error("the raised-ceiling read did not return the rows")
	}
}

func TestQueryTextReportsTheExecutableAsUnavailableWhenItIsMissing(t *testing.T) {
	_, err := QueryText("/tmp/tokenboard-sqlite-text-missing.db", "select 1", QueryOptions{
		Label:         "Probe",
		ForceExternal: true,
		SQLiteBin:     strPtr("tokenboard-sqlite3-does-not-exist"),
	})
	if err == nil || !strings.Contains(err.Error(), "Probe SQLite reader unavailable") {
		t.Fatalf("error = %v, want the unavailable report", err)
	}
}

func TestQueryTextPrefersTheInjectedReader(t *testing.T) {
	result, err := QueryText("/tmp/tokenboard-sqlite-text-ignored.db", "select 1", QueryOptions{
		Label:    "Probe",
		RunQuery: func(string, string) (string, error) { return "injected\n", nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if result != "injected\n" {
		t.Errorf("result = %q, want the injected text", result)
	}
}

// Text rows can be long, and the budget is measured on the lines actually
// emitted: one very long line still trips the ceiling when it alone crosses it.
func TestQueryTextBudgetCountsTheTrailingNewline(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "framing.db")
	seedDatabase(t, dbPath,
		"CREATE TABLE t (s TEXT);",
		"INSERT INTO t VALUES ('one'), ('two');",
	)

	// Two rows of 3 bytes each: with the newline framing the rendered text is
	// 8 bytes, so a ceiling of exactly 8 fits and 7 does not.
	if _, err := QueryText(dbPath, "select s from t",
		QueryOptions{Label: "Probe", MaxOutputBytes: 8}); err != nil {
		t.Errorf("8 bytes should fit: %v", err)
	}
	if _, err := QueryText(dbPath, "select s from t",
		QueryOptions{Label: "Probe", MaxOutputBytes: 7}); err == nil {
		t.Error("7 bytes should be rejected")
	}
}

func strPtr(value string) *string { return &value }

// seedDatabase creates a real database file through the embedded driver, so
// the cases that only exercise that reader do not need an executable on PATH.
func seedDatabase(t *testing.T, dbPath string, statements ...string) {
	t.Helper()
	database, err := dbsql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("opening %s: %v", dbPath, err)
	}
	defer database.Close()
	for _, statement := range statements {
		if _, err := database.Exec(statement); err != nil {
			t.Fatalf("seeding %s with %q: %v", dbPath, statement, err)
		}
	}
}
