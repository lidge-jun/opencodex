package ocxcli

import (
	"crypto/sha256"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

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
