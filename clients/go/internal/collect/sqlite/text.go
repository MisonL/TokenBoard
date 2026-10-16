package sqlite

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// QueryText runs one read-only query and returns the sqlite3 CLI's own text
// rendering of its result set.
//
// It exists for callers whose SQL formats its result set as text rather than
// JSON — the Antigravity sources project blobs with hex(data) and parse
// `idx|hex` lines — so the embedded reader has to reproduce that exact
// rendering: a cursor hashes this text, and a rendering difference would
// silently change row identity depending on which reader ran. Columns are
// joined with `|`, rows with `\n`, and null renders as empty, matching
// sqlite3's default list mode for the column types callers project: text,
// integer, and null. A blob column is hex-encoded, as the CLI prints it.
//
// One type sits outside that contract: a REAL value goes through JavaScript
// number formatting on the TS side (`1.0` prints as `1`), which is not
// reproduced here. No caller projects one — blobs are hexed in SQL, so they
// arrive as text — and a new caller that does must extend this function
// rather than assume byte parity.
func QueryText(dbFile, sql string, options QueryOptions) (string, error) {
	if options.RunQuery != nil {
		return options.RunQuery(dbFile, sql)
	}
	if !options.ForceExternal && !externalForced() {
		return queryTextEmbedded(dbFile, sql, options)
	}
	return queryTextExternal(dbFile, sql, options)
}

// queryTextEmbedded reads through the embedded driver and renders the rows
// the way the executable would.
func queryTextEmbedded(dbFile, sql string, options QueryOptions) (string, error) {
	database, err := openReadOnly(dbFile, options.Label)
	if err != nil {
		return "", err
	}
	defer database.Close()

	rows, err := database.Query(sql)
	if err != nil {
		return "", openError(err, dbFile, options.Label)
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		return "", readError(err, dbFile, options.Label)
	}
	rendered := []string{}
	for rows.Next() {
		values := make([]any, len(columns))
		targets := make([]any, len(columns))
		for index := range values {
			targets[index] = &values[index]
		}
		if err := rows.Scan(targets...); err != nil {
			return "", readError(err, dbFile, options.Label)
		}
		fields := make([]string, len(values))
		for index, value := range values {
			fields[index] = renderTextValue(value)
		}
		rendered = append(rendered, strings.Join(fields, "|"))
	}
	if err := rows.Err(); err != nil {
		return "", readError(err, dbFile, options.Label)
	}
	if err := assertTextWithinOutputBudget(rendered, options.Label, resolveMaxOutputBytes(options)); err != nil {
		return "", err
	}
	if len(rendered) == 0 {
		return "", nil
	}
	return strings.Join(rendered, "\n") + "\n", nil
}

// renderTextValue renders one column the way the CLI's list mode does: null
// as an empty field, a blob hex-encoded, everything else as its text.
func renderTextValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case []byte:
		return fmt.Sprintf("%x", typed)
	case string:
		return typed
	default:
		return fmt.Sprintf("%v", typed)
	}
}

// assertTextWithinOutputBudget is the text-path counterpart of
// assertWithinOutputBudget: it measures the rendered `|`-separated lines this
// path actually returns, not the rows as JSON, because budgeting one encoding
// while emitting the other would make this path reject at a different point
// than the executable's own output cap.
func assertTextWithinOutputBudget(rendered []string, label string, maxOutputBytes int) error {
	bytes := 0
	for _, line := range rendered {
		bytes += len(line) + 1
		if bytes > maxOutputBytes {
			return fmt.Errorf("%s SQLite result exceeded %d bytes", label, maxOutputBytes)
		}
	}
	return nil
}

// queryTextExternal runs the executable without -json, so its default list
// mode produces the rendering the caller parses.
func queryTextExternal(dbFile, sql string, options QueryOptions) (string, error) {
	stdout, err := runExternal(dbFile, sql, false, options)
	if err != nil {
		return "", err
	}
	if !utf8.ValidString(stdout) {
		return "", fmt.Errorf("Failed to read %s SQLite data from %s: output is not valid UTF-8", options.Label, dbFile)
	}
	return stdout, nil
}
