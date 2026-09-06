package configschema

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestBunHolderBlocksGoCoordinator(t *testing.T) {
	if _, err := exec.LookPath("bun"); err != nil { t.Skip("bun unavailable") }
	dir := t.TempDir()
	ready := filepath.Join(dir, "ready")
	db := filepath.Join(dir, mutationDatabaseName)
	script := filepath.Join(dir, "hold.ts")
	const source = `import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
const [databasePath, readyPath] = Bun.argv.slice(2);
const db = new Database(databasePath, { create: true });
db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
writeFileSync(readyPath, "ready");
setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, 200);
`
	if err := os.WriteFile(script, []byte(source), 0o600); err != nil { t.Fatal(err) }
	cmd := exec.Command("bun", script, db, ready)
	if err := cmd.Start(); err != nil { t.Fatal(err) }
	defer func() { _ = cmd.Wait() }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil { break }
		if time.Now().After(deadline) { t.Fatal("Bun holder did not acquire coordinator") }
		time.Sleep(10 * time.Millisecond)
	}
	_, err := WithMutationCoordinator(context.Background(), filepath.Join(dir, "config.json"), nil, func(int64) (bool, error) {
		t.Fatal("callback must not run while Bun owns BEGIN IMMEDIATE")
		return false, nil
	})
	if !errors.Is(err, ErrMutationBusy) { t.Fatalf("error = %v, want busy", err) }
}
