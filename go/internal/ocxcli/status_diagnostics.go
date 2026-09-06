package ocxcli

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

// StatusRuntimeRecord is the non-secret portion of runtime-port.json used by
// TypeScript's status liveness probe. Unlike ReadRuntime it deliberately does
// not require the attestation secret: status only asks whether the public
// /healthz endpoint identifies as OpenCodex, while management commands require
// the proof-bound record.
type StatusRuntimeRecord struct {
	PID      int64  `json:"pid"`
	Port     int    `json:"port"`
	Hostname string `json:"hostname"`
}

// StatusHealth is the public, secret-free healthz projection used by status.
type StatusHealth struct {
	OK      bool
	URL     string
	Message string
	PID     int64
	Version string
	Uptime  float64
}

// StatusProbe is the shared, minimal liveness evidence required by the future
// native status and doctor ports. It intentionally stops before service, OAuth,
// runtime-selection, and other TypeScript-owned projections; callers must not
// present this as the complete status JSON schema.
type StatusProbe struct {
	Port     int
	Hostname string
	Source   string // runtime or config
	Runtime  *StatusRuntimeRecord
	Health   StatusHealth
}

// StatusProbeDeps is a test seam. Production uses config.Load and the supplied
// runtime reader so this file never creates or repairs state while diagnosing.
type StatusProbeDeps struct {
	LoadConfig  func() (*config.Config, error)
	ReadRuntime func() (StatusRuntimeRecord, error)
	HTTPClient  *http.Client
}

func defaultStatusProbeDeps(deps StatusProbeDeps) StatusProbeDeps {
	if deps.LoadConfig == nil {
		deps.LoadConfig = config.Load
	}
	if deps.ReadRuntime == nil {
		deps.ReadRuntime = ReadStatusRuntime
	}
	if deps.HTTPClient == nil {
		deps.HTTPClient = &http.Client{Timeout: 800 * time.Millisecond}
	}
	return deps
}

// ReadStatusRuntime reads public runtime metadata accepted by TypeScript's
// readRuntimePort. A missing or malformed record is not an error to status: it
// simply makes configuration the probe target.
func ReadStatusRuntime() (StatusRuntimeRecord, error) {
	dir, err := config.Dir()
	if err != nil {
		return StatusRuntimeRecord{}, err
	}
	raw, err := os.ReadFile(filepath.Join(dir, "runtime-port.json"))
	if err != nil {
		return StatusRuntimeRecord{}, err
	}
	var record StatusRuntimeRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		return StatusRuntimeRecord{}, err
	}
	if record.PID <= 0 || record.Port < 1 || record.Port > 65535 {
		return StatusRuntimeRecord{}, fmt.Errorf("invalid runtime record")
	}
	return record, nil
}

// ProbeStatusEvidence mirrors the TypeScript status selection order: runtime
// metadata first, config second; a runtime record is used even when its owner
// is no longer alive, which makes stale-state detection possible to the caller.
func ProbeStatusEvidence(deps StatusProbeDeps) StatusProbe {
	deps = defaultStatusProbeDeps(deps)
	probe := StatusProbe{Port: 10100, Source: "config"}
	if cfg, err := deps.LoadConfig(); err == nil && cfg != nil {
		probe.Port, probe.Hostname = cfg.ListenTarget()
	}
	if record, err := deps.ReadRuntime(); err == nil {
		probe.Port, probe.Hostname, probe.Source = record.Port, record.Hostname, "runtime"
		probe.Runtime = &record
	}
	probe.Health = probeStatusHealth(probe.Port, probe.Hostname, deps.HTTPClient)
	return probe
}

func statusProbeHost(hostname string) string {
	host := strings.TrimSpace(hostname)
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		return "127.0.0.1"
	}
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		return host
	}
	if strings.Contains(host, ":") {
		return "[" + host + "]"
	}
	return host
}

func probeStatusHealth(port int, hostname string, client *http.Client) StatusHealth {
	url := "http://" + statusProbeHost(hostname) + ":" + strconv.Itoa(port) + "/healthz"
	result := StatusHealth{URL: url, Message: "unreachable"}
	response, err := client.Get(url)
	if err != nil {
		return result
	}
	defer response.Body.Close()
	var body map[string]any
	if response.StatusCode != http.StatusOK {
		result.Message = fmt.Sprintf("returned HTTP %d", response.StatusCode)
		return result
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&body); err != nil {
		result.Message = "responded, but not an opencodex proxy"
		return result
	}
	service, _ := body["service"].(string)
	status, _ := body["status"].(string)
	version, versionOK := body["version"].(string)
	uptime, uptimeOK := body["uptime"].(float64)
	pid, _ := body["pid"].(float64)
	legacy := service == "" && status == "ok" && versionOK && uptimeOK
	if service != "opencodex" && !legacy {
		result.Message = "responded, but not an opencodex proxy"
		return result
	}
	result.OK, result.PID = true, int64(pid)
	versionText := ""
	if versionOK {
		result.Version = version
		versionText = " v" + version
	}
	uptimeText := ""
	if uptimeOK {
		result.Uptime = uptime
		uptimeText = fmt.Sprintf(", uptime %ds", int64(math.Floor(uptime+0.5)))
	}
	result.Message = "ok" + versionText + uptimeText
	return result
}
