package ocxcli

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
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
	ReadConfig     func() StatusConfigDiagnostic
	ReadPID        func() int64
	ReadRuntime    func() (StatusRuntimeRecord, error)
	ReadBunRuntime func() StatusBunRuntime
	CLIVersion     string
	HTTPClient     *http.Client
}

// StatusDomains is the ordered JSON projection for the status domains Go has
// incrementally ported. The field order intentionally matches CliStatusJson.
type StatusDomains struct {
	Proxy       StatusProxyDomain       `json:"proxy"`
	Dashboard   StatusDashboardDomain   `json:"dashboard"`
	Listen      StatusListenDomain      `json:"listen"`
	Paths       StatusPathsDomain       `json:"paths"`
	Runtime     StatusRuntimeDomain     `json:"runtime"`
	Config      StatusConfigDomain      `json:"config"`
	VersionSkew StatusVersionSkewDomain `json:"versionSkew"`
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

type StatusDashboardDomain struct {
	URL string `json:"url"`
}

type StatusPathsDomain struct {
	Config  string `json:"config"`
	PID     string `json:"pid"`
	Runtime string `json:"runtime"`
}

// StatusBunRuntime is the durable runtime provenance status emits. It is a
// dependency so tests can compare the projection against the exact Bun process
// that ran the TypeScript oracle; a Go process otherwise has a different exec
// path by construction.
type StatusBunRuntime struct {
	Path        string
	Source      string
	OverrideEnv *string
}

type StatusRuntimeDomain struct {
	Source      string  `json:"source"`
	OverrideEnv *string `json:"overrideEnv,omitempty"`
}

type StatusVersionSkewDomain struct {
	CLIVersion   string  `json:"cliVersion"`
	ProxyVersion *string `json:"proxyVersion"`
	Skewed       bool    `json:"skewed"`
	Warning      *string `json:"warning"`
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
	if deps.ReadBunRuntime == nil {
		deps.ReadBunRuntime = ReadStatusBunRuntime
	}
	if deps.CLIVersion == "" {
		deps.CLIVersion = readStatusPackageVersion()
	}
	return deps
}

// readStatusPackageVersion follows packageVersion's failure contract. The Go
// diagnostic may run from a built artifact with no checkout nearby, where an
// unknown version is safer than inventing a mismatch.
func readStatusPackageVersion() string {
	dir, err := os.Getwd()
	if err != nil {
		return "unknown"
	}
	for {
		raw, readErr := os.ReadFile(filepath.Join(dir, "package.json"))
		if readErr == nil {
			var manifest struct {
				Version any `json:"version"`
			}
			if json.Unmarshal(raw, &manifest) == nil {
				if version, ok := manifest.Version.(string); ok {
					return version
				}
			}
			return "unknown"
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "unknown"
		}
		dir = parent
	}
}

// ReadStatusBunRuntime mirrors status's runtime provenance shape for a native
// Go process. A trusted launcher marker must name this executable; otherwise
// the running executable is the only honest process runtime to report.
func ReadStatusBunRuntime() StatusBunRuntime {
	path, err := os.Executable()
	if err != nil || path == "" {
		path = os.Args[0]
	}
	path = filepath.Clean(path)
	source := "process"
	if recordedSource := strings.TrimSpace(os.Getenv("OCX_BUN_RUNTIME_SOURCE")); (recordedSource == "override" || recordedSource == "bundled" || recordedSource == "process") && sameStatusRuntimePath(strings.TrimSpace(os.Getenv("OCX_BUN_RUNTIME_PATH")), path) {
		source = recordedSource
	}
	var overrideEnv *string
	if source == "override" {
		value := "OPENCODEX_BUN_PATH"
		overrideEnv = &value
	}
	return StatusBunRuntime{Path: path, Source: source, OverrideEnv: overrideEnv}
}

func sameStatusRuntimePath(left, right string) bool {
	if left == "" || right == "" {
		return false
	}
	canonical := func(path string) string {
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			return resolved
		}
		return filepath.Clean(path)
	}
	return canonical(left) == canonical(right)
}

// ComputeStatusVersionSkew is a direct projection of computeVersionSkew.
// Empty proxyVersion is the no-live-proxy case; placeholder versions are
// deliberately incomparable rather than evidence of a stale installation.
func ComputeStatusVersionSkew(cliVersion, proxyVersion string) StatusVersionSkewDomain {
	var proxy *string
	if proxyVersion != "" {
		value := proxyVersion
		proxy = &value
	}
	skewed := proxy != nil && cliVersion != "unknown" && cliVersion != "0.0.0" && proxyVersion != "unknown" && proxyVersion != "0.0.0" && cliVersion != proxyVersion
	if !skewed {
		return StatusVersionSkewDomain{CLIVersion: cliVersion, ProxyVersion: proxy}
	}
	warning := "CLI " + cliVersion + " does not match the running proxy " + proxyVersion + " — this ocx on PATH is stale. Its help and features describe a different build. Reinstall, or run the proxy's own binary."
	return StatusVersionSkewDomain{CLIVersion: cliVersion, ProxyVersion: proxy, Skewed: true, Warning: &warning}
}

func statusDashboardURL(cfg *config.Config, hostname string, port int) string {
	if cfg != nil {
		if runtimeRole, _ := cfg.Raw["runtimeRole"].(string); runtimeRole == "hub" {
			if hub, _ := cfg.Raw["hub"].(map[string]any); hub != nil {
				if origin, _ := hub["managementPublicOrigin"].(string); origin != "" {
					if strings.HasSuffix(origin, "/") {
						return origin
					}
					return origin + "/"
				}
			}
		}
	}
	reachable := statusProbeHost(hostname)
	if reachable == "127.0.0.1" || reachable == "[::1]" || strings.EqualFold(reachable, "localhost") {
		reachable = "localhost"
	}
	return "http://" + reachable + ":" + strconv.Itoa(port) + "/"
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
	liveRuntime := false
	if runtime, err := deps.ReadRuntime(); err == nil && pid > 0 && runtime.PID == pid {
		port, hostname, source = runtime.Port, runtime.Hostname, "runtime"
		liveRuntime = true
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
	pathsConfig, err := config.Path()
	if err != nil {
		pathsConfig = ""
	}
	pathsPID := ""
	if pathsConfig != "" {
		pathsPID = filepath.Join(filepath.Dir(pathsConfig), "ocx.pid")
	}
	bunRuntime := deps.ReadBunRuntime()
	proxyVersion := ""
	if health.OK {
		proxyVersion = health.Version
	}
	healthMessage := health.Message
	if health.OK && liveRuntime {
		healthMessage = "ok (pid " + strconv.FormatInt(pid, 10) + ")"
	}
	return StatusDomains{
		Proxy: StatusProxyDomain{
			Running: pid > 0 && health.OK,
			PID:     pidValue,
			Health:  StatusHealthDomain{OK: health.OK, URL: health.URL, Message: healthMessage},
		},
		Dashboard: StatusDashboardDomain{URL: statusDashboardURL(cfg, hostname, port)},
		Listen:    StatusListenDomain{Port: port, Hostname: hostnameValue, Source: source},
		Paths: StatusPathsDomain{
			Config:  pathsConfig,
			PID:     pathsPID,
			Runtime: bunRuntime.Path,
		},
		Runtime:     StatusRuntimeDomain{Source: bunRuntime.Source, OverrideEnv: bunRuntime.OverrideEnv},
		Config:      StatusConfigDomain{Source: diagnostic.Source, Error: diagnostic.Error},
		VersionSkew: ComputeStatusVersionSkew(deps.CLIVersion, proxyVersion),
	}
}
