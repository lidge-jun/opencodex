package storage

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func TestScanCountsNewestSQLiteReadonly(t *testing.T) {
	home := t.TempDir()
	dbPath := filepath.Join(home, "state_5.sqlite")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE threads (id TEXT PRIMARY KEY); INSERT INTO threads VALUES ('a'), ('b')`); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}

	before, err := os.ReadDir(home)
	if err != nil {
		t.Fatal(err)
	}
	report, err := Scan(home)
	if err != nil {
		t.Fatalf("Scan() error = %v", err)
	}
	after, err := os.ReadDir(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("scan created sidecars: before=%d after=%d", len(before), len(after))
	}

	var state *Bucket
	for i := range report.Buckets {
		if report.Buckets[i].Key == BucketStateDB {
			state = &report.Buckets[i]
		}
	}
	if state == nil || state.Rows == nil || *state.Rows != 2 {
		t.Fatalf("state bucket = %#v, want rows=2", state)
	}
}
