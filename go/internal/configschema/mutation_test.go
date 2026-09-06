package configschema

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func TestMutationCoordinatorInitializesAndBumpsGeneration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	zero := int64(0)
	result, err := WithMutationCoordinator(context.Background(), path, &zero, func(generation int64) (bool, error) {
		if generation != 0 {
			t.Fatalf("generation in callback = %d", generation)
		}
		return true, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || result.Generation != 1 {
		t.Fatalf("result = %+v", result)
	}
	if got, err := ReadGeneration(context.Background(), path); err != nil || got != 1 {
		t.Fatalf("generation = %d, %v", got, err)
	}
}

func TestMutationCoordinatorFailsImmediatelyWhileAnotherWriterHoldsImmediate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	db, err := sql.Open("sqlite", MutationDatabasePath(path))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	defer db.Exec("ROLLBACK")
	_, err = WithMutationCoordinator(context.Background(), path, nil, func(int64) (bool, error) {
		t.Fatal("callback must not run while busy")
		return false, nil
	})
	if !errors.Is(err, ErrMutationBusy) {
		t.Fatalf("error = %v, want busy", err)
	}
}

func TestMutationCoordinatorRejectsStaleGenerationAndRollsBackCallback(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	stale := int64(9)
	_, err := WithMutationCoordinator(context.Background(), path, &stale, func(int64) (bool, error) {
		t.Fatal("callback must not run for stale generation")
		return false, nil
	})
	var conflict *GenerationConflictError
	if !errors.As(err, &conflict) || conflict.Current != 0 {
		t.Fatalf("error = %v, conflict = %+v", err, conflict)
	}
	_, err = WithMutationCoordinator(context.Background(), path, nil, func(int64) (bool, error) {
		return false, errors.New("abort")
	})
	if err == nil {
		t.Fatal("callback error was swallowed")
	}
	// The first transaction's table creation was rolled back, so a later
	// acquisition must recreate a clean singleton at zero.
	result, err := WithMutationCoordinator(context.Background(), path, nil, func(generation int64) (bool, error) {
		if generation != 0 {
			t.Fatalf("generation after rollback = %d", generation)
		}
		return false, nil
	})
	if err != nil || result.Changed || result.Generation != 0 {
		t.Fatalf("post-rollback result = %+v, %v", result, err)
	}
}

func TestMutationCoordinatorCrashRecoveryReleasesImmediate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	db, err := sql.Open("sqlite", MutationDatabasePath(path))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	// Closing an uncommitted connection models process exit: SQLite releases
	// BEGIN IMMEDIATE without a stale-owner cleanup protocol.
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	result, err := WithMutationCoordinator(context.Background(), path, nil, func(int64) (bool, error) { return true, nil })
	if err != nil || !result.Changed || result.Generation != 1 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestRevalidatedMutationRebasesAfterDirectWriterChangesBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"revision":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	calls := 0
	result, err := WithRevalidatedConfigMutation(context.Background(), path, nil, func(raw []byte, _ int64) ([]byte, bool, error) {
		calls++
		if calls == 1 {
			// This bypasses config-mutation.sqlite like a direct editor. The Go
			// transaction must discard its stale proposal and rerun on these bytes.
			if err := os.WriteFile(path, []byte(`{"revision":2,"external":true}`), 0o600); err != nil {
				return nil, false, err
			}
		}
		return append(raw[:len(raw)-1], []byte(`,"native":true}`)...), true, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || result.Generation != 1 || calls != 3 {
		t.Fatalf("result=%+v calls=%d", result, calls)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := []byte(`{"revision":2,"external":true,"native":true}`)
	if !bytes.Equal(got, want) {
		t.Fatalf("rebase lost direct writer bytes: got %s want %s", got, want)
	}
}

func TestRevalidatedMutationChecksBytesAfterConfirmedReplay(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"revision":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	calls := 0
	_, err := WithRevalidatedConfigMutation(context.Background(), path, nil, func(raw []byte, _ int64) ([]byte, bool, error) {
		calls++
		if calls == 2 {
			// The first read-back was equal. Alter bytes in the confirmed replay
			// so only the final pre-write read can prevent the stale overwrite.
			if err := os.WriteFile(path, []byte(`{"revision":2,"external":true}`), 0o600); err != nil {
				return nil, false, err
			}
		}
		return append(raw[:len(raw)-1], []byte(`,"native":true}`)...), true, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := []byte(`{"revision":2,"external":true,"native":true}`)
	if !bytes.Equal(got, want) || calls != 4 {
		t.Fatalf("final revalidation failed: got=%s calls=%d", got, calls)
	}
}

func TestRevalidatedMutationFailsClosedAfterRepeatedDirectWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"revision":0}`), 0o600); err != nil {
		t.Fatal(err)
	}
	calls := 0
	_, err := WithRevalidatedConfigMutation(context.Background(), path, nil, func(raw []byte, _ int64) ([]byte, bool, error) {
		calls++
		if err := os.WriteFile(path, []byte(fmt.Sprintf(`{"revision":%d}`, calls)), 0o600); err != nil {
			return nil, false, err
		}
		return append(raw[:len(raw)-1], []byte(`,"native":true}`)...), true, nil
	})
	if !errors.Is(err, ErrRawByteConflict) || err.Error() != "config changed while applying this update; retry" {
		t.Fatalf("error=%v, want TypeScript retry conflict", err)
	}
	if calls != ConfigMutationMaxRebaseAttempts {
		t.Fatalf("calls=%d, want %d", calls, ConfigMutationMaxRebaseAttempts)
	}
	got, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if bytes.Contains(got, []byte("native")) {
		t.Fatalf("conflicted proposal reached disk: %s", got)
	}
}
