package ocxcli

// Remote-hub client state surface (issue #52): `ocx connect status` and
// `ocx disconnect` run natively in the Go binary against the same on-disk
// client-connection state the TypeScript CLI owns. This file ports the state
// readers (src/client/state.ts, src/lib/service-secrets.ts); the command
// runners live in client_status.go and client_disconnect.go.
//
// Only the read surface (`connect status`) and the local teardown
// (`disconnect`) dispatch natively here. Establishing a connection
// (`ocx connect <url>`, rotate, revoke) stays TypeScript-owned: it talks to a
// remote hub over its machine-API protocol and runs the Codex config-injection
// transaction, neither of which has a Go-side implementation yet. This mirrors
// the `observe usage` precedent for flipping a subcommand surface ahead of the
// family.

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

// connectUsage and disconnectUsage mirror the TypeScript CONNECT_USAGE and
// DISCONNECT_USAGE blocks printed (via CliUsageError) on argument rejection.
const connectUsage = `Usage:
  ocx connect <url> [--management-url <url>]
      (--pairing-code-stdin | --admin-token-stdin)
      [--clients codex,claude] [--management-transport direct|relay]
      [--catalog-timeout <seconds>] [--no-sync]
  ocx connect status [--json]
  ocx connect rotate (--pairing-code-stdin | --admin-token-stdin)
      [--json]
  ocx connect revoke --admin-token-stdin [--json]`

const disconnectUsage = `Usage:
  ocx disconnect [--keep-catalog] [--json]`

// ocxSectionMarker is the ownership comment the Codex config injector places
// directly above the root keys it writes (# Auto-injected by opencodex).
const ocxSectionMarker = "# Auto-injected by opencodex"

const maxServiceAPITokenBytes = 4096

// clientConnectionKind classifies the persisted client state exactly like
// readClientConnectionState in src/client/state.ts.
type clientConnectionKind string

const (
	connectionDisconnected clientConnectionKind = "disconnected"
	connectionConnected    clientConnectionKind = "connected"
	connectionInvalid      clientConnectionKind = "invalid"
	connectionMismatched   clientConnectionKind = "mismatched"
)

type clientConnectionValue struct {
	ServerURL           string
	ManagementURL       string
	ManagementTransport string
	SelectedClients     []string
	TokenEnv            string
	APIKeyID            string
	TokenFingerprint    string
	ProtocolVersion     int
	ConnectedAt         string
	CatalogFingerprint  *string
	PriorCatalog        *string
	CatalogSyncedAt     *string
	PendingOperation    json.RawMessage
}

type clientConnectionState struct {
	kind   clientConnectionKind
	reason string
	value  *clientConnectionValue
}

func codexHomeFromEnv() (string, error) {
	raw := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if raw == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".codex"), nil
	}
	if raw == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return home, nil
	}
	if strings.HasPrefix(raw, "~/") || strings.HasPrefix(raw, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		raw = filepath.Join(home, raw[2:])
	}
	resolved := filepath.Clean(raw)
	info, err := os.Stat(resolved)
	if err != nil {
		return "", errors.New("CODEX_HOME points to " + raw + ", but that path could not be read: " + err.Error())
	}
	if !info.IsDir() {
		return "", errors.New("CODEX_HOME points to " + raw + ", but that path is not a directory")
	}
	// TypeScript resolves through realpathSync.native after the stat checks.
	if real, realErr := filepath.EvalSymlinks(resolved); realErr == nil {
		return real, nil
	}
	return resolved, nil
}

func codexConfigPath(codexHome string) string { return filepath.Join(codexHome, "config.toml") }
func codexProfilePath(codexHome string) string {
	return filepath.Join(codexHome, "opencodex.config.toml")
}
func defaultCatalogPath(codexHome string) string {
	return filepath.Join(codexHome, "opencodex-catalog.json")
}
func serviceAPITokenPath(dir string) string { return filepath.Join(dir, "service-api-token") }
func serviceAPITokenBackupPath(dir string) string {
	return serviceAPITokenPath(dir) + ".prev"
}
func journalPath(codexHome string) string {
	return filepath.Join(codexHome, "opencodex-journal.json")
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func sha256Base64URL(value string) string {
	sum := sha256.Sum256([]byte(value))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// readRawTopLevelConfig mirrors rawTopLevelConfig in src/client/state.ts:
// parse config.json (BOM tolerated); any failure yields nil.
func readRawTopLevelConfig() (map[string]any, bool) {
	path, err := config.Path()
	if err != nil {
		return nil, false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	text := strings.TrimPrefix(string(raw), "\uFEFF")
	var parsed any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		return nil, false
	}
	object, ok := parsed.(map[string]any)
	if !ok {
		return nil, false
	}
	return object, true
}

func configFileExists() bool {
	path, err := config.Path()
	if err != nil {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func decodeClientConnectionValue(raw any) (*clientConnectionValue, bool) {
	object, ok := raw.(map[string]any)
	if !ok {
		return nil, false
	}
	text := func(key string) (string, bool) {
		value, ok := object[key].(string)
		return value, ok
	}
	serverURL, _ := text("serverUrl")
	managementURL, _ := text("managementUrl")
	transport, _ := text("managementTransport")
	tokenEnv, _ := text("tokenEnv")
	apiKeyID, _ := text("apiKeyId")
	fingerprint, _ := text("tokenFingerprint")
	connectedAt, _ := text("connectedAt")
	value := &clientConnectionValue{
		ServerURL: serverURL, ManagementURL: managementURL, ManagementTransport: transport,
		TokenEnv: tokenEnv, APIKeyID: apiKeyID, TokenFingerprint: fingerprint, ConnectedAt: connectedAt,
	}
	if clients, ok := object["selectedClients"].([]any); ok {
		for _, item := range clients {
			if name, ok := item.(string); ok {
				value.SelectedClients = append(value.SelectedClients, name)
			}
		}
	}
	if protocol, ok := object["protocolVersion"].(float64); ok {
		value.ProtocolVersion = int(protocol)
	}
	if catalogFingerprint, ok := object["catalogFingerprint"].(string); ok {
		value.CatalogFingerprint = &catalogFingerprint
	}
	if prior, ok := object["priorCatalog"].(string); ok {
		value.PriorCatalog = &prior
	}
	if syncedAt, ok := object["catalogSyncedAt"].(string); ok {
		value.CatalogSyncedAt = &syncedAt
	}
	if pending, ok := object["pendingOperation"]; ok {
		rawPending, err := json.Marshal(pending)
		if err == nil {
			value.PendingOperation = rawPending
		}
	}
	return value, true
}

// readClientConnectionState mirrors readClientConnectionState in
// src/client/state.ts. Schema-invalid client blocks produce the same
// diagnostics warning wording (first zod issue path) via the validator in
// client_client_schema.go.
func readClientConnectionState() clientConnectionState {
	raw, ok := readRawTopLevelConfig()
	if !ok {
		if !configFileExists() {
			return clientConnectionState{kind: connectionDisconnected}
		}
		return clientConnectionState{kind: connectionInvalid, reason: "config.json is missing or unreadable"}
	}
	_, hasClient := raw["client"]
	hasClient = hasClient && raw["client"] != nil
	role := ""
	if value, present := raw["runtimeRole"]; present {
		roleText, isString := value.(string)
		if !isString {
			return clientConnectionState{kind: connectionInvalid, reason: "config.json.runtimeRole is invalid"}
		}
		role = roleText
	}
	if role != "" && role != "standalone" && role != "hub" && role != "client" {
		return clientConnectionState{kind: connectionInvalid, reason: "config.json.runtimeRole is invalid"}
	}
	if !hasClient && (role == "" || role == "standalone") {
		return clientConnectionState{kind: connectionDisconnected}
	}
	if !hasClient && role == "hub" {
		return clientConnectionState{kind: connectionDisconnected}
	}
	if !hasClient || role != "client" {
		if hasClient {
			return clientConnectionState{kind: connectionMismatched, reason: "config.json.client is present without runtimeRole=client"}
		}
		return clientConnectionState{kind: connectionMismatched, reason: "runtimeRole=client is present without config.json.client"}
	}
	value, ok := decodeClientConnectionValue(raw["client"])
	if issue, invalid := firstClientIssuePath(raw["client"]); invalid {
		reason := "client"
		if issue != "" {
			reason += "." + issue
		}
		reason += " invalid: remote client mode is disabled until config.json is repaired"
		return clientConnectionState{kind: connectionInvalid, reason: reason}
	}
	if !ok {
		return clientConnectionState{kind: connectionInvalid, reason: "config.json.client is malformed"}
	}
	return clientConnectionState{kind: connectionConnected, value: value}
}

// serviceTokenState mirrors ServiceApiTokenState in src/lib/service-secrets.ts.
type serviceTokenState struct {
	kind        string // absent | present | unsafe
	token       string
	fingerprint string
	reason      string
}

func readServiceAPITokenState(dir string) serviceTokenState {
	info, err := os.Lstat(serviceAPITokenPath(dir))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return serviceTokenState{kind: "absent"}
		}
		return serviceTokenState{kind: "unsafe", reason: "service token path could not be inspected"}
	}
	// existsSync follows the link in TypeScript: a dangling symlink reads as
	// absent there, so this state machine must not call it unsafe.
	if info.Mode()&os.ModeSymlink != 0 {
		if _, statErr := os.Stat(serviceAPITokenPath(dir)); statErr != nil {
			return serviceTokenState{kind: "absent"}
		}
		return serviceTokenState{kind: "unsafe", reason: "service token path is not a bounded regular file"}
	}
	if !info.Mode().IsRegular() || info.Size() > maxServiceAPITokenBytes {
		return serviceTokenState{kind: "unsafe", reason: "service token path is not a bounded regular file"}
	}
	raw, err := os.ReadFile(serviceAPITokenPath(dir))
	if err != nil {
		return serviceTokenState{kind: "unsafe", reason: "service token file could not be read"}
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		return serviceTokenState{kind: "unsafe", reason: "service token file is empty"}
	}
	return serviceTokenState{kind: "present", token: token, fingerprint: sha256Hex(token)}
}

func readTokenBackupState(dir string) serviceTokenState {
	path := serviceAPITokenBackupPath(dir)
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return serviceTokenState{kind: "absent"}
		}
		return serviceTokenState{kind: "unsafe", reason: "service token backup could not be inspected"}
	}
	if info.Mode()&os.ModeSymlink != 0 {
		if _, statErr := os.Stat(path); statErr != nil {
			return serviceTokenState{kind: "absent"}
		}
		return serviceTokenState{kind: "unsafe", reason: "service token backup is not an owner-only bounded regular file"}
	}
	if !info.Mode().IsRegular() || info.Size() > maxServiceAPITokenBytes {
		return serviceTokenState{kind: "unsafe", reason: "service token backup is not an owner-only bounded regular file"}
	}
	// TypeScript also requires owner-only permission bits on the backup.
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return serviceTokenState{kind: "unsafe", reason: "service token backup is not an owner-only bounded regular file"}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return serviceTokenState{kind: "unsafe", reason: "service token backup could not be read"}
	}
	token := strings.TrimSpace(string(raw))
	if token == "" || strings.ContainsAny(token, "\r\n\x00") {
		return serviceTokenState{kind: "unsafe", reason: "service token backup is invalid"}
	}
	return serviceTokenState{kind: "present", token: token, fingerprint: sha256Hex(token)}
}

func removeOrphanTokenBackup(dir string) error {
	state := readTokenBackupState(dir)
	if state.kind == "absent" {
		return nil
	}
	if state.kind == "unsafe" {
		return errors.New(state.reason)
	}
	if err := os.Remove(serviceAPITokenBackupPath(dir)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("service token backup could not be removed")
	}
	return nil
}

// removeServiceAPITokenFileIfOwned mirrors removeServiceApiTokenFileIfOwned:
// removed | absent | changed.
func removeServiceAPITokenFileIfOwned(dir, expectedFingerprint string) (string, error) {
	state := readServiceAPITokenState(dir)
	if state.kind == "absent" {
		return "absent", nil
	}
	if state.kind != "present" || state.fingerprint != expectedFingerprint {
		return "changed", nil
	}
	if err := os.Remove(serviceAPITokenPath(dir)); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "absent", nil
		}
		return "", errors.New("owned service API token could not be removed")
	}
	return "removed", nil
}

func rotationInFlight() bool {
	current := readClientConnectionState()
	return current.kind == connectionConnected && len(current.value.PendingOperation) > 0
}

// inspectRotationGate mirrors inspectClientRotationRecoveryGate; its kind is
// clean | orphan-cleaned | recovery-required | unsafe. Like TypeScript it may
// remove an orphan .prev backup as a side effect.
func inspectRotationGate(state clientConnectionState, dir string) (string, string) {
	current := readServiceAPITokenState(dir)
	backup := readTokenBackupState(dir)
	if state.kind == connectionConnected && len(state.value.PendingOperation) > 0 {
		if current.kind != "present" || backup.kind != "present" {
			return "unsafe", "pending key rotation requires owner-only service-api-token and service-api-token.prev files"
		}
		return "recovery-required", "rerun ocx connect rotate with --pairing-code-stdin or --admin-token-stdin"
	}
	if backup.kind == "unsafe" {
		return "unsafe", backup.reason
	}
	if backup.kind == "present" && current.kind == "present" {
		if rotationInFlight() {
			return "recovery-required", "a key rotation is in flight; leave service-api-token.prev in place"
		}
		if err := removeOrphanTokenBackup(dir); err != nil {
			return "unsafe", err.Error()
		}
		return "orphan-cleaned", ""
	}
	return "clean", ""
}

// catalogStatus classifies the on-disk catalog exactly like the connect status
// collector: missing | present | unsafe.
func catalogStatus() string {
	codexHome, err := codexHomeFromEnv()
	if err != nil {
		return "missing"
	}
	info, err := os.Lstat(defaultCatalogPath(codexHome))
	if err != nil {
		return "missing"
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return "unsafe"
	}
	return "present"
}
