package ocxcli

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
)

// This file is the Go mirror of src/config/process-state.ts (#34): it owns
// ocx.pid parsing, command-line identity, guarded runtime-record cleanup, and
// the byte-compatible state writes. The invariant carried over from
// TypeScript: a live PID alone proves nothing — the OS can recycle it — so
// destructive callers must additionally verify the process command line.

// pidFileMaxValue bounds parsePidFile output like parsePidFile's safe-integer
// gate in TypeScript (2^53, exclusive — 9007199254740992 itself fails
// Number.isSafeInteger only above, so the bound is 2^53-1): a wider int64
// would otherwise accept values the pid-file writer can never have produced.
const pidFileMaxValue = int64(1)<<53 - 1

// jsWhitespace matches ECMAScript's String.prototype.trim and regex \\s
// whitespace exactly. In particular, U+0085 and U+001C..U+001F are not
// JavaScript whitespace even though some Go Unicode helpers classify them as
// space characters.
func jsWhitespace(r rune) bool {
	switch {
	case r >= 0x0009 && r <= 0x000D:
		return true
	case r == 0x0020 || r == 0x00A0 || r == 0x1680:
		return true
	case r >= 0x2000 && r <= 0x200A:
		return true
	case r == 0x2028 || r == 0x2029 || r == 0x202F || r == 0x205F || r == 0x3000 || r == 0xFEFF:
		return true
	default:
		return false
	}
}

func trimJS(raw string) string {
	start := 0
	for start < len(raw) {
		r, size := utf8.DecodeRuneInString(raw[start:])
		if !jsWhitespace(r) {
			break
		}
		start += size
	}
	end := len(raw)
	for end > start {
		r, size := utf8.DecodeLastRuneInString(raw[:end])
		if !jsWhitespace(r) {
			break
		}
		end -= size
	}
	return raw[start:end]
}

// parsePidFile mirrors parsePidFile in src/config/process-state.ts: strictly
// decimal digits (after JavaScript trim), a positive safe integer, and nothing
// else. A leading sign, decimal point, inner whitespace, or U+0085 makes the
// file invalid rather than best-effort parsed.
func parsePidFile(raw string) int64 {
	trimmed := trimJS(raw)
	if len(trimmed) == 0 {
		return 0
	}
	for _, r := range trimmed {
		if r < '0' || r > '9' {
			return 0
		}
	}
	pid, err := strconv.ParseInt(trimmed, 10, 64)
	if err != nil || pid <= 0 || pid > pidFileMaxValue {
		return 0
	}
	return pid
}

// ParsePIDFile exposes the production parser to the differential oracle. A
// zero result has the same null meaning as TypeScript's parsePidFile.
func ParsePIDFile(raw string) int64 { return parsePidFile(raw) }

// readPidFileValue is readPidFileValue in TypeScript: the raw parsed value
// with no liveness or identity check. Discovery-only.
func readPidFileValue(path string) int64 {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	return parsePidFile(string(raw))
}

// readIdentityCheckedPID mirrors TypeScript's readPid: a PID is returned only
// when it is alive and its command line identifies an OpenCodex start process.
// Command-line inspection remains fail-open when unavailable for compatibility
// with locked-down hosts.
func readIdentityCheckedPID(path string, inspector processInspector) int64 {
	pid := readPidFileValue(path)
	if pid == 0 || !inspector.Alive(int(pid)) {
		return 0
	}
	command, err := inspector.Command(int(pid))
	if err == nil && !isOcxStartCommandLine(command) {
		return 0
	}
	return pid
}

// isOcxStartCommandLine accepts source launches, package launches, and the
// installed ocx/opencodex command, but requires `start` as a separate argument.
// The executable marker must appear as a real token (path segment, package path,
// npm rename directory, or standalone command word), not as a substring of a
// test or builder path; `start` must appear as a standalone word — not as a
// substring of start-guard/test paths.
func isOcxStartCommandLine(commandLine string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(commandLine, "\\", "/"))
	hasOcxEntrypoint := strings.Contains(normalized, "src/cli.ts") ||
		strings.Contains(normalized, "src/cli/index.ts") ||
		strings.Contains(normalized, "@bitkyc08/opencodex") ||
		strings.Contains(normalized, "@bitkyc08/.opencodex-") ||
		hasStandaloneOcxWord(normalized)
	return hasOcxEntrypoint && hasStandaloneStartWord(normalized)
}

// IsOcxStartCommandLine exposes the production identity matcher to the
// differential oracle without duplicating its security-sensitive logic.
func IsOcxStartCommandLine(commandLine string) bool { return isOcxStartCommandLine(commandLine) }

// hasStandaloneOcxWord matches /(?:^|[\s/"'])(?:ocx|opencodex)(?:\.cmd)?(?:$|[\s"'])/
// from TypeScript: `ocx`/`opencodex` optionally with the .cmd extension, as a
// whole word separated by start/end, whitespace, slash, or quote.
func hasStandaloneOcxWord(normalized string) bool {
	for offset := 0; offset < len(normalized); {
		ocxIndex := strings.Index(normalized[offset:], "ocx")
		opencodexIndex := strings.Index(normalized[offset:], "opencodex")
		index := -1
		word := ""
		switch {
		case ocxIndex < 0 && opencodexIndex < 0:
			return false
		case ocxIndex < 0 || (opencodexIndex >= 0 && opencodexIndex < ocxIndex):
			index, word = opencodexIndex+offset, "opencodex"
		default:
			index, word = ocxIndex+offset, "ocx"
		}
		// The shorter spelling is contained in opencodex; skip it unless the
		// candidate really starts and ends as a standalone token.
		if wordBoundaryBefore(normalized, index) {
			end := index + len(word)
			if strings.HasPrefix(normalized[end:], ".cmd") {
				end += len(".cmd")
			}
			if wordBoundaryAfter(normalized, end) {
				return true
			}
		}
		offset = index + len(word)
	}
	return false
}

func previousRune(text string, index int) (rune, bool) {
	if index <= 0 {
		return 0, false
	}
	r, size := utf8.DecodeLastRuneInString(text[:index])
	return r, size > 0
}

func nextRune(text string, index int) (rune, bool) {
	if index >= len(text) {
		return 0, false
	}
	r, _ := utf8.DecodeRuneInString(text[index:])
	return r, true
}

// wordBoundaryBefore matches the left side of the ocx/opencodex regex. The
// executable token additionally allows a slash before it; start does not.
func wordBoundaryBefore(text string, index int) bool {
	if index == 0 {
		return true
	}
	r, ok := previousRune(text, index)
	return ok && (jsWhitespace(r) || r == '/' || r == '"' || r == '\'')
}

func wordBoundaryAfter(text string, index int) bool {
	if index >= len(text) {
		return true
	}
	r, ok := nextRune(text, index)
	return ok && (jsWhitespace(r) || r == '"' || r == '\'')
}

// startBoundaryBefore matches the left side of the TypeScript start regex.
// Keep slash out: `ocx /start` must not be accepted.
func startBoundaryBefore(text string, index int) bool {
	if index == 0 {
		return true
	}
	r, ok := previousRune(text, index)
	return ok && (jsWhitespace(r) || r == '"' || r == '\'')
}

// hasStandaloneStartWord mirrors /(?:^|[\s"'])start(?:$|[\s"'])/: `start` as a
// whole word. Note the TypeScript class deliberately excludes `/` on the right
// side — `ocx start-guard` must not match.
func hasStandaloneStartWord(normalized string) bool {
	for offset := 0; offset < len(normalized); {
		index := strings.Index(normalized[offset:], "start")
		if index < 0 {
			return false
		}
		index += offset
		if startBoundaryBefore(normalized, index) && wordBoundaryAfter(normalized, index+len("start")) {
			return true
		}
		offset = index + len("start")
	}
	return false
}

// removePidIfValueIs is removePidIfValueIs in TypeScript: deletion is
// authorized only by the exact value observed before an in-flight probe, so a
// replacement runtime that rewrote the pid file mid-probe keeps its state.
func removePidIfValueIs(path string, snapshot int64) {
	if _, err := os.Stat(path); err != nil {
		return
	}
	if readPidFileValue(path) != snapshot {
		return
	}
	_ = os.Remove(path)
}

// removeRuntimePortIfPidIs mirrors TypeScript's null snapshot semantics:
// malformed or missing current records compare as null, so an unreadable
// record is removed when the caller also snapshotted it as unreadable.
func removeRuntimePortIfPidIs(path string, snapshotPid int64) {
	record, err := readStatusRuntimeRecordAt(path)
	currentPid := int64(0)
	if err == nil {
		currentPid = record.PID
	}
	if currentPid != snapshotPid {
		return
	}
	_ = os.Remove(path)
}

// readStatusRuntimeRecordAt parses a runtime-port.json at an explicit path
// with ReadStatusRuntime's validation, so the snapshot guards above can key
// on the record's pid without re-resolving the config directory.
func readStatusRuntimeRecordAt(path string) (StatusRuntimeRecord, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return StatusRuntimeRecord{}, err
	}
	var record StatusRuntimeRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		return StatusRuntimeRecord{}, err
	}
	if record.PID <= 0 || record.Port < 1 || record.Port > 65535 {
		return StatusRuntimeRecord{}, errors.New("invalid runtime record")
	}
	return record, nil
}

// removeRuntimeRecordsFor clears this runtime's records only when they still
// name expectedPid, mirroring removePid(expectedPid)+removeRuntimePort(pid).
// Callers that hold no identity (expectedPid 0) fall back to the old
// unconditional removal, which remains correct for the error paths of
// newStandaloneServer where no other runtime can have written yet.
func removeRuntimeRecordsFor(home string, expectedPid int64) error {
	pidPath := filepath.Join(home, "ocx.pid")
	runtimePath := filepath.Join(home, "runtime-port.json")
	if expectedPid > 0 {
		removePidIfValueIs(pidPath, expectedPid)
		removeRuntimePortIfPidIs(runtimePath, expectedPid)
		return nil
	}
	for _, path := range []string{pidPath, runtimePath} {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// writeStateFileAtomic mirrors atomicWriteFile's core contract for process
// state: a hardened 0600 temp sibling, fsync, then rename over the target. It
// publishes exactly payload bytes (writePid writes no trailing newline in
// TypeScript, so neither may this).
func writeStateFileAtomic(path string, payload []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(path), ".ocx-state-*")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer os.Remove(name)
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(payload); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
