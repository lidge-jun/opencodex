package ocxcli

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

// StatusExtraDeps isolates the diagnostic inputs that remain outside the
// initial status evidence port. Production defaults are deliberately
// read-only; callers that own service or shim diagnostics can supply their
// authoritative observations without widening this status projection.
type StatusExtraDeps struct {
	RoutingKind func() string
	Service     func() StatusServiceDiagnostic
	Shim        func() StatusShimDiagnostic
	Platform    string
	NowUnix     func() int64
}

type StatusServiceDiagnostic struct {
	Supported bool
	Installed bool
	Viable    bool
	Enabled   bool
	Running   bool
	Stale     bool
	Conflict  bool
}

type StatusShimDiagnostic struct {
	Installed bool
	Healthy   bool
}

type StatusExtraDomains struct {
	CodexAutostart  bool
	Startup         StatusStartupDomain
	DefaultProvider string
	Connection      StatusConnectionDomain
}

type StatusStartupDomain struct {
	RoutingKind            string                      `json:"routingKind"`
	AutostartEnabled       bool                        `json:"autostartEnabled"`
	ServiceInstalled       bool                        `json:"serviceInstalled"`
	ServiceViable          bool                        `json:"serviceViable"`
	ServiceEnabled         bool                        `json:"serviceEnabled"`
	ServiceRunning         bool                        `json:"serviceRunning"`
	ServiceStale           bool                        `json:"serviceStale"`
	ServiceConflict        bool                        `json:"serviceConflict"`
	ServiceSupported       bool                        `json:"serviceSupported"`
	ShimInstalled          bool                        `json:"shimInstalled"`
	ShimHealthy            bool                        `json:"shimHealthy"`
	Platform               string                      `json:"platform"`
	DiagnosticStale        bool                        `json:"diagnosticStale"`
	RoutingInjected        bool                        `json:"routingInjected"`
	LocalRoutingDependency bool                        `json:"localRoutingDependency"`
	Status                 string                      `json:"status"`
	RebootSafe             bool                        `json:"rebootSafe"`
	Protection             string                      `json:"protection"`
	ShimCoverage           string                      `json:"shimCoverage"`
	RecommendedCommand     *string                     `json:"recommendedCommand"`
	Commands               StatusStartupCommandsDomain `json:"commands"`
}

type StatusStartupCommandsDomain struct {
	InstallService string `json:"installService"`
	RepairService  string `json:"repairService"`
	InstallShim    string `json:"installShim"`
	RestoreNative  string `json:"restoreNative"`
}

type StatusConnectionDomain struct {
	State             string   `json:"state"`
	Reason            *string  `json:"reason,omitempty"`
	ServerURL         *string  `json:"serverUrl,omitempty"`
	ManagementURL     *string  `json:"managementUrl,omitempty"`
	ProtocolVersion   *int     `json:"protocolVersion,omitempty"`
	APIKeyID          *string  `json:"apiKeyId,omitempty"`
	SelectedClients   []string `json:"selectedClients,omitempty"`
	Catalog           string   `json:"catalog"`
	CatalogAgeSeconds *int64   `json:"catalogAgeSeconds,omitempty"`
	CredentialFile    string   `json:"credentialFile"`
}

func defaultStatusExtraDeps(deps StatusExtraDeps) StatusExtraDeps {
	if deps.RoutingKind == nil {
		deps.RoutingKind = readStatusRoutingKind
	}
	if deps.Service == nil {
		deps.Service = func() StatusServiceDiagnostic { return StatusServiceDiagnostic{Supported: true} }
	}
	if deps.Shim == nil {
		deps.Shim = func() StatusShimDiagnostic { return StatusShimDiagnostic{} }
	}
	if deps.Platform == "" {
		deps.Platform = runtime.GOOS
	}
	if deps.NowUnix == nil {
		deps.NowUnix = func() int64 { return time.Now().Unix() }
	}
	return deps
}

func CollectStatusExtraDomains(diagnostic StatusConfigDiagnostic, deps StatusExtraDeps) StatusExtraDomains {
	deps = defaultStatusExtraDeps(deps)
	codexAutostart := true
	defaultProvider := "openai"
	if diagnostic.Config != nil {
		if value, exists := diagnostic.Config.Raw["codexAutoStart"]; exists && value == false {
			codexAutostart = false
		}
		if value, ok := diagnostic.Config.Raw["defaultProvider"].(string); ok && value != "" {
			defaultProvider = value
		}
	}
	service, shim := deps.Service(), deps.Shim()
	startup := deriveStatusStartup(codexAutostart, deps.RoutingKind(), service, shim, deps.Platform)
	return StatusExtraDomains{
		CodexAutostart:  codexAutostart,
		Startup:         startup,
		DefaultProvider: defaultProvider,
		Connection:      collectStatusConnection(deps.NowUnix()),
	}
}

func deriveStatusStartup(autostart bool, routing string, service StatusServiceDiagnostic, shim StatusShimDiagnostic, platform string) StatusStartupDomain {
	commands := StatusStartupCommandsDomain{"ocx service install", "ocx service repair", "ocx codex-shim install", "ocx restore"}
	if routing == "" {
		routing = "native"
	}
	routingInjected := routing == "opencodex-local"
	localDependency := routingInjected || routing == "custom-local" || routing == "unknown"
	shimEffective := autostart && shim.Healthy
	protection := "none"
	if routingInjected && service.Viable {
		protection = "service"
	} else if routingInjected && shimEffective {
		protection = "shim"
	}
	rebootSafe := !localDependency || (routingInjected && service.Viable)
	status := "at-risk"
	if !localDependency {
		status = "native"
	} else if rebootSafe {
		status = "protected"
	}
	var recommended *string
	if status == "at-risk" {
		command := commands.RestoreNative
		if routing != "custom-local" && routing != "unknown" && service.Supported {
			if service.Installed && !service.Conflict {
				command = commands.RepairService
			} else {
				command = commands.InstallService
			}
		}
		recommended = &command
	}
	coverage := "none"
	if shimEffective {
		coverage = "cli-only"
	}
	return StatusStartupDomain{
		RoutingKind: routing, AutostartEnabled: autostart,
		ServiceInstalled: service.Installed, ServiceViable: service.Viable, ServiceEnabled: service.Enabled,
		ServiceRunning: service.Running, ServiceStale: service.Stale, ServiceConflict: service.Conflict,
		ServiceSupported: service.Supported, ShimInstalled: shim.Installed, ShimHealthy: shim.Healthy,
		Platform: platform, DiagnosticStale: false, RoutingInjected: routingInjected,
		LocalRoutingDependency: localDependency, Status: status, RebootSafe: rebootSafe,
		Protection: protection, ShimCoverage: coverage, RecommendedCommand: recommended, Commands: commands,
	}
}

func readStatusRoutingKind() string {
	home := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if home == "" {
		return "native"
	}
	raw, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if os.IsNotExist(err) {
		return "native"
	}
	if err != nil {
		return "unknown"
	}
	content := string(raw)
	if strings.Contains(content, "# Auto-injected by opencodex") && strings.Contains(content, "openai_base_url") {
		return "opencodex-local"
	}
	if value, ok := statusTOMLString(content, "openai_base_url"); ok {
		if statusLocalURL(value) {
			return "custom-local"
		}
		return "custom-remote"
	}
	if value, ok := statusTOMLString(content, "model_provider"); ok && value != "openai" {
		return "unknown"
	}
	return "native"
}

func statusTOMLString(content, key string) (string, bool) {
	for _, line := range strings.Split(content, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "[") {
			break
		}
		pieces := strings.SplitN(line, "=", 2)
		if len(pieces) != 2 || strings.TrimSpace(pieces[0]) != key {
			continue
		}
		value := strings.Trim(strings.TrimSpace(strings.SplitN(pieces[1], "#", 2)[0]), "\"'")
		return value, true
	}
	return "", false
}

func statusLocalURL(value string) bool {
	lower := strings.ToLower(value)
	return strings.Contains(lower, "://localhost") || strings.Contains(lower, "://127.") || strings.Contains(lower, "://[::1]") || strings.Contains(lower, "://0.0.0.0") || strings.Contains(lower, "://[::]")
}

func collectStatusConnection(nowUnix int64) StatusConnectionDomain {
	result := StatusConnectionDomain{State: "disconnected", Catalog: statusCatalogState(), CredentialFile: "missing"}
	path, err := config.Path()
	if err != nil {
		return result
	}
	rawBytes, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return result
		}
		reason := "config.json is missing or unreadable"
		result.State, result.Reason = "invalid", &reason
		return result
	}
	var raw map[string]any
	decoder := json.NewDecoder(strings.NewReader(strings.TrimPrefix(string(rawBytes), "\ufeff")))
	decoder.UseNumber()
	if decoder.Decode(&raw) != nil || raw == nil {
		reason := "config.json is missing or unreadable"
		result.State, result.Reason = "invalid", &reason
		return result
	}
	clientValue, hasClient := raw["client"]
	role, rolePresent := raw["runtimeRole"]
	roleString, roleOK := role.(string)
	if rolePresent && !roleOK || roleOK && roleString != "standalone" && roleString != "hub" && roleString != "client" {
		reason := "config.json.runtimeRole is invalid"
		result.State, result.Reason = "invalid", &reason
		return result
	}
	if !hasClient && (!rolePresent || roleString == "standalone" || roleString == "hub") {
		return result
	}
	if !hasClient || roleString != "client" {
		reason := "runtimeRole=client is present without config.json.client"
		if hasClient {
			reason = "config.json.client is present without runtimeRole=client"
		}
		result.State, result.Reason = "mismatched", &reason
		return result
	}
	client, ok := clientValue.(map[string]any)
	if !ok {
		reason := "config.json.client is malformed"
		result.State, result.Reason = "invalid", &reason
		return result
	}
	serverURL, serverOK := client["serverUrl"].(string)
	managementURL, managementOK := client["managementUrl"].(string)
	apiKeyID, apiKeyOK := client["apiKeyId"].(string)
	protocol, protocolOK := statusInteger(client["protocolVersion"])
	clients, clientsOK := statusClients(client["selectedClients"])
	if !serverOK || !managementOK || !apiKeyOK || !protocolOK || !clientsOK {
		reason := "config.json.client is malformed"
		result.State, result.Reason = "invalid", &reason
		return result
	}
	result.State, result.ServerURL, result.ManagementURL, result.APIKeyID, result.ProtocolVersion, result.SelectedClients = "connected", &serverURL, &managementURL, &apiKeyID, &protocol, clients
	if syncedAt, ok := client["catalogSyncedAt"].(string); ok {
		if parsed, parseErr := time.Parse(time.RFC3339, syncedAt); parseErr == nil {
			age := nowUnix - parsed.Unix()
			if age < 0 {
				age = 0
			}
			result.CatalogAgeSeconds = &age
		}
	}
	fingerprint, fingerprintOK := client["tokenFingerprint"].(string)
	result.CredentialFile = statusCredentialFile(fingerprint, fingerprintOK)
	return result
}

func statusCatalogState() string {
	home := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if home == "" {
		return "missing"
	}
	info, err := os.Lstat(filepath.Join(home, "opencodex-catalog.json"))
	if os.IsNotExist(err) {
		return "missing"
	}
	if err != nil || !info.Mode().IsRegular() {
		return "unsafe"
	}
	return "present"
}

func statusCredentialFile(fingerprint string, fingerprintOK bool) string {
	dir, err := config.Dir()
	if err != nil {
		return "missing"
	}
	info, err := os.Lstat(filepath.Join(dir, "service-api-token"))
	if os.IsNotExist(err) {
		return "missing"
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
		return "unsafe"
	}
	raw, err := os.ReadFile(filepath.Join(dir, "service-api-token"))
	token := strings.TrimSpace(string(raw))
	if err != nil || token == "" {
		return "unsafe"
	}
	digest := sha256.Sum256([]byte(token))
	if fingerprintOK && hex.EncodeToString(digest[:]) == fingerprint {
		return "owned"
	}
	return "changed"
}

func statusInteger(value any) (int, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	parsed, err := number.Int64()
	return int(parsed), err == nil
}
func statusClients(value any) ([]string, bool) {
	values, ok := value.([]any)
	if !ok || len(values) == 0 {
		return nil, false
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		client, ok := value.(string)
		if !ok || (client != "codex" && client != "claude") {
			return nil, false
		}
		out = append(out, client)
	}
	return out, true
}
