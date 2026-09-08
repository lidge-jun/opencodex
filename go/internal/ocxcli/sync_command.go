package ocxcli

// ocx sync / ocx sync-cache — native catalog-refresh flip (issue #50).
//
// This file ports the deterministic core of the TypeScript command runners
// (src/cli/dispatch.ts "sync" and "sync-cache") so both commands dispatch
// natively in the Go binary:
//
//   - runSync reproduces every terminal state byte-identically: client-state
//     refusals, the injection preflight failure when CODEX_HOME/config.toml is
//     absent (ON), and the catalog-only "no source" skip (OFF). A state that
//     would require the full provider-discovery refresh (a readable catalog
//     source, a present config.toml, or a connected client) falls back to the
//     TypeScript engine through the existing Delegate seam, because that
//     engine's output is environment-bound (live provider fetches, the bundled
//     Codex runtime subprocess) and cannot be re-implemented byte-faithfully.
//
//   - runSyncCache is fully native: every outcome is a pure function of files
//     on disk and the config toggle. It mirrors the K write-lock acquisition
//     (withCatalogWriteSerialization), the OFF/contended/no-catalog taxonomy,
//     the V8-exact --json envelope, and the on-disk models_cache bytes
//     (JSON.stringify(v, null, 2) over the parsed catalog models), so a cache
//     written by the Go CLI is byte-compatible with one the TS CLI writes and
//     rollback stays possible.
//
// The post-write app-server warning/restart path (src/codex/app-server-processes.ts)
// is ported for Linux /proc enumeration and treated as a no-op elsewhere; in a
// fixture environment no Codex app-server processes run, so both runtimes are
// silent there.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// printSubcommandHelp bodies for the flipped commands. Both spellings (`ocx
// help sync`, `ocx sync --help`) share one TS text; the bytes are pinned below.
const syncHelpText = `Usage: ocx sync [--restart-codex] [--restart-desktop-app]

Fetch provider models and inject them into Codex config.

After writing the catalog, warns if long-lived Codex app-server processes are still running.
--restart-codex sends SIGTERM only to matching app-server / code-mode-host processes (may interrupt active turns).
--restart-desktop-app (Windows only, opt-in) fully restarts the Codex desktop app so its model picker re-reads the catalog. Never implied by --restart-codex: it ends live conversations.
`

const syncCacheHelpText = `Usage: ocx sync-cache [--restart-codex] [--restart-desktop-app]

Refresh Codex's model cache from the active catalog.

Warns when Codex app-server processes still hold an in-memory model list.
--restart-codex sends SIGTERM only to matching app-server / code-mode-host processes (may interrupt active turns).
--restart-desktop-app (Windows only, opt-in) fully restarts the Codex desktop app so its model picker re-reads the catalog. Never implied by --restart-codex: it ends live conversations.
`

const syncSkipWarning = "catalog sync skipped: no Codex catalog source found; keeping Codex's native catalog."

const syncCacheOffNoWrite = "Codex integration is OFF; no catalog or cache write resulted."
const syncCacheNoCatalog = "No Codex catalog to derive a cache from; nothing to sync."
const syncCacheBusy = "Another process owns the catalog write; cache sync skipped."
const syncCacheWroteNot = "The Codex model cache was not rewritten."
const syncCacheDesktopWindowsOnly = "--restart-desktop-app is supported on Windows only; nothing was stopped."
const syncDidNotComplete = "Codex sync did not complete. Fix the reported Codex config issue and retry."

// ─────────────────────────────────────────────────────────────────────────────
// Client connection state (src/client/state.ts readClientConnectionState).

type syncClientConnectionState struct {
	kind   string // disconnected | connected | invalid | mismatched
	reason string
}

// readSyncRawConfig mirrors rawTopLevelConfig in src/client/state.ts: the file
// must parse to a JSON object (a top-level null/array is unreadable, matching
// the TS `typeof parsed === "object" && !Array.isArray(parsed)` test). A
// missing file and an unparseable one are deliberately not distinguished here;
// readSyncClientState decides which one is "disconnected" vs "invalid" by
// checking existence, exactly like diagnostics.source does in TS.
func readSyncRawConfig() (map[string]any, bool) {
	path, err := config.Path()
	if err != nil {
		return nil, false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var value any
	if json.Unmarshal(bytesTrimBOM(raw), &value) != nil {
		return nil, false
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	return object, true
}

func bytesTrimBOM(raw []byte) []byte {
	if len(raw) >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF {
		return raw[3:]
	}
	return raw
}

func stringKey(raw map[string]any, key string) (string, bool) {
	value, ok := raw[key]
	if !ok {
		return "", false
	}
	text, ok := value.(string)
	return text, ok
}

func mapKey(raw map[string]any, key string) (map[string]any, bool) {
	value, ok := raw[key]
	if !ok {
		return nil, false
	}
	m, ok := value.(map[string]any)
	return m, ok
}

func readSyncClientState() syncClientConnectionState {
	raw, ok := readSyncRawConfig()
	if !ok {
		// rawTopLevelConfig returned null; readConfigDiagnostics answers "default"
		// only when config.json is absent, so a present-but-unreadable file is the
		// same invalid state TS reports.
		path, err := config.Path()
		if err != nil {
			return syncClientConnectionState{kind: "disconnected"}
		}
		if _, statErr := os.Stat(path); os.IsNotExist(statErr) {
			return syncClientConnectionState{kind: "disconnected"}
		}
		return syncClientConnectionState{kind: "invalid", reason: "config.json is missing or unreadable"}
	}
	_, hasClient := raw["client"]
	role, hasRole := stringKey(raw, "runtimeRole")
	// TS: any present non-null runtimeRole that is not one of the three roles is
	// invalid — including a non-string value, which hasRole reports as absent.
	if value, present := raw["runtimeRole"]; present && value != nil {
		if !hasRole || (role != "standalone" && role != "hub" && role != "client") {
			return syncClientConnectionState{kind: "invalid", reason: "config.json.runtimeRole is invalid"}
		}
	}
	if !hasClient {
		// A hub is a server role, not a broken client: without client state it
		// simply is not connected. role == "" here means runtimeRole is absent
		// (a present empty string was already rejected as invalid above).
		if role == "" || role == "standalone" || role == "hub" {
			return syncClientConnectionState{kind: "disconnected"}
		}
	}
	if !hasClient || role != "client" {
		if hasClient {
			return syncClientConnectionState{kind: "mismatched", reason: "config.json.client is present without runtimeRole=client"}
		}
		return syncClientConnectionState{kind: "mismatched", reason: "runtimeRole=client is present without config.json.client"}
	}
	return syncClientConnectionState{kind: "connected"}
}

// shouldSyncCodexOnStart mirrors src/codex/desired-state.ts: absent codex toggle
// means ON; only an explicit false is OFF; a hub without an enabled loopback
// listener never syncs its own host's Codex.
func shouldSyncCodexOnStart(raw map[string]any) bool {
	codexEnabled := true
	if ci, ok := mapKey(raw, "clientIntegrations"); ok {
		if disabled, present := ci["codex"]; present {
			if value, isBool := disabled.(bool); isBool {
				codexEnabled = value
			} else {
				codexEnabled = true
			}
		}
	}
	role, _ := stringKey(raw, "runtimeRole")
	if role == "hub" {
		loopbackEnabled := false
		if listener, ok := mapKey(raw, "unauthenticatedLoopbackListener"); ok {
			if enabled, present := listener["enabled"]; present {
				if value, isBool := enabled.(bool); isBool {
					loopbackEnabled = value
				}
			}
		}
		if !loopbackEnabled {
			return false
		}
	}
	return codexEnabled
}

// ─────────────────────────────────────────────────────────────────────────────
// Codex home and catalog path resolution (src/codex/paths.ts + catalog/parsing.ts).

// syncCodexHome mirrors getCodexHome(): when CODEX_HOME is set the path must
// exist as a directory and is canonicalized with realpath; otherwise the
// default ~/.codex is used (WSL detection is left to the TS owner).
func syncCodexHome() (string, error) {
	raw := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if raw != "" {
		path := expandUserPath(raw)
		info, err := os.Stat(path)
		if err != nil {
			return "", fmt.Errorf("CODEX_HOME points to %s, but that path could not be read: %v", raw, err)
		}
		if !info.IsDir() {
			return "", fmt.Errorf("CODEX_HOME points to %s, but that path is not a directory", raw)
		}
		real, err := filepath.EvalSymlinks(path)
		if err != nil {
			return "", fmt.Errorf("CODEX_HOME points to %s, but that path could not be read: %v", raw, err)
		}
		return real, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".codex"), nil
}

func expandUserPath(raw string) string {
	if raw == "~" {
		if home, err := os.UserHomeDir(); err == nil {
			return home
		}
		return raw
	}
	if strings.HasPrefix(raw, "~/") || strings.HasPrefix(raw, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, raw[2:])
		}
		return raw
	}
	return raw
}

// rootTomlStringValue is the tolerant root-key reader used by the TS side
// (readRootTomlString in src/codex/paths.ts): only lines before the first
// [table] header are scanned, and the value must be a quoted string.
var rootTomlStringRe = regexp.MustCompile(`^\s*(model_catalog_json)\s*=\s*("(?:\\\\.|[^"])*"|'[^']*')`)

func readRootTomlString(content, key string) (string, bool) {
	lines := strings.Split(content, "\n")
	for _, line := range lines {
		if match := rootTomlStringRe.FindStringSubmatch(line); match != nil && match[1] == key {
			raw := match[2]
			if strings.HasPrefix(raw, `"`) {
				var parsed string
				if err := json.Unmarshal([]byte(raw), &parsed); err == nil {
					return parsed, true
				}
				return raw[1 : len(raw)-1], true
			}
			return raw[1 : len(raw)-1], true
		}
		if regexp.MustCompile(`^\s*\[`).MatchString(line) {
			break
		}
	}
	return "", false
}

// readCodexCatalogPathForHome mirrors readCodexCatalogPathForHome: the root
// model_catalog_json in <home>/config.toml wins (resolved against home), else
// <home>/opencodex-catalog.json.
func readCodexCatalogPathForHome(codexHome string) string {
	configPath := filepath.Join(codexHome, "config.toml")
	if raw, err := os.ReadFile(configPath); err == nil {
		if path, ok := readRootTomlString(string(raw), "model_catalog_json"); ok {
			if path == "" {
				return filepath.Join(codexHome, "opencodex-catalog.json")
			}
			if filepath.IsAbs(path) {
				return filepath.Clean(path)
			}
			return filepath.Join(codexHome, path)
		}
	}
	return filepath.Join(codexHome, "opencodex-catalog.json")
}

func isDefaultCodexCatalogPath(codexHome, catalogPath string) bool {
	return filepath.Clean(catalogPath) == filepath.Join(codexHome, "opencodex-catalog.json")
}

// readCatalog mirrors readCatalog/parseCatalogJson in parsing.ts: a file whose
// content parses to an object with a models array. The raw bytes are returned
// too so the cache writer can re-serialize parsed values exactly like V8.
func readCatalog(path string) (*jsonwire.Value, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	value, err := jsonwire.Parse(raw)
	if err != nil {
		return nil, false
	}
	if value.Kind() == jsonwire.Object {
		if models := value.Find("models"); models != nil && models.Kind() == jsonwire.Array {
			return value, true
		}
	}
	return nil, false
}

// syncCatalogConfigDir is getConfigDir() — where catalog backups live.
func syncCatalogConfigDir() string {
	dir, err := config.Dir()
	if err != nil {
		return ""
	}
	return dir
}

func catalogBackupPathFor(catalogPath string) string {
	normalized := filepath.Clean(catalogPath)
	if runtime.GOOS == "windows" {
		normalized = strings.ToLower(normalized)
	}
	sum := sha256.Sum256([]byte(normalized))
	id := hex.EncodeToString(sum[:])[:16]
	return filepath.Join(syncCatalogConfigDir(), "catalog-backup-"+id+".json")
}

func legacyCatalogBackupPath() string {
	return filepath.Join(syncCatalogConfigDir(), "catalog-backup.json")
}

// syncDerivableOnDiskSource reports whether loadCatalogForRetainedSync would find
// a readable catalog/backup/cache file (the bundled Codex runtime is excluded;
// see runSync for how that machine-dependence is handled).
func syncDerivableOnDiskSource(codexHome, catalogPath string) bool {
	if active, _ := readCatalog(catalogPath); active != nil {
		return true
	}
	if _, ok := readCatalog(catalogBackupPathFor(catalogPath)); ok {
		return true
	}
	if isDefaultCodexCatalogPath(codexHome, catalogPath) {
		if _, ok := readCatalog(legacyCatalogBackupPath()); ok {
			return true
		}
	}
	if _, ok := readCatalog(filepath.Join(codexHome, "models_cache.json")); ok {
		return true
	}
	return false
}

func syncPathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// ─────────────────────────────────────────────────────────────────────────────
// ocx sync runner (src/cli/dispatch.ts "sync" + src/codex/sync.ts).

func runSync(args []string, deps Deps) int {
	// --restart-codex / --restart-desktop-app only affect the post-write
	// app-server / desktop-app handling, which runs on the TS refresh engine for
	// the states that reach runSync's delegation branch. The flags are consumed
	// there (runSync passes args through verbatim); no parsing is needed here.
	state := readSyncClientState()
	if state.kind == "invalid" || state.kind == "mismatched" {
		fmt.Fprintf(deps.Stderr, "Client state is %s: %s\n", state.kind, state.reason)
		return ExitFailure
	}
	if state.kind == "connected" {
		// Remote (hub) sync writes through the client connection journal; keep
		// that TypeScript-owned transaction intact.
		return runSyncDelegate(args, deps)
	}

	codexHome, err := syncCodexHome()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	raw := loadRawConfigSafe()
	desiredDisabled := !shouldSyncCodexOnStart(raw)

	if !desiredDisabled {
		// Injection path. The deterministic terminal state is the missing
		// config.toml preflight failure; any present config.toml routes to the
		// full refresh engine (provider discovery + Codex runtime).
		configPath := filepath.Join(codexHome, "config.toml")
		if _, statErr := os.Stat(configPath); os.IsNotExist(statErr) {
			runSyncPreflightFailed(deps, codexHome)
			return ExitFailure
		}
		return runSyncDelegate(args, deps)
	}

	// Catalog-only path (explicit sync with the integration OFF). TS derives a
	// retained catalog source from (in order) the bundled Codex runtime catalog
	// (default path only), the active catalog file, its backup, the legacy backup,
	// and models_cache.json. A source means the TS engine refreshes provider
	// models and rewrites the catalog/cache, whose output is environment-bound.
	//
	// The only byte-deterministic skip state is a CUSTOM model_catalog_json path
	// (never the bundled source) with no readable on-disk source: there the TS
	// runner returns before any provider or Codex-runtime work. On the default
	// path the bundled Codex runtime subprocess decides skip-vs-refresh, so the
	// refresh engine handles those states.
	catalogPath := readCodexCatalogPathForHome(codexHome)
	if syncDerivableOnDiskSource(codexHome, catalogPath) || isDefaultCodexCatalogPath(codexHome, catalogPath) {
		return runSyncDelegate(args, deps)
	}
	if !syncPathExists(catalogPath) {
		fmt.Fprintln(deps.Stderr, syncSkipWarning)
	}
	fmt.Fprintln(deps.Stdout, "Codex integration is OFF; catalog refresh skipped, Codex config untouched.")
	return ExitOK
}

func runSyncDelegate(args []string, deps Deps) int {
	// Delegate expects the full user argv (command name included), exactly like
	// the TypeScriptOwned seam: runDelegated forwards argv unchanged.
	full := append([]string{"sync"}, args...)
	code, err := deps.Delegate(full)
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	return code
}

// runSyncPreflightFailed mirrors the injectCodexConfig(validateOnly) refusal and
// reportCodexHomeTarget output for the missing-config.toml terminal.
func runSyncPreflightFailed(deps Deps, codexHome string) {
	fmt.Fprintf(deps.Stderr, "Codex config not found at %s/config.toml. Is Codex installed?\n", codexHome)
	fmt.Fprintf(deps.Stdout, "   Target Codex home: %s\n", codexHome)
	fmt.Fprintln(deps.Stderr, syncDidNotComplete)
}

func loadRawConfigSafe() map[string]any {
	raw, _ := readSyncRawConfig()
	if raw == nil {
		return map[string]any{}
	}
	return raw
}

// ─────────────────────────────────────────────────────────────────────────────
// ocx sync-cache runner (src/cli/dispatch.ts "sync-cache").

func runSyncCache(args []string, deps Deps) int {
	restartCodex := syncHasArg(args, "--restart-codex")
	restartDesktopApp := syncHasArg(args, "--restart-desktop-app")
	cacheJSON := syncHasArg(args, "--json")

	codexHome, err := syncCodexHome()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	desiredDisabled := !shouldSyncCodexOnStart(loadRawConfigSafe())

	kind, reason, wrote := withCatalogWriteSerialization(codexHome, func() bool {
		return invalidateCodexModelsCacheWithPermit(codexHome, true)
	})

	// Only warn/restart when models_cache was actually rewritten from a readable
	// catalog; --json keeps every post-write notice on stderr beside the envelope.
	if kind == "completed" && wrote {
		afterCatalogWriteHandleAppServers(deps, restartCodex, cacheJSON)
		if restartDesktopApp {
			handleSyncDesktopAppRestart(deps)
		}
	} else if desiredDisabled && !cacheJSON {
		fmt.Fprintln(deps.Stdout, syncCacheOffNoWrite)
	}

	contended := kind == "unavailable" && reason == "busy"
	noCatalog := !wrote && !syncPathExists(readCodexCatalogPathForHome(codexHome))
	ok := wrote || contended || noCatalog

	if cacheJSON {
		syncPrintCacheEnvelope(deps.Stdout, ok, wrote, contended, noCatalog, kind, reason, desiredDisabled, codexHome)
	} else if contended {
		fmt.Fprintln(deps.Stdout, syncCacheBusy)
	} else if noCatalog {
		fmt.Fprintln(deps.Stdout, syncCacheNoCatalog)
	} else if !ok {
		fmt.Fprintf(deps.Stderr, "Cache refresh did not complete (%s). %s\n", kind, syncCacheWroteNot)
	}
	if ok {
		return ExitOK
	}
	return ExitFailure
}

func syncPrintCacheEnvelope(w io.Writer, ok, wrote, contended, noCatalog bool, kind, reason string, desiredDisabled bool, codexHome string) {
	envelope := jsonwire.ObjectValue()
	envelope.Set("schemaVersion", jsonwire.NumberFrom(1))
	envelope.Set("ok", jsonwire.BoolValue(ok))
	envelope.Set("wrote", jsonwire.BoolValue(wrote))
	envelope.Set("skipped", jsonwire.BoolValue(contended || noCatalog))
	envelope.Set("outcome", jsonwire.StringValue(kind))
	if kind == "unavailable" {
		envelope.Set("reason", jsonwire.StringValue(reason))
	}
	if contended {
		envelope.Set("skippedReason", jsonwire.StringValue("contended"))
	} else if noCatalog {
		envelope.Set("skippedReason", jsonwire.StringValue("no_catalog"))
	}
	envelope.Set("desiredDisabled", jsonwire.BoolValue(desiredDisabled))
	envelope.Set("codexHome", jsonwire.StringValue(codexHome))
	var out strings.Builder
	if err := encodeIndentedJSONV8(&out, envelope, 0); err == nil {
		fmt.Fprintf(w, "%s\n", out.String())
	}
}

// invalidateCodexModelsCacheWithPermit mirrors invalidateCodexModelsCacheWithPermit
// in src/codex/catalog/sync.ts for the common (no account-picker) path: it
// rewrites models_cache.json from the parsed catalog's models array under the
// held K lock, or returns false when no catalog file exists or it cannot be
// parsed. Account-bound observed rows are only carried when the operator has
// configured a Codex account picker; that derivation stays with the TS owner.
func invalidateCodexModelsCacheWithPermit(owningCodexHome string, allowWhenDesiredDisabled bool) bool {
	if !shouldSyncCodexOnStart(loadRawConfigSafe()) && !allowWhenDesiredDisabled {
		return false
	}
	catalogPath := readCodexCatalogPathForHome(owningCodexHome)
	raw, err := os.ReadFile(catalogPath)
	if err != nil {
		return false
	}
	catalog, err := jsonwire.Parse(raw)
	if err != nil {
		return false
	}
	models := catalog
	if catalog.Kind() == jsonwire.Object {
		member := catalog.Find("models")
		if member == nil {
			return false
		}
		models = member
	}
	if models.Kind() != jsonwire.Array {
		return false
	}
	wrapper := jsonwire.ObjectValue()
	wrapper.Set("fetched_at", jsonwire.StringValue("2000-01-01T00:00:00Z"))
	wrapper.Set("client_version", jsonwire.StringValue("0.0.0"))
	modelsCopy := jsonwire.EmptyArray()
	for _, element := range models.Elements() {
		modelsCopy.AppendArray(element)
	}
	wrapper.Set("models", modelsCopy)
	var out strings.Builder
	if err := encodeIndentedJSONV8(&out, wrapper, 0); err != nil {
		return false
	}
	cachePath := filepath.Join(owningCodexHome, "models_cache.json")
	if err := atomicWriteJSON(cachePath, out.String()+"\n"); err != nil {
		return false
	}
	return true
}

// encodeIndentedJSONV8 renders a jsonwire value with ECMAScript
// JSON.stringify(v, null, 2) whitespace AND V8 number semantics (parsed raw
// literals re-formatted through the double), so cache bytes match the TS CLI
// even when the source catalog carries exotic number literals. The usage
// renderer keeps raw literals; catalog content passes through JSON.parse in TS.
func encodeIndentedJSONV8(out *strings.Builder, value *jsonwire.Value, depth int) error {
	switch value.Kind() {
	case jsonwire.Array:
		elements := value.Elements()
		if len(elements) == 0 {
			out.WriteString("[]")
			return nil
		}
		out.WriteString("[\n")
		for i, element := range elements {
			writeIndent(out, depth+1)
			if err := encodeIndentedJSONV8(out, element, depth+1); err != nil {
				return err
			}
			if i < len(elements)-1 {
				out.WriteByte(',')
			}
			out.WriteByte('\n')
		}
		writeIndent(out, depth)
		out.WriteByte(']')
	case jsonwire.Object:
		members := value.Members()
		if len(members) == 0 {
			out.WriteString("{}")
			return nil
		}
		out.WriteString("{\n")
		for i, member := range members {
			writeIndent(out, depth+1)
			quoted, err := jsonwire.EncodeString(member.Key)
			if err != nil {
				return err
			}
			out.Write(quoted)
			out.WriteString(": ")
			if err := encodeIndentedJSONV8(out, member.Value, depth+1); err != nil {
				return err
			}
			if i < len(members)-1 {
				out.WriteByte(',')
			}
			out.WriteByte('\n')
		}
		writeIndent(out, depth)
		out.WriteByte('}')
	case jsonwire.String:
		quoted, err := jsonwire.EncodeString(value.String())
		if err != nil {
			return err
		}
		out.Write(quoted)
	case jsonwire.Number:
		if parsed, err := strconv.ParseFloat(value.NumberRaw(), 64); err == nil {
			out.WriteString(jsonwire.FormatV8Number(parsed))
		} else {
			out.WriteString(value.NumberRaw())
		}
	case jsonwire.Bool:
		if value.Bool() {
			out.WriteString("true")
		} else {
			out.WriteString("false")
		}
	default:
		out.WriteString("null")
	}
	return nil
}

// atomicWriteJSON publishes cache content the way atomicWriteFile does in TS:
// a 0600 temp file in the destination directory renamed over the target, so
// the final file is 0600 and never partially visible.
func atomicWriteJSON(path, content string) error {
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, ".models_cache.json.ocx-tmp-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.WriteString(content); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempName, path)
}

func handleSyncDesktopAppRestart(deps Deps) {
	// restartCodexDesktopApp resolves windows_only outside win32 before any
	// process work, so this branch is byte-identical to TS on every non-Windows
	// host; the Windows desktop-app restart itself is not ported. The message is
	// an error both for the human logger and under --json (jsonSafeLog), so it
	// always lands on stderr.
	fmt.Fprintln(deps.Stderr, syncCacheDesktopWindowsOnly)
}

func syncHasArg(args []string, flag string) bool {
	for _, arg := range args {
		if arg == flag {
			return true
		}
	}
	return false
}

// runCatalogKHold is a deliberately undocumented test-only seam for the parity
// oracle: it resolves the same K database path sync-cache uses, acquires the
// write lock, prints a ready marker, and holds it until killed. It lets the
// differential harness prove that BOTH the TypeScript CLI and the Go binary
// observe a contended catalog write and report busy.
func runCatalogKHold(deps Deps) int {
	codexHome, err := syncCodexHome()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	databasePath, err := resolveCatalogWriteDatabasePath(codexHome)
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	release, err := acquireCatalogWriteLock(databasePath)
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	defer release()
	fmt.Fprintln(deps.Stdout, "HOLDING")
	// Hold K until killed. An empty select would trip the Go runtime's deadlock
	// detector (every goroutine blocked); a timer keeps the process alive.
	for {
		time.Sleep(time.Hour)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// K write-lock (src/codex/catalog-write-serialization.ts).

// withCatalogWriteSerialization acquires K for one canonical CODEX_HOME and
// runs write while it is held, mirroring the TS outcome vocabulary. The write
// callback performs no provider or subprocess work, exactly like its TS
// counterpart (sync-cache's callback only parses files and writes the cache).
var errCatalogWriteBusy = errors.New("catalog write lock is held by another process")
var errCatalogWriteUnsafe = errors.New("catalog write lock database is unsafe")

func withCatalogWriteSerialization(canonicalCodexHome string, write func() bool) (kind, reason string, value bool) {
	databasePath, err := resolveCatalogWriteDatabasePath(canonicalCodexHome)
	if err != nil {
		return "unavailable", "unsafe-path", false
	}

	release, err := acquireCatalogWriteLock(databasePath)
	if err != nil {
		if errors.Is(err, errCatalogWriteBusy) {
			return "unavailable", "busy", false
		}
		if errors.Is(err, errCatalogWriteUnsafe) {
			return "unavailable", "unsafe-path", false
		}
		return "unavailable", "database", false
	}
	defer release()

	value = write()
	return "completed", "", value
}
