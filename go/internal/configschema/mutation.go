// Package configschema owns the shared config.json schema boundary and the
// SQLite coordinator used by future Go-native config mutations.
//
// Current config write commands deliberately remain TypeScript-owned. This
// package only provides the cross-language BEGIN IMMEDIATE/generation
// foundation; it must not be wired into CLI dispatch until the TypeScript write
// contract is ported in full. Required prerequisites are: full write-boundary
// schema and load-normalization coverage, modelCosts key redaction, clearing
// activeCodexAccountPinned when codexAccountPriorities changes, and raw-byte
// revalidation/rebase for non-cooperating direct writers.
package configschema

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

const mutationDatabaseName = "config-mutation.sqlite"

const createGenerationTable = "CREATE TABLE IF NOT EXISTS config_generation (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), value INTEGER NOT NULL CHECK (value >= 0))"

var (
	// ErrMutationBusy matches TypeScript's busy_timeout=0 policy: callers fail
	// promptly when either runtime owns BEGIN IMMEDIATE.
	ErrMutationBusy       = errors.New("config mutation already in progress")
	ErrGenerationConflict = errors.New("config generation conflict")
)

type GenerationConflictError struct{ Current int64 }

func (e *GenerationConflictError) Error() string {
	return fmt.Sprintf("%s: current generation %d", ErrGenerationConflict, e.Current)
}
func (e *GenerationConflictError) Unwrap() error { return ErrGenerationConflict }

type MutationResult struct {
	Changed    bool
	Generation int64
}

// MutationDatabasePath is $OPENCODEX_HOME/config-mutation.sqlite, the exact
// coordinator location used by src/config.ts.
func MutationDatabasePath(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), mutationDatabaseName)
}

// ReadGeneration observes an existing coordinator without creating it. Only a
// writer holding BEGIN IMMEDIATE may create the generation singleton.
func ReadGeneration(ctx context.Context, configPath string) (int64, error) {
	dbPath := MutationDatabasePath(configPath)
	if _, err := os.Stat(dbPath); err != nil {
		return 0, err
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return 0, err
	}
	defer db.Close()
	var generation int64
	if err := db.QueryRowContext(ctx, "SELECT value FROM config_generation WHERE singleton = 1").Scan(&generation); err != nil {
		return 0, err
	}
	if generation < 0 {
		return 0, errors.New("config generation singleton is invalid")
	}
	return generation, nil
}

// WithMutationCoordinator runs callback inside the same SQLite transaction as
// TypeScript's withConfigMutationLockSync: busy_timeout=0, BEGIN IMMEDIATE,
// singleton initialization, and commit/rollback. callback receives the current
// generation and returns whether it published a changed config.json while the
// transaction was held. A changed result increments generation in that same
// transaction. Future callers own config-byte freshness/rebase checks.
func WithMutationCoordinator(ctx context.Context, configPath string, expected *int64, callback func(generation int64) (changed bool, err error)) (result MutationResult, retErr error) {
	dir := filepath.Dir(configPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return result, err
	}
	dbPath := MutationDatabasePath(configPath)
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return result, err
	}
	defer db.Close()
	_ = os.Chmod(dbPath, 0o600)
	conn, err := db.Conn(ctx)
	if err != nil {
		return result, classifyMutationError(err)
	}
	defer conn.Close()
	// busy_timeout is connection-local; it must be set on the exact handle that
	// acquires BEGIN IMMEDIATE, not a separate database/sql pool connection.
	if _, err := conn.ExecContext(ctx, "PRAGMA busy_timeout = 0"); err != nil {
		return result, classifyMutationError(err)
	}
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return result, classifyMutationError(err)
	}
	open := true
	defer func() {
		if open {
			_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
		}
	}()
	if _, err := conn.ExecContext(ctx, createGenerationTable); err != nil {
		return result, err
	}
	if _, err := conn.ExecContext(ctx, "INSERT OR IGNORE INTO config_generation (singleton, value) VALUES (1, 0)"); err != nil {
		return result, err
	}
	var generation int64
	if err := conn.QueryRowContext(ctx, "SELECT value FROM config_generation WHERE singleton = 1").Scan(&generation); err != nil || generation < 0 {
		if err == nil {
			err = errors.New("config generation singleton is invalid")
		}
		return result, err
	}
	if expected != nil && *expected != generation {
		return result, &GenerationConflictError{Current: generation}
	}
	changed, err := callback(generation)
	if err != nil {
		return result, err
	}
	result.Generation = generation
	if changed {
		if _, err := conn.ExecContext(ctx, "UPDATE config_generation SET value = value + 1 WHERE singleton = 1 AND value = ?", generation); err != nil {
			return result, err
		}
		result.Changed = true
		result.Generation++
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return result, classifyMutationError(err)
	}
	open = false
	return result, nil
}

func classifyMutationError(err error) error {
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "database is locked") || strings.Contains(message, "database is busy") || strings.Contains(message, "sqlite_busy") || strings.Contains(message, "sqlite_locked") {
		return fmt.Errorf("%w: %v", ErrMutationBusy, err)
	}
	return err
}
