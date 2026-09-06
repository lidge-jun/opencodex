// Package configschema ports the config.json boundary shared by the TypeScript
// config command. It intentionally keeps JSON object order: config show and
// config export expose the Zod schema's default-injection order.
package configschema

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultPort                   = int64(10100)
	defaultUsageMaxReadBytes      = int64(64 * 1024 * 1024)
	defaultAppOwnedMemoryBudgetMB = int64(256)
	maxAppOwnedMemoryBudgetMB     = int64(4096)
)

// Normalized is a config document whose object order has been projected onto
// TypeScript's configSchema order. Unknown fields remain present after known
// schema fields, matching Zod's passthrough object result.
type Normalized struct{ root *value }

func NormalizeJSON(raw []byte) (*Normalized, error) {
	v, err := parse(raw)
	if err != nil {
		return nil, err
	}
	if v.kind != objectKind {
		return nil, errors.New("config must be a JSON object")
	}
	return &Normalized{root: normalizeLoad(v)}, nil
}

// ValidateCandidateJSON implements the strict write boundary. Loading can
// degrade selected optional fields; writes never silently accept an invalid
// config candidate. Error wording follows Zod 4 as used in src/config.ts.
func ValidateCandidateJSON(raw []byte) (*Normalized, error) {
	v, err := parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	if v.kind != objectKind {
		return nil, errors.New("schema_invalid: Invalid input: expected object, received array")
	}
	if err := validateStrictWriteFields(v); err != nil {
		return nil, err
	}
	if err := validateTop(v); err != nil {
		return nil, err
	}
	normalizeStrictWriteOutput(v)
	return &Normalized{root: normalizeLoad(v)}, nil
}

// validateStrictWriteFields covers fields which deliberately degrade on the
// read path but must refuse a live config set/import instead of silently
// deleting or replacing operator intent.
func validateStrictWriteFields(v *value) error {
	if x := v.find("hostname"); x != nil && (x.kind != stringKind || strings.TrimSpace(x.text) == "") {
		return errors.New("schema_invalid: hostname: must be a nonblank bind address")
	}
	if x := v.find("appOwnedMemoryBudgetMb"); x != nil && !validIntRange(x, 64, maxAppOwnedMemoryBudgetMB) {
		return fmt.Errorf("schema_invalid: appOwnedMemoryBudgetMb: must be an integer from 64 to %d", maxAppOwnedMemoryBudgetMB)
	}
	if x := v.find("upstreamHostCircuitThreshold"); x != nil && !validIntRange(x, 0, 100) {
		return errors.New("schema_invalid: upstreamHostCircuitThreshold: must be an integer from 0 to 100")
	}
	if x := v.find("googleAntigravityStaticCatalogVersion"); x != nil && !(x.kind == numberKind && (x.number.String() == "1" || x.number.String() == "2")) {
		return errors.New("schema_invalid: googleAntigravityStaticCatalogVersion: must be 1, 2, or omitted")
	}
	if x := v.find("activeCodexAccountPinned"); x != nil && (x.kind != stringKind || !regexp.MustCompile(`^[a-zA-Z0-9._-]{1,64}$`).MatchString(x.text)) {
		return errors.New("schema_invalid: activeCodexAccountPinned: must be an account id")
	}
	if x := v.find("codexAccountPickerEnabled"); x != nil && x.kind != boolKind {
		return errors.New("schema_invalid: codexAccountPickerEnabled: Invalid input: expected boolean, received " + zodType(x))
	}
	if x := v.find("visionSidecar"); x != nil && x.kind == objectKind {
		if r := x.find("reasoning"); r != nil && (r.kind != stringKind || !map[string]bool{"low": true, "medium": true, "high": true, "xhigh": true, "max": true}[r.text]) {
			return errors.New("schema_invalid: visionSidecar.reasoning: must be one of low, medium, high, xhigh, max")
		}
	}
	if err := validateAgentTaskRecovery(v); err != nil {
		return err
	}
	if err := validateCodexAccountMaps(v); err != nil {
		return err
	}
	if err := validateRuntimeAndRemote(v); err != nil {
		return err
	}
	if err := validateLoopbackAndIngress(v); err != nil {
		return err
	}
	return nil
}

func validateAgentTaskRecovery(root *value) error {
	x := root.find("agentTaskRecovery")
	if x == nil {
		return nil
	}
	if x.kind != objectKind {
		return errors.New("schema_invalid: agentTaskRecovery: Invalid input: expected object, received " + zodType(x))
	}
	for _, m := range x.object {
		if m.key != "enabled" && m.key != "model" && m.key != "timeoutMs" && m.key != "cacheEntries" {
			return fmt.Errorf("schema_invalid: agentTaskRecovery: Unrecognized key: %q", m.key)
		}
	}
	if y := x.find("enabled"); y != nil && y.kind != boolKind {
		return errors.New("schema_invalid: agentTaskRecovery.enabled: Invalid input: expected boolean, received " + zodType(y))
	}
	if y := x.find("model"); y != nil {
		if y.kind != stringKind {
			return errors.New("schema_invalid: agentTaskRecovery.model: Invalid input: expected string, received " + zodType(y))
		}
		if strings.TrimSpace(y.text) == "" {
			return errors.New("schema_invalid: agentTaskRecovery.model: Too small: expected string to have >=1 characters")
		}
	}
	if y := x.find("timeoutMs"); y != nil {
		if y.kind != numberKind {
			return errors.New("schema_invalid: agentTaskRecovery.timeoutMs: Invalid input: expected number, received " + zodType(y))
		}
		if !validInteger(y) {
			return errors.New("schema_invalid: agentTaskRecovery.timeoutMs: Invalid input: expected int, received number")
		}
		if !validIntRange(y, 1000, 120000) {
			if integerBelow(y, 1000) {
				return errors.New("schema_invalid: agentTaskRecovery.timeoutMs: Too small: expected number to be >=1000")
			}
			return errors.New("schema_invalid: agentTaskRecovery.timeoutMs: Too big: expected number to be <=120000")
		}
	}
	if y := x.find("cacheEntries"); y != nil {
		if y.kind != numberKind {
			return errors.New("schema_invalid: agentTaskRecovery.cacheEntries: Invalid input: expected number, received " + zodType(y))
		}
		if !validInteger(y) {
			return errors.New("schema_invalid: agentTaskRecovery.cacheEntries: Invalid input: expected int, received number")
		}
		if !validIntRange(y, 1, 512) {
			if integerBelow(y, 1) {
				return errors.New("schema_invalid: agentTaskRecovery.cacheEntries: Too small: expected number to be >=1")
			}
			return errors.New("schema_invalid: agentTaskRecovery.cacheEntries: Too big: expected number to be <=512")
		}
	}
	return nil
}

func validateCodexAccountMaps(root *value) error {
	if x := root.find("codexAccountPriorities"); x != nil {
		if x.kind != objectKind {
			return errors.New("schema_invalid: codexAccountPriorities.config: codexAccountPriorities must be a plain object mapping Codex account ids to selection-order integers")
		}
		for _, m := range x.object {
			if !validPriorityKey(m.key) {
				return fmt.Errorf("schema_invalid: codexAccountPriorities.%s: selection-order keys must be a Codex pool-account id or the main Codex account and cannot be reserved JavaScript object keys", m.key)
			}
			if !validIntRange(m.value, -100, 100) {
				return fmt.Errorf("schema_invalid: codexAccountPriorities.%s: selection order must be an integer between -100 and 100", m.key)
			}
		}
	}
	if x := root.find("activeCodexAccountPinned"); x != nil && (x.kind != stringKind || !regexp.MustCompile(`^[a-zA-Z0-9._-]{1,64}$`).MatchString(x.text)) {
		return errors.New("schema_invalid: activeCodexAccountPinned: must be an account id")
	}
	if x := root.find("codexAccountNamespaces"); x != nil {
		if x.kind != objectKind {
			return errors.New("schema_invalid: codexAccountNamespaces: codexAccountNamespaces must be a plain object mapping account selectors to Codex account ids")
		}
		providers := root.find("providers")
		configuredAccountIDs := configuredPoolAccountIDs(root.find("codexAccounts"))
		for _, m := range x.object {
			if !validProviderName(m.key) {
				return fmt.Errorf("schema_invalid: codexAccountNamespaces.%s: account selectors must use 1-64 letters, numbers, dots, underscores, or hyphens and cannot be reserved JavaScript object keys", m.key)
			}
			if m.value.kind != stringKind || (m.value.text != "@main" && !validAccountID(m.value.text)) {
				return fmt.Errorf("schema_invalid: codexAccountNamespaces.%s: account selector targets must be @main or valid Codex pool-account ids", m.key)
			}
			if strings.EqualFold(m.key, "combo") || strings.EqualFold(m.key, "openai") || strings.EqualFold(m.key, "policy") || (providers != nil && providers.kind == objectKind && hasFold(providers, m.key)) {
				return fmt.Errorf("schema_invalid: codexAccountNamespaces.%s: account selectors must not collide with configured provider, combo, or routing policy namespaces", m.key)
			}
			if m.value.text != "@main" && (configuredAccountIDs[m.key] || hasKey(x, m.value.text)) {
				return fmt.Errorf("schema_invalid: codexAccountNamespaces.%s: account selectors must not collide with configured Codex pool-account ids or account selector targets", m.key)
			}
		}
	}
	return nil
}

func validateRuntimeAndRemote(root *value) error {
	role := root.find("runtimeRole")
	if role != nil && (role.kind != stringKind || (role.text != "standalone" && role.text != "hub" && role.text != "client")) {
		return errors.New("schema_invalid: runtimeRole: must be one of \"standalone\", \"hub\", or \"client\"")
	}
	if err := validateHub(root.find("hub")); err != nil {
		return err
	}
	if err := validateRemoteGUI(root.find("remoteGui")); err != nil {
		return err
	}
	if err := validateClient(root.find("client")); err != nil {
		return err
	}
	hasClient := root.find("client") != nil
	if role != nil && role.kind == stringKind && role.text == "client" && !hasClient {
		return errors.New("schema_invalid: runtimeRole client requires a complete client connection")
	}
	if hasClient && (role == nil || role.kind != stringKind || role.text != "client") {
		return errors.New("schema_invalid: client connection requires runtimeRole client")
	}
	return nil
}

func validateHub(x *value) error {
	if x == nil {
		return nil
	}
	if x.kind != objectKind {
		return errors.New("schema_invalid: hub: Invalid input: expected object, received " + zodType(x))
	}
	for _, m := range x.object {
		if m.key != "managementPublicOrigin" && m.key != "managementIngress" {
			return fmt.Errorf("schema_invalid: hub: Unrecognized key: %q", m.key)
		}
	}
	if y := x.find("managementPublicOrigin"); y != nil && (y.kind != stringKind || !canonicalHTTPOrigin(y.text)) {
		return errors.New("schema_invalid: hub.managementPublicOrigin: must be a canonical http(s) origin without credentials, path, query, or fragment")
	}
	return nil
}

func validateRemoteGUI(x *value) error {
	if x == nil {
		return nil
	}
	if x.kind != objectKind {
		return errors.New("schema_invalid: remoteGui: Invalid input: expected object, received " + zodType(x))
	}
	for _, m := range x.object {
		if m.key != "allowedTailscaleUsers" && m.key != "allowInsecureHttp" {
			return fmt.Errorf("schema_invalid: remoteGui: Unrecognized key: %q", m.key)
		}
	}
	if y := x.find("allowInsecureHttp"); y != nil && y.kind != boolKind {
		return errors.New("schema_invalid: remoteGui.allowInsecureHttp: Invalid input: expected boolean, received " + zodType(y))
	}
	users := x.find("allowedTailscaleUsers")
	if users == nil {
		return nil
	}
	if users.kind != arrayKind {
		return errors.New("schema_invalid: remoteGui.allowedTailscaleUsers: Invalid input: expected array, received " + zodType(users))
	}
	if len(users.array) > 64 {
		return errors.New("schema_invalid: remoteGui.allowedTailscaleUsers: Too big: expected array to have <=64 items")
	}
	seen := map[string]bool{}
	for i, user := range users.array {
		if user.kind != stringKind {
			return fmt.Errorf("schema_invalid: remoteGui.allowedTailscaleUsers.%d: Invalid input: expected string, received %s", i, zodType(user))
		}
		trimmed := strings.TrimSpace(user.text)
		if trimmed == "" {
			return fmt.Errorf("schema_invalid: remoteGui.allowedTailscaleUsers.%d: Too small: expected string to have >=1 characters", i)
		}
		if len([]byte(trimmed)) > 320 {
			return fmt.Errorf("schema_invalid: remoteGui.allowedTailscaleUsers.%d: must be at most 320 UTF-8 bytes", i)
		}
		if strings.IndexFunc(trimmed, func(r rune) bool { return r < 32 || r == 127 }) >= 0 {
			return fmt.Errorf("schema_invalid: remoteGui.allowedTailscaleUsers.%d: must not contain ASCII control characters", i)
		}
		if seen[trimmed] {
			return fmt.Errorf("schema_invalid: remoteGui.allowedTailscaleUsers.%d: must contain unique users after trimming", i)
		}
		seen[trimmed] = true
	}
	return nil
}

func validateClient(x *value) error {
	if x == nil {
		return nil
	}
	if x.kind != objectKind {
		return errors.New("schema_invalid: client: Invalid input: expected object, received " + zodType(x))
	}
	allowed := map[string]bool{"serverUrl": true, "managementUrl": true, "managementTransport": true, "selectedClients": true, "tokenEnv": true, "apiKeyId": true, "tokenFingerprint": true, "protocolVersion": true, "connectedAt": true, "catalogFingerprint": true, "priorCatalog": true, "catalogSyncedAt": true, "pendingOperation": true}
	for _, m := range x.object {
		if !allowed[m.key] {
			return fmt.Errorf("schema_invalid: client: Unrecognized key: %q", m.key)
		}
	}
	for _, field := range []string{"serverUrl", "managementUrl", "managementTransport", "selectedClients", "tokenEnv", "apiKeyId", "tokenFingerprint", "protocolVersion", "connectedAt"} {
		if x.find(field) == nil {
			return fmt.Errorf("schema_invalid: client.%s: Invalid input: expected %s, received undefined", field, clientExpectedType(field))
		}
	}
	for _, field := range []string{"serverUrl", "managementUrl"} {
		y := x.find(field)
		if y.kind != stringKind || !canonicalHTTPOrigin(y.text) {
			return fmt.Errorf("schema_invalid: client.%s: must be a canonical http(s) origin without credentials, path, query, or fragment", field)
		}
	}
	if y := x.find("managementTransport"); y.kind != stringKind || (y.text != "direct" && y.text != "relay") {
		return errors.New("schema_invalid: client.managementTransport: Invalid option: expected one of \"direct\"|\"relay\"")
	}
	y := x.find("selectedClients")
	if y.kind != arrayKind || len(y.array) < 1 || len(y.array) > 2 {
		return errors.New("schema_invalid: client.selectedClients: Invalid input")
	}
	selected := map[string]bool{}
	for _, c := range y.array {
		if c.kind != stringKind || (c.text != "codex" && c.text != "claude") {
			return errors.New("schema_invalid: client.selectedClients: Invalid option")
		}
		if selected[c.text] {
			return errors.New("schema_invalid: client.selectedClients: must contain unique client ids")
		}
		selected[c.text] = true
	}
	if y := x.find("tokenEnv"); y.kind != stringKind || y.text != "OPENCODEX_API_AUTH_TOKEN" {
		return errors.New("schema_invalid: client.tokenEnv: Invalid input: expected \"OPENCODEX_API_AUTH_TOKEN\"")
	}
	if y := x.find("apiKeyId"); y.kind != stringKind || strings.TrimSpace(y.text) == "" || len(y.text) > 256 {
		return errors.New("schema_invalid: client.apiKeyId: Invalid input")
	}
	if y := x.find("tokenFingerprint"); y.kind != stringKind || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(y.text) {
		return errors.New("schema_invalid: client.tokenFingerprint: Invalid string: must match pattern /^[a-f0-9]{64}$/")
	}
	if y := x.find("protocolVersion"); !validIntRange(y, 1, 1) {
		return errors.New("schema_invalid: client.protocolVersion: Invalid input: expected 1")
	}
	if y := x.find("connectedAt"); y.kind != stringKind || !validTimestamp(y.text) {
		return errors.New("schema_invalid: client.connectedAt: Invalid ISO datetime")
	}
	if y := x.find("catalogFingerprint"); y != nil && (y.kind != stringKind || len(y.text) < 1 || len(y.text) > 512) {
		return errors.New("schema_invalid: client.catalogFingerprint: Invalid input")
	}
	if y := x.find("priorCatalog"); y != nil && (y.kind != stringKind || len(y.text) > 64*1024*1024) {
		return errors.New("schema_invalid: client.priorCatalog: Invalid input")
	}
	if y := x.find("catalogSyncedAt"); y != nil && (y.kind != stringKind || !validTimestamp(y.text)) {
		return errors.New("schema_invalid: client.catalogSyncedAt: Invalid ISO datetime")
	}
	if y := x.find("pendingOperation"); y != nil {
		if err := validatePendingOperation(y); err != nil {
			return err
		}
	}
	return nil
}

func validatePendingOperation(x *value) error {
	if x.kind != objectKind {
		return errors.New("schema_invalid: client.pendingOperation: Invalid input: expected object, received " + zodType(x))
	}
	for _, m := range x.object {
		if m.key != "kind" && m.key != "rotationId" && m.key != "newKeyIssuedAt" && m.key != "oldKeyBackupPath" {
			return fmt.Errorf("schema_invalid: client.pendingOperation: Unrecognized key: %q", m.key)
		}
	}
	if y := x.find("kind"); y == nil || y.kind != stringKind || y.text != "rotate" {
		return errors.New("schema_invalid: client.pendingOperation.kind: Invalid input: expected \"rotate\"")
	}
	if y := x.find("rotationId"); y == nil || y.kind != stringKind || strings.TrimSpace(y.text) == "" || len(y.text) > 256 {
		return errors.New("schema_invalid: client.pendingOperation.rotationId: Invalid input")
	}
	if y := x.find("newKeyIssuedAt"); y == nil || y.kind != stringKind || !validTimestamp(y.text) {
		return errors.New("schema_invalid: client.pendingOperation.newKeyIssuedAt: Invalid ISO datetime")
	}
	if y := x.find("oldKeyBackupPath"); y == nil || y.kind != stringKind || y.text == "" {
		return errors.New("schema_invalid: client.pendingOperation.oldKeyBackupPath: Invalid input")
	} else if y.text != filepath.Join(configDir(), "service-api-token.prev") {
		return fmt.Errorf("schema_invalid: client.pendingOperation.oldKeyBackupPath: must equal %s", filepath.Join(configDir(), "service-api-token.prev"))
	}
	return nil
}

func validateLoopbackAndIngress(root *value) error {
	if x := root.find("unauthenticatedLoopbackListener"); x != nil {
		if x.kind != objectKind {
			return errors.New("schema_invalid: unauthenticatedLoopbackListener: must be an object or omitted")
		}
		enabled := x.find("enabled")
		if enabled == nil || enabled.kind != boolKind {
			return errors.New("schema_invalid: unauthenticatedLoopbackListener.enabled: must be a boolean")
		}
		if !enabled.b {
			for _, m := range x.object {
				if m.key != "enabled" {
					return fmt.Errorf("schema_invalid: unauthenticatedLoopbackListener: Unrecognized key: %q", m.key)
				}
			}
		} else {
			for _, m := range x.object {
				if m.key != "enabled" && m.key != "port" {
					return fmt.Errorf("schema_invalid: unauthenticatedLoopbackListener: Unrecognized key: %q", m.key)
				}
			}
			if err := validPortObject(x, "unauthenticatedLoopbackListener"); err != nil {
				return err
			}
			if p := root.find("port"); p != nil && validIntRange(p, 0, 65535) && x.find("port").number.String() == p.number.String() {
				return errors.New("schema_invalid: unauthenticatedLoopbackListener.port: must differ from the proxy port")
			}
		}
	}
	hub := root.find("hub")
	if hub == nil || hub.kind != objectKind {
		return nil
	}
	ingress := hub.find("managementIngress")
	if ingress == nil {
		return nil
	}
	if ingress.kind != objectKind {
		return errors.New("schema_invalid: hub.managementIngress: must be an object or omitted")
	}
	enabled := ingress.find("enabled")
	if enabled == nil || enabled.kind != boolKind {
		return errors.New("schema_invalid: hub.managementIngress.enabled: must be a boolean")
	}
	if !enabled.b {
		if len(ingress.object) != 1 {
			return errors.New("schema_invalid: hub.managementIngress: disabled ingress accepts only enabled")
		}
		return nil
	}
	for _, m := range ingress.object {
		if m.key != "enabled" && m.key != "port" {
			return errors.New("schema_invalid: hub.managementIngress: contains an unsupported field")
		}
	}
	if err := validPortObject(ingress, "hub.managementIngress"); err != nil {
		return err
	}
	role := root.find("runtimeRole")
	if role == nil || role.kind != stringKind || role.text != "hub" {
		return errors.New("schema_invalid: hub.managementIngress: enabled ingress requires runtimeRole hub")
	}
	ingressPort := ingress.find("port").number.String()
	proxy := "10100"
	if p := root.find("port"); p != nil && p.kind == numberKind {
		proxy = p.number.String()
	}
	if ingressPort == proxy {
		return errors.New("schema_invalid: hub.managementIngress.port: must differ from the proxy port")
	}
	if loop := root.find("unauthenticatedLoopbackListener"); loop != nil && loop.kind == objectKind {
		if enabled := loop.find("enabled"); enabled != nil && enabled.kind == boolKind && enabled.b {
			if p := loop.find("port"); p != nil && p.kind == numberKind && p.number.String() == ingressPort {
				return errors.New("schema_invalid: hub.managementIngress.port: must differ from unauthenticatedLoopbackListener.port")
			}
		}
	}
	return nil
}

func validPortObject(x *value, path string) error {
	p := x.find("port")
	if !validIntRange(p, 1, 65535) {
		return fmt.Errorf("schema_invalid: %s.port: must be an integer port when enabled", path)
	}
	return nil
}
func validInteger(v *value) bool {
	_, err := strconv.ParseInt(v.number.String(), 10, 64)
	return v != nil && v.kind == numberKind && err == nil
}
func integerBelow(v *value, n int64) bool {
	x, err := strconv.ParseInt(v.number.String(), 10, 64)
	return err == nil && x < n
}
func validAccountID(s string) bool {
	return regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`).MatchString(s) && !reservedKey(s) && s != "__main__"
}
func validPriorityKey(s string) bool { return s == "__main__" || validAccountID(s) }
func validProviderName(s string) bool {
	return regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$`).MatchString(s) && !reservedKey(s) && !strings.EqualFold(s, "policy")
}
func reservedKey(s string) bool {
	return strings.EqualFold(s, "__proto__") || strings.EqualFold(s, "prototype") || strings.EqualFold(s, "constructor")
}
func hasFold(v *value, key string) bool {
	for _, m := range v.object {
		if strings.EqualFold(m.key, key) {
			return true
		}
	}
	return false
}
func hasKey(v *value, key string) bool { return v.find(key) != nil }
func configuredPoolAccountIDs(v *value) map[string]bool {
	ids := map[string]bool{}
	if v == nil || v.kind != arrayKind {
		return ids
	}
	for _, account := range v.array {
		if account == nil || account.kind != objectKind {
			continue
		}
		id, isMain := account.find("id"), account.find("isMain")
		if id != nil && id.kind == stringKind && (isMain == nil || isMain.kind != boolKind || !isMain.b) {
			ids[id.text] = true
		}
	}
	return ids
}
func canonicalHTTPOrigin(s string) bool {
	return canonicalOrigin(s) != ""
}

func canonicalOrigin(s string) string {
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return ""
	}
	port := u.Port()
	if (u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443") {
		port = ""
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != "" {
		host += ":" + port
	}
	return strings.ToLower(u.Scheme) + "://" + host
}

func normalizeStrictWriteOutput(root *value) {
	if recovery := root.find("agentTaskRecovery"); recovery != nil && recovery.kind == objectKind {
		if model := recovery.find("model"); model != nil && model.kind == stringKind {
			model.text = strings.TrimSpace(model.text)
		}
	}
	if hub := root.find("hub"); hub != nil && hub.kind == objectKind {
		if origin := hub.find("managementPublicOrigin"); origin != nil && origin.kind == stringKind {
			origin.text = canonicalOrigin(origin.text)
		}
	}
	if remote := root.find("remoteGui"); remote != nil && remote.kind == objectKind {
		if users := remote.find("allowedTailscaleUsers"); users != nil && users.kind == arrayKind {
			for _, user := range users.array {
				if user.kind == stringKind {
					user.text = strings.TrimSpace(user.text)
				}
			}
		}
	}
	if client := root.find("client"); client != nil && client.kind == objectKind {
		for _, field := range []string{"serverUrl", "managementUrl"} {
			if origin := client.find(field); origin != nil && origin.kind == stringKind {
				origin.text = canonicalOrigin(origin.text)
			}
		}
		if apiKeyID := client.find("apiKeyId"); apiKeyID != nil && apiKeyID.kind == stringKind {
			apiKeyID.text = strings.TrimSpace(apiKeyID.text)
		}
		if operation := client.find("pendingOperation"); operation != nil && operation.kind == objectKind {
			if rotationID := operation.find("rotationId"); rotationID != nil && rotationID.kind == stringKind {
				rotationID.text = strings.TrimSpace(rotationID.text)
			}
		}
	}
}
func validTimestamp(s string) bool { _, err := time.Parse(time.RFC3339, s); return err == nil }
func clientExpectedType(field string) string {
	if field == "selectedClients" {
		return "array"
	}
	if field == "protocolVersion" {
		return "number"
	}
	return "string"
}

func configDir() string {
	if home := strings.TrimSpace(os.Getenv("OPENCODEX_HOME")); home != "" {
		return home
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".opencodex"
	}
	return filepath.Join(home, ".opencodex")
}

func (n *Normalized) CompactJSON() ([]byte, error) {
	if n == nil || n.root == nil {
		return nil, errors.New("nil normalized config")
	}
	return n.root.compact(), nil
}

func (n *Normalized) IndentedJSON() ([]byte, error) {
	compact, err := n.CompactJSON()
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	if err := json.Indent(&out, compact, "", "  "); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// RedactedIndentedJSON renders a diagnostic/config-show view without exposing
// credentials. It preserves the schema-projected object order used by
// IndentedJSON so callers can retain TypeScript's observable JSON layout.
func (n *Normalized) RedactedIndentedJSON() ([]byte, error) {
	if n == nil || n.root == nil {
		return nil, errors.New("nil normalized config")
	}
	var out bytes.Buffer
	redactValue(n.root, "").write(&out)
	var indented bytes.Buffer
	if err := json.Indent(&indented, out.Bytes(), "", "  "); err != nil {
		return nil, err
	}
	return indented.Bytes(), nil
}

// ClearCodexAccountPinForSet applies the config-set hook shared by the
// TypeScript CLI.  Restating any codexAccountPriorities path releases a stale
// manual account pin; imports deliberately do not call this hook because an
// import supplies its own complete pin state.  It is intentionally a library
// operation until the native write dispatcher owns the full set contract.
func (n *Normalized) ClearCodexAccountPinForSet(path string) bool {
	if n == nil || n.root == nil || n.root.kind != objectKind {
		return false
	}
	first := strings.TrimSpace(strings.Split(path, ".")[0])
	if first != "codexAccountPriorities" {
		return false
	}
	return n.root.delete("activeCodexAccountPinned")
}

// ApplyConfigPathMutation performs the strict config set/unset write boundary.
// It keeps JSON object order through the private value representation, then
// projects the result through the same schema normalization used by TS writes.
func ApplyConfigPathMutation(raw []byte, path, rawValue string, remove bool) (config *Normalized, saved *Normalized, changed bool, err error) {
	base, err := ValidateCandidateJSON(raw)
	if err != nil {
		return nil, nil, false, err
	}
	candidate := cloneValue(base.root)
	segments, err := configPathSegments(path)
	if err != nil {
		return nil, nil, false, err
	}
	current := candidate
	for _, segment := range segments[:len(segments)-1] {
		next := current.find(segment)
		if next == nil || next.kind != objectKind {
			return nil, nil, false, fmt.Errorf("config parent path not found: %s", segment)
		}
		current = next
	}
	leaf := segments[len(segments)-1]
	if remove {
		if !current.delete(leaf) {
			return nil, nil, false, fmt.Errorf("config path not found: %s", path)
		}
	} else {
		parsed, parseErr := parse([]byte(rawValue))
		if parseErr != nil {
			parsed = stringValue(rawValue)
		}
		current.set(leaf, parsed)
	}
	compact := candidate.compact()
	config, err = ValidateCandidateJSON(compact)
	if err != nil {
		return nil, nil, false, err
	}
	if !remove {
		config.ClearCodexAccountPinForSet(path)
	}
	if !remove {
		value, found := getConfigPathValue(config.root, segments)
		if !found {
			return nil, nil, false, fmt.Errorf("config path not found: %s", path)
		}
		saved = &Normalized{root: cloneValue(value)}
	}
	before, _ := base.CompactJSON()
	after, _ := config.CompactJSON()
	return config, saved, !bytes.Equal(before, after), nil
}

// ConfigPathValue returns a redacted JSON-ready normalized path value.
func (n *Normalized) ConfigPathValue(path string) (*Normalized, error) {
	segments, err := configPathSegments(path)
	if err != nil {
		return nil, err
	}
	value, ok := getConfigPathValue(n.root, segments)
	if !ok {
		return nil, fmt.Errorf("config path not found: %s", path)
	}
	return &Normalized{root: redactValue(cloneValue(value), segments[len(segments)-1])}, nil
}

func configPathSegments(path string) ([]string, error) {
	parts := make([]string, 0)
	for _, part := range strings.Split(path, ".") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if part == "__proto__" || part == "prototype" || part == "constructor" {
			return nil, errors.New("invalid config path")
		}
		parts = append(parts, part)
	}
	if len(parts) == 0 {
		return nil, errors.New("invalid config path")
	}
	return parts, nil
}
func getConfigPathValue(root *value, segments []string) (*value, bool) {
	current := root
	for _, segment := range segments {
		if current == nil || current.kind != objectKind {
			return nil, false
		}
		current = current.find(segment)
		if current == nil {
			return nil, false
		}
	}
	return current, true
}
func cloneValue(v *value) *value {
	if v == nil {
		return nil
	}
	out := *v
	if v.array != nil {
		out.array = make([]*value, len(v.array))
		for i := range v.array {
			out.array[i] = cloneValue(v.array[i])
		}
	}
	if v.object != nil {
		out.object = make([]member, len(v.object))
		for i := range v.object {
			out.object[i] = member{key: v.object[i].key, value: cloneValue(v.object[i].value)}
		}
	}
	return &out
}

type valueKind uint8

const (
	nullKind valueKind = iota
	boolKind
	numberKind
	stringKind
	arrayKind
	objectKind
)

type member struct {
	key   string
	value *value
}
type value struct {
	kind   valueKind
	b      bool
	number json.Number
	text   string
	array  []*value
	object []member
}

func parse(raw []byte) (*value, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	v, err := decodeValue(d)
	if err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		if err == nil {
			return nil, errors.New("multiple JSON values")
		}
		return nil, err
	}
	return v, nil
}
func decodeValue(d *json.Decoder) (*value, error) {
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	return decodeToken(d, t)
}
func decodeToken(d *json.Decoder, token json.Token) (*value, error) {
	switch x := token.(type) {
	case nil:
		return &value{kind: nullKind}, nil
	case bool:
		return &value{kind: boolKind, b: x}, nil
	case string:
		return &value{kind: stringKind, text: x}, nil
	case json.Number:
		return &value{kind: numberKind, number: x}, nil
	case json.Delim:
		switch x {
		case '{':
			v := &value{kind: objectKind}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return nil, err
				}
				s, ok := key.(string)
				if !ok {
					return nil, errors.New("object key is not a string")
				}
				child, err := decodeValue(d)
				if err != nil {
					return nil, err
				}
				v.set(s, child)
			}
			_, err := d.Token()
			return v, err
		case '[':
			v := &value{kind: arrayKind}
			for d.More() {
				child, err := decodeValue(d)
				if err != nil {
					return nil, err
				}
				v.array = append(v.array, child)
			}
			_, err := d.Token()
			return v, err
		}
	}
	return nil, errors.New("unsupported JSON token")
}
func (v *value) find(key string) *value {
	if v == nil || v.kind != objectKind {
		return nil
	}
	for _, m := range v.object {
		if m.key == key {
			return m.value
		}
	}
	return nil
}
func (v *value) set(key string, x *value) {
	for i := range v.object {
		if v.object[i].key == key {
			v.object[i].value = x
			return
		}
	}
	v.object = append(v.object, member{key, x})
}
func (v *value) delete(key string) bool {
	if v == nil || v.kind != objectKind {
		return false
	}
	for i, m := range v.object {
		if m.key == key {
			v.object = append(v.object[:i], v.object[i+1:]...)
			return true
		}
	}
	return false
}
func (v *value) has(key string) bool { return v.find(key) != nil }
func number(n int64) *value {
	return &value{kind: numberKind, number: json.Number(strconv.FormatInt(n, 10))}
}
func stringValue(s string) *value { return &value{kind: stringKind, text: s} }

var schemaOrder = []string{"port", "runtimeRole", "hub", "remoteGui", "client", "managementUsageMaxReadBytes", "upstreamHostCircuitThreshold", "maxUpstreamBodyBytes", "appOwnedMemoryBudgetMb", "hostname", "unauthenticatedLoopbackListener", "providers", "defaultProvider", "defaultModelAliases", "cursorEffortRows", "configRebaseProvenance", "emptyCompletionRetry", "oauthOpenBrowser", "openaiProviderTierVersion", "googleAntigravityStaticCatalogVersion", "clientIntegrations", "providerContextCaps", "contextCapValue", "multiAgentGuidanceEnabled", "agentTaskRecovery", "injectionModel", "injectionEffort", "syncCodexSubagentDefaults", "subagentModelFallbackByModel", "codexShimAutoRestore", "codexDesktopAuthless", "pausedCodexAccountIds", "codexAccountNamespaces", "codexAccountPriorities", "activeCodexAccountPinned", "codexAccountPickerEnabled", "showCodexSparkQuota", "resetCreditAutoRedeem", "grokExcludedModels", "streamMode", "blockedModelRedirects", "experimentalRealtimeWsBaseUrl", "apiKeys"}

func normalizeLoad(in *value) *value {
	out := &value{kind: objectKind}
	known := map[string]bool{}
	for _, key := range schemaOrder {
		known[key] = true
		x := in.find(key)
		switch key {
		case "port":
			if x == nil || !validIntRange(x, 0, 65535) {
				out.set(key, number(defaultPort))
			} else {
				out.set(key, x)
			}
		case "managementUsageMaxReadBytes":
			if x == nil || !validIntRange(x, 1, math.MaxInt64) {
				out.set(key, number(defaultUsageMaxReadBytes))
			} else {
				out.set(key, x)
			}
		case "appOwnedMemoryBudgetMb":
			if x == nil || !validIntRange(x, 64, maxAppOwnedMemoryBudgetMB) {
				out.set(key, number(defaultAppOwnedMemoryBudgetMB))
			} else {
				out.set(key, x)
			}
		case "defaultProvider":
			if x == nil {
				out.set(key, stringValue("openai"))
			} else {
				out.set(key, x)
			}
		case "hostname":
			if x != nil && x.kind == stringKind && strings.TrimSpace(x.text) != "" {
				out.set(key, x)
			}
		case "upstreamHostCircuitThreshold", "maxUpstreamBodyBytes":
			if x != nil && validIntRange(x, 0, math.MaxInt64) {
				out.set(key, x)
			}
		case "providers":
			if x != nil && x.kind == objectKind {
				out.set(key, normalizeProviders(x))
			} else if x != nil {
				out.set(key, x)
			}
		default:
			if x != nil {
				out.set(key, x)
			}
		}
	}
	for _, m := range in.object {
		if !known[m.key] {
			out.set(m.key, m.value)
		}
	}
	return out
}
func normalizeProviders(in *value) *value {
	out := &value{kind: objectKind}
	for _, m := range in.object {
		if m.value.kind != objectKind {
			out.set(m.key, m.value)
			continue
		}
		p := &value{kind: objectKind}
		if x := m.value.find("adapter"); x != nil {
			p.set("adapter", x)
		}
		if x := m.value.find("baseUrl"); x != nil {
			p.set("baseUrl", x)
		}
		for _, field := range m.value.object {
			if field.key != "adapter" && field.key != "baseUrl" {
				p.set(field.key, field.value)
			}
		}
		out.set(m.key, p)
	}
	return out
}
func validIntRange(v *value, min, max int64) bool {
	if v == nil || v.kind != numberKind {
		return false
	}
	n, err := strconv.ParseInt(v.number.String(), 10, 64)
	return err == nil && n >= min && n <= max
}

func validateTop(v *value) error {
	var diagnostics []string
	if port := v.find("port"); port != nil {
		if port.kind != numberKind {
			diagnostics = append(diagnostics, "port: Invalid input: expected number, received string")
		}
		if port.kind == numberKind {
			n, err := strconv.ParseInt(port.number.String(), 10, 64)
			if err != nil {
				diagnostics = append(diagnostics, "port: Invalid input: expected int, received number")
			} else if n < 0 {
				diagnostics = append(diagnostics, "port: Too small: expected number to be >=0")
			} else if n > 65535 {
				diagnostics = append(diagnostics, "port: Too big: expected number to be <=65535")
			}
		}
	}
	providers := v.find("providers")
	if providers == nil {
		diagnostics = append(diagnostics, "providers: Invalid input: expected record, received undefined")
	}
	if providers != nil {
		if providers.kind != objectKind {
			diagnostics = append(diagnostics, fmt.Sprintf("providers: Invalid input: expected record, received %s", zodType(providers)))
		} else {
			for _, p := range providers.object {
				if p.value.kind != objectKind {
					diagnostics = append(diagnostics, fmt.Sprintf("providers.%s: Invalid input: expected object, received %s", p.key, zodType(p.value)))
					continue
				}
				if x := p.value.find("adapter"); x == nil {
					diagnostics = append(diagnostics, fmt.Sprintf("providers.%s.adapter: Invalid input: expected string, received undefined", p.key))
				} else if x.kind != stringKind {
					diagnostics = append(diagnostics, fmt.Sprintf("providers.%s.adapter: Invalid input: expected string, received %s", p.key, zodType(x)))
				} else if x.text == "" {
					diagnostics = append(diagnostics, fmt.Sprintf("providers.%s.adapter: Too small: expected string to have >=1 characters", p.key))
				}
				if x := p.value.find("baseUrl"); x == nil {
					diagnostics = append(diagnostics, fmt.Sprintf("providers.%s.baseUrl: Invalid input: expected string, received undefined", p.key))
				} else if x.kind != stringKind {
					diagnostics = append(diagnostics, fmt.Sprintf("providers.%s.baseUrl: Invalid input: expected string, received %s", p.key, zodType(x)))
				} else if x.text == "" {
					diagnostics = append(diagnostics, fmt.Sprintf("providers.%s.baseUrl: Too small: expected string to have >=1 characters", p.key))
				}
			}
		}
	}
	if d := v.find("defaultProvider"); d != nil {
		if d.kind != stringKind {
			diagnostics = append(diagnostics, fmt.Sprintf("defaultProvider: Invalid input: expected string, received %s", zodType(d)))
		}
		if d.kind == stringKind && d.text == "" {
			diagnostics = append(diagnostics, "defaultProvider: Too small: expected string to have >=1 characters")
		}
	}
	if len(diagnostics) > 0 {
		return errors.New("schema_invalid: " + strings.Join(diagnostics, "; "))
	}
	return nil
}
func zodType(v *value) string {
	if v == nil {
		return "undefined"
	}
	switch v.kind {
	case nullKind:
		return "null"
	case boolKind:
		return "boolean"
	case numberKind:
		return "number"
	case stringKind:
		return "string"
	case arrayKind:
		return "array"
	default:
		return "object"
	}
}
func (v *value) compact() []byte { var b bytes.Buffer; v.write(&b); return b.Bytes() }
func (v *value) write(b *bytes.Buffer) {
	switch v.kind {
	case nullKind:
		b.WriteString("null")
	case boolKind:
		if v.b {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case numberKind:
		b.WriteString(v.number.String())
	case stringKind:
		raw, _ := json.Marshal(v.text)
		b.Write(raw)
	case arrayKind:
		b.WriteByte('[')
		for i, x := range v.array {
			if i > 0 {
				b.WriteByte(',')
			}
			x.write(b)
		}
		b.WriteByte(']')
	case objectKind:
		b.WriteByte('{')
		for i, m := range v.object {
			if i > 0 {
				b.WriteByte(',')
			}
			raw, _ := json.Marshal(m.key)
			b.Write(raw)
			b.WriteByte(':')
			m.value.write(b)
		}
		b.WriteByte('}')
	}
}

func redactValue(v *value, key string) *value {
	if key == "modelCosts" {
		return sanitizeModelCostsForDisplay(v)
	}
	if isSecretKey(key) && v.kind == stringKind && v.text != "" {
		return stringValue("********")
	}
	switch v.kind {
	case arrayKind:
		out := &value{kind: arrayKind, array: make([]*value, len(v.array))}
		for i, child := range v.array {
			out.array[i] = redactValue(child, "")
		}
		return out
	case objectKind:
		out := &value{kind: objectKind, object: make([]member, 0, len(v.object))}
		for _, child := range v.object {
			redacted := redactValue(child.value, child.key)
			// JSON.stringify omits an object property whose value is undefined.
			// TS's sanitizeModelCostsForDisplay returns undefined when no row
			// survives, so retain the same projection here.
			if child.key == "modelCosts" && redacted == nil {
				continue
			}
			out.object = append(out.object, member{key: child.key, value: redacted})
		}
		return out
	default:
		return v
	}
}

var secretModelIDPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(?:^|[^A-Za-z0-9._-])sk-[A-Za-z0-9][A-Za-z0-9._-]{6,}(?:$|[^A-Za-z0-9._-])`),
	regexp.MustCompile(`(?i)(?:^|[^A-Za-z0-9_])(gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{20,})(?:$|[^A-Za-z0-9_])`),
	regexp.MustCompile(`(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret)=[^&\s"',;]+`),
}

// sanitizeModelCostsForDisplay mirrors sanitizeModelCostsForDisplay in
// src/config.ts: project only valid four-rate tuples and drop a model ID which
// resembles a credential rather than replacing it with a colliding placeholder.
// nil models JavaScript's undefined, causing the containing modelCosts member to
// be omitted by redactValue.
func sanitizeModelCostsForDisplay(costs *value) *value {
	if costs == nil || costs.kind != objectKind {
		return nil
	}
	out := &value{kind: objectKind}
	for _, row := range costs.object {
		if secretShapedModelID(row.key) || row.value == nil || row.value.kind != objectKind {
			continue
		}
		rates := make([]member, 0, 4)
		valid := true
		for _, field := range []string{"input", "output", "cacheRead", "cacheWrite"} {
			rate := row.value.find(field)
			if !validCostRate(rate) {
				valid = false
				break
			}
			rates = append(rates, member{key: field, value: rate})
		}
		if valid {
			out.object = append(out.object, member{key: row.key, value: &value{kind: objectKind, object: rates}})
		}
	}
	if len(out.object) == 0 {
		return nil
	}
	return out
}

func validCostRate(v *value) bool {
	if v == nil || v.kind != numberKind {
		return false
	}
	n, err := strconv.ParseFloat(v.number.String(), 64)
	return err == nil && !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0 && n <= 1_000_000
}

func secretShapedModelID(id string) bool {
	for _, pattern := range secretModelIDPatterns {
		if pattern.MatchString(id) {
			return true
		}
	}
	return false
}

func isSecretKey(key string) bool {
	switch strings.ToLower(key) {
	case "apikey", "key", "accesstoken", "refreshtoken", "idtoken", "token", "password", "clientsecret":
		return true
	}
	return false
}
