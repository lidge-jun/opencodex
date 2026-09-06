package ocxcli

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

// StatusConfigDiagnostic is the status-facing portion of TypeScript's
// readConfigDiagnostics result. It remains deliberately small: provider and
// startup projections still belong to the TypeScript command.
type StatusConfigDiagnostic struct {
	Config *config.Config
	Source string
	Error  *string
}

// StatusDomainDeps keeps the first status migration increment independently
// testable. In particular, commands continue to delegate to TypeScript while
// this evidence is compared with its output.
type StatusDomainDeps struct {
	ReadConfig  func() StatusConfigDiagnostic
	ReadPID     func() int64
	ReadRuntime func() (StatusRuntimeRecord, error)
	HTTPClient  *http.Client
}

// StatusDomains is the ordered JSON projection for status's proxy, listen,
// and config domains. The field order intentionally matches CliStatusJson.
type StatusDomains struct {
	Proxy  StatusProxyDomain  `json:"proxy"`
	Listen StatusListenDomain `json:"listen"`
	Config StatusConfigDomain `json:"config"`
}

type StatusProxyDomain struct {
	Running           bool               `json:"running"`
	PID               *int64             `json:"pid"`
	StaleProcessState bool               `json:"staleProcessState"`
	Health            StatusHealthDomain `json:"health"`
}

type StatusHealthDomain struct {
	OK      bool   `json:"ok"`
	URL     string `json:"url"`
	Message string `json:"message"`
}

type StatusListenDomain struct {
	Port     int     `json:"port"`
	Hostname *string `json:"hostname"`
	Source   string  `json:"source"`
}

type StatusConfigDomain struct {
	Source string  `json:"source"`
	Error  *string `json:"error"`
}

// ReadStatusConfigDiagnostics follows the non-mutating status path: absence
// is default, malformed JSON is a fallback with the stable invalid_json error,
// and a readable document is a file source. Schema-level fallback remains
// TypeScript-owned until its complete normaliser is ported.
func ReadStatusConfigDiagnostics() StatusConfigDiagnostic {
	path, err := config.Path()
	if err != nil {
		message := "invalid_json"
		return StatusConfigDiagnostic{Config: &config.Config{}, Source: "fallback", Error: &message}
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return StatusConfigDiagnostic{Config: &config.Config{}, Source: "default"}
	}
	if err != nil || !json.Valid(bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf})) {
		message := "invalid_json"
		return StatusConfigDiagnostic{Config: &config.Config{}, Source: "fallback", Error: &message}
	}
	cfg, err := config.LoadFromPath(path)
	if err != nil || cfg == nil {
		message := "invalid_json"
		return StatusConfigDiagnostic{Config: &config.Config{}, Source: "fallback", Error: &message}
	}
	// These listener fields are the config portion this diagnostic increment
	// owns. Keep TypeScript's schema wording, including the required-provider
	// companion emitted when a direct schema parse cannot use defaults.
	if rawPort, present := cfg.Raw["port"]; present {
		if _, valid := rawPort.(json.Number); !valid {
			message := "schema_invalid: port: Invalid input: expected number, received " + jsonTypeName(rawPort)
			if _, providersPresent := cfg.Raw["providers"]; !providersPresent {
				message += "; providers: Invalid input: expected record, received undefined"
			}
			return StatusConfigDiagnostic{Config: &config.Config{}, Source: "fallback", Error: &message}
		}
	}
	return StatusConfigDiagnostic{Config: cfg, Source: "file"}
}

func jsonTypeName(value any) string {
	switch value.(type) {
	case string:
		return "string"
	case bool:
		return "boolean"
	case nil:
		return "null"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	default:
		return "undefined"
	}
}

func defaultStatusDomainDeps(deps StatusDomainDeps) StatusDomainDeps {
	if deps.ReadConfig == nil {
		deps.ReadConfig = ReadStatusConfigDiagnostics
	}
	if deps.ReadPID == nil {
		deps.ReadPID = readStatusPIDFile
	}
	if deps.ReadRuntime == nil {
		deps.ReadRuntime = ReadStatusRuntime
	}
	return deps
}

func readStatusPIDFile() int64 {
	dir, err := config.Dir()
	if err != nil {
		return 0
	}
	raw, err := os.ReadFile(dir + string(os.PathSeparator) + "ocx.pid")
	if err != nil {
		return 0
	}
	pid, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}

// CollectStatusDomains mirrors status's no-live-proxy branch. It is a
// deliberately bounded migration seam: a complete status ownership transfer
// requires every remaining TypeScript status domain to be byte-identical.
func CollectStatusDomains(deps StatusDomainDeps) StatusDomains {
	deps = defaultStatusDomainDeps(deps)
	diagnostic := deps.ReadConfig()
	cfg := diagnostic.Config
	if cfg == nil {
		cfg = &config.Config{}
	}
	pid := deps.ReadPID()
	port, hostname := cfg.ListenTarget()
	source := "config"
	if runtime, err := deps.ReadRuntime(); err == nil && pid > 0 && runtime.PID == pid {
		port, hostname, source = runtime.Port, runtime.Hostname, "runtime"
	}
	client := &http.Client{Timeout: 800 * time.Millisecond}
	if deps.HTTPClient != nil {
		client = deps.HTTPClient
	}
	health := probeStatusHealth(port, hostname, client)
	var pidValue *int64
	if pid > 0 {
		pidValue = &pid
	}
	var hostnameValue *string
	if hostname != "" {
		hostnameCopy := hostname
		hostnameValue = &hostnameCopy
	}
	return StatusDomains{
		Proxy: StatusProxyDomain{
			Running: pid > 0 && health.OK,
			PID:     pidValue,
			Health:  StatusHealthDomain{OK: health.OK, URL: health.URL, Message: health.Message},
		},
		Listen: StatusListenDomain{Port: port, Hostname: hostnameValue, Source: source},
		Config: StatusConfigDomain{Source: diagnostic.Source, Error: diagnostic.Error},
	}
}
