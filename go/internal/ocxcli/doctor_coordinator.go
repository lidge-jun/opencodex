package ocxcli

import (
	"crypto/sha256"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// DoctorCoordinatorDiagnostic is the read-only native-write coordinator report.
// Recovery stays TypeScript-owned; this collector never creates or modifies state.
type DoctorCoordinatorDiagnostic struct {
	Kind, Path, Reason            string
	Version                       int
	Size                          int64
	Tables                        []string
	TransitionRows, SingletonRows *int
}

func doctorCoordinatorLocation() (string, DoctorCoordinatorDiagnostic) {
	home, err := filepath.EvalSymlinks(doctorCodexHome())
	if err != nil {
		return "", DoctorCoordinatorDiagnostic{Kind: "unsafe", Reason: "The Codex coordinator namespace cannot be inspected."}
	}
	root := filepath.Join("/tmp", fmt.Sprintf("opencodex-runtime-v1-%d", os.Getuid()))
	info, err := os.Lstat(root)
	if os.IsNotExist(err) {
		return "", DoctorCoordinatorDiagnostic{Kind: "absent"}
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !doctorOwnedByCurrentUser(info) || info.Mode().Perm() != 0o700 {
		return "", DoctorCoordinatorDiagnostic{Kind: "unsafe", Reason: "The Codex coordinator namespace has unsafe ownership or permissions."}
	}
	locks := filepath.Join(root, "native-write-locks")
	info, err = os.Lstat(locks)
	sum := sha256.Sum256([]byte(home))
	path := filepath.Join(locks, fmt.Sprintf("%x.sqlite", sum))
	if os.IsNotExist(err) {
		return path, DoctorCoordinatorDiagnostic{Kind: "absent", Path: path}
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !doctorOwnedByCurrentUser(info) || info.Mode().Perm() != 0o700 {
		return "", DoctorCoordinatorDiagnostic{Kind: "unsafe", Reason: "The coordinator lock namespace has unsafe ownership or permissions."}
	}
	return path, DoctorCoordinatorDiagnostic{}
}

func CollectDoctorCoordinator() DoctorCoordinatorDiagnostic {
	path, early := doctorCoordinatorLocation()
	if early.Kind != "" {
		return early
	}
	before, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return DoctorCoordinatorDiagnostic{Kind: "absent", Path: path}
	}
	if err != nil {
		return DoctorCoordinatorDiagnostic{Kind: "unsafe", Path: path, Reason: "the coordinator file cannot be inspected"}
	}
	if !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || !doctorOwnedByCurrentUser(before) || before.Mode().Perm() != 0o600 {
		return DoctorCoordinatorDiagnostic{Kind: "unsafe", Path: path, Reason: "the coordinator file has unsafe ownership or permissions"}
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil || real != path {
		return DoctorCoordinatorDiagnostic{Kind: "unsafe", Path: path, Reason: "the coordinator path is redirected"}
	}
	for _, suffix := range []string{"-journal", "-wal", "-shm"} {
		if _, err := os.Lstat(path + suffix); err == nil {
			return DoctorCoordinatorDiagnostic{Kind: "unsafe", Path: path, Reason: "the coordinator has an active SQLite " + suffix[1:] + " sidecar"}
		}
	}
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro&immutable=1")
	if err != nil {
		return DoctorCoordinatorDiagnostic{Kind: "unreadable", Path: path, Reason: err.Error()}
	}
	defer db.Close()
	var version int
	if err = db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return DoctorCoordinatorDiagnostic{Kind: "unreadable", Path: path, Reason: err.Error()}
	}
	rows, err := db.Query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
	if err != nil {
		return DoctorCoordinatorDiagnostic{Kind: "unreadable", Path: path, Reason: err.Error()}
	}
	var tables []string
	for rows.Next() {
		var n string
		if rows.Scan(&n) != nil {
			rows.Close()
			return DoctorCoordinatorDiagnostic{Kind: "unreadable", Path: path, Reason: "the coordinator database cannot be inspected"}
		}
		tables = append(tables, n)
	}
	rows.Close()
	d := DoctorCoordinatorDiagnostic{Path: path, Version: version, Size: before.Size(), Tables: tables}
	if version == 0 {
		if len(tables) == 0 {
			z := 0
			d.TransitionRows = &z
			d.SingletonRows = &z
			d.Kind = "unversioned-empty"
		} else {
			d.Kind = "unversioned-nonempty"
		}
	} else if version != 1 {
		d.Kind = "unsupported"
	} else if len(tables) != 1 || tables[0] != "codex_transition_state" {
		if len(tables) == 0 {
			d.Kind = "rowless"
		} else {
			d.Kind = "unreadable"
			d.Reason = "the coordinator contains unexpected tables"
		}
	} else {
		var total int
		var singleton sql.NullInt64
		if err := db.QueryRow("SELECT count(*), sum(CASE WHEN singleton = 1 THEN 1 ELSE 0 END) FROM codex_transition_state").Scan(&total, &singleton); err != nil {
			d.Kind = "unreadable"
			d.Reason = "the transition table schema is not recognized"
		} else {
			single := int(singleton.Int64)
			d.TransitionRows = &total
			d.SingletonRows = &single
			if total == 0 {
				d.Kind = "rowless"
			} else if total != 1 || single != 1 {
				d.Kind = "unreadable"
				d.Reason = "the coordinator does not contain exactly one singleton row"
			} else {
				d.Kind = "ready"
			}
		}
	}
	after, err := os.Lstat(path)
	if err != nil || !os.SameFile(before, after) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		return DoctorCoordinatorDiagnostic{Kind: "changed", Path: path}
	}
	if before.Size() == 0 && d.Kind == "unversioned-empty" {
		d.Kind = "zero-byte"
	}
	return d
}

// RecoverZeroByteCodexCoordinator moves only a coordinator that continues to
// satisfy the TypeScript zero-byte recovery evidence transaction.
func RecoverZeroByteCodexCoordinator(now time.Time) (string, error) {
	observed := CollectDoctorCoordinator()
	if observed.Kind != "zero-byte" {
		if observed.Kind == "unsafe" || observed.Kind == "unreadable" {
			return "", fmt.Errorf("coordinator state is %s: %s", observed.Kind, observed.Reason)
		}
		return "", fmt.Errorf("coordinator state is %s, not a recoverable zero-byte remnant", observed.Kind)
	}
	path := observed.Path
	before, err := os.Lstat(path)
	if err != nil {
		return "", fmt.Errorf("the coordinator changed before recovery acquired its SQLite lock")
	}
	db, err := sql.Open("sqlite", "file:"+path+"?mode=rw")
	if err != nil {
		return "", doctorCoordinatorRecoveryError(err)
	}
	locked := false
	defer func() {
		if locked {
			_, _ = db.Exec("ROLLBACK")
		}
		_ = db.Close()
	}()
	if _, err = db.Exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE"); err != nil {
		return "", doctorCoordinatorRecoveryError(err)
	}
	locked = true
	underLock, err := os.Lstat(path)
	if err != nil || !underLock.Mode().IsRegular() || !os.SameFile(before, underLock) || before.Size() != underLock.Size() {
		return "", fmt.Errorf("the coordinator changed before recovery acquired its SQLite lock")
	}
	if underLock.Size() != 0 {
		return "", fmt.Errorf("the coordinator stopped being zero-byte before recovery")
	}
	if _, err = db.Exec("ROLLBACK"); err != nil {
		return "", doctorCoordinatorRecoveryError(err)
	}
	locked = false
	if err = db.Close(); err != nil {
		return "", doctorCoordinatorRecoveryError(err)
	}

	// Repeat the immutable inspection (including private-file and sidecar
	// checks) after releasing SQLite, then revalidate full identity.
	final := CollectDoctorCoordinator()
	if final.Kind != "zero-byte" || final.Path != path {
		return "", fmt.Errorf("the coordinator changed before the backup move")
	}
	finalInfo, err := os.Lstat(path)
	if err != nil || !doctorSameFullFileIdentity(underLock, finalInfo) {
		return "", fmt.Errorf("the coordinator changed before the backup move")
	}
	backup := path + ".zero-byte-backup-" + now.UTC().Format("20060102T150405.000Z")
	if _, err := os.Lstat(backup); err == nil {
		return "", fmt.Errorf("the same-directory backup path already exists")
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.Rename(path, backup); err != nil {
		return "", err
	}
	backupInfo, err := os.Lstat(backup)
	if err != nil || !backupInfo.Mode().IsRegular() || !os.SameFile(finalInfo, backupInfo) || finalInfo.Size() != backupInfo.Size() {
		return "", fmt.Errorf("the coordinator backup move could not be verified")
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		return "", fmt.Errorf("the coordinator backup move could not be verified")
	}
	return backup, nil
}

func doctorCoordinatorRecoveryError(err error) error {
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "database is locked") || strings.Contains(message, "database table is locked") || strings.Contains(message, "sqlite_busy") || strings.Contains(message, "sqlite_locked") {
		return fmt.Errorf("the coordinator is busy; stop active sync/service writers and retry")
	}
	return err
}

func FormatDoctorCoordinator(d DoctorCoordinatorDiagnostic) []string {
	path := []string{}
	if d.Path != "" {
		path = []string{"       path: " + d.Path}
	}
	evidence := []string{}
	if d.Kind != "absent" && d.Kind != "changed" && d.Kind != "unsafe" {
		tables := "none"
		if len(d.Tables) > 0 {
			tables = strings.Join(d.Tables, ", ")
		}
		tr, sr := "not inspected", "not inspected"
		if d.TransitionRows != nil {
			tr = fmt.Sprint(*d.TransitionRows)
		}
		if d.SingletonRows != nil {
			sr = fmt.Sprint(*d.SingletonRows)
		}
		evidence = []string{fmt.Sprintf("       size: %d bytes; user_version: %d", d.Size, d.Version), "       tables: " + tables, "       transition rows: " + tr + "; singleton=1 rows: " + sr}
	}
	first := ""
	switch d.Kind {
	case "absent":
		first = "  ok     native-write coordinator not created yet"
	case "ready":
		first = "  ok     native-write coordinator has an authoritative transition row"
	case "zero-byte":
		first = "  !!     native-write coordinator is a zero-byte remnant and has no authority"
	case "unversioned-empty":
		first = "  !!     native-write coordinator is a non-empty unversioned database; automatic recovery is refused"
	case "rowless":
		first = "  !!     native-write coordinator has schema version 1 but no authoritative row; automatic recovery is refused"
	case "unversioned-nonempty":
		first = "  !!     native-write coordinator is unversioned and contains unknown tables; automatic recovery is refused"
	case "unsupported":
		first = fmt.Sprintf("  !!     native-write coordinator schema version %d is unsupported; automatic recovery is refused", d.Version)
	case "changed":
		first = "  --     native-write coordinator changed during diagnosis; re-run ocx doctor"
	case "unsafe":
		first = "  !!     native-write coordinator path is unsafe: " + d.Reason
	default:
		first = "  !!     native-write coordinator is unreadable: " + d.Reason
	}
	out := append([]string{first}, path...)
	out = append(out, evidence...)
	if d.Kind == "zero-byte" {
		out = append(out, "       Action: stop the OpenCodex proxy/service, then run ocx doctor --recover-zero-byte-coordinator --yes")
	}
	return out
}
