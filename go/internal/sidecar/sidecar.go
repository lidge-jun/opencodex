// Package sidecar serves the declared Go-owned management read routes of the
// incremental runtime takeover (ADR-0008, devlog/_plan/260905_go_sidecar_takeover).
//
// Today it owns GET /api/system/health (volatile pid/uptime normalised by the
// oracle) and GET /api/shadow-call-settings (a pure function of config.json,
// compared with no normalisation at all). Each handler must reproduce the
// TypeScript handler's HTTP semantics byte-for-byte: the shape, key order, and
// number formatting of the JSON body are part of the contract. The Bun
// differential harness compares the wire bodies, so this package's payload
// struct field order and its use of encoding/json (shortest round-trip number
// formatting, matching ECMAScript) are load-bearing, not cosmetic.
package sidecar

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

// Config carries the values the sidecar must echo from its TypeScript parent.
// Service and Version are labels owned by the parent process: they must equal
// the TS handler's values exactly, which is why the supervisor passes the
// installed package version at spawn time rather than letting the sidecar
// derive or guess it. Uptime and pid are NOT config: they are the sidecar's
// own process values, which is the divergence class the oracle exists to pin.
type Config struct {
	// Service is the service label the TS handler reports ("opencodex").
	Service string
	// Version is the installed package version the TS parent passes in
	// OCX_SIDECAR_VERSION. Empty means the parent did not pass one; the
	// sidecar then reports "0.0.0" exactly like the TS VERSION fallback,
	// rather than inventing a value.
	Version string
	// StartedAt anchors the uptime clock; the handler reports
	// time.Since(StartedAt).Seconds() at request time, mirroring
	// process.uptime().
	StartedAt time.Time
	// ConfigDir overrides the config directory for routes that read the
	// operator's config.json (GET /api/shadow-call-settings). Empty defers to
	// the environment: OPENCODEX_HOME, then ~/.opencodex -- the same
	// resolution as src/config/paths.ts in the parent. Set explicitly only by
	// unit tests; the supervisor inherits OPENCODEX_HOME at spawn time.
	ConfigDir string
}

// healthPayload mirrors the JSON object literal in
// src/server/management/system-routes.ts. Field order is the byte contract:
// encoding/json emits struct fields in declaration order and the TS handler
// emits object keys in insertion order, and both orders must agree.
type healthPayload struct {
	Status  string  `json:"status"`
	Service string  `json:"service"`
	Version string  `json:"version"`
	Uptime  float64 `json:"uptime"`
	Pid     int     `json:"pid"`
}

// NewHandler builds the sidecar's HTTP surface: exactly the declared Go-owned
// read routes. Every other path or method falls through to Go's default
// ServeMux 404/405 so the sidecar never invents management surface of its own.
// The TypeScript front door only forwards declared routes, so this handler
// never sees another request while the seam is wired correctly.
func NewHandler(cfg Config) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/system/health", func(w http.ResponseWriter, r *http.Request) {
		version := cfg.Version
		if version == "" {
			version = "0.0.0"
		}
		service := cfg.Service
		if service == "" {
			service = "opencodex"
		}
		startedAt := cfg.StartedAt
		if startedAt.IsZero() {
			startedAt = time.Now()
		}
		payload := healthPayload{
			Status:  "ok",
			Service: service,
			Version: version,
			Uptime:  time.Since(startedAt).Seconds(),
			Pid:     os.Getpid(),
		}
		respondJSON(w, payload, "health")
	})

	// GET /api/shadow-call-settings (ticket #16): the body is a pure function
	// of the operator's config.json shadowCallIntercept section, so the sidecar
	// reads the same file the in-process TS handler's config snapshot came from
	// and projects it through the same rules. Unlike health there is no
	// process-specific value, so the differential oracle compares these bytes
	// with NO normalisation — any drift is a real divergence. The config is
	// read per request (the sidecar carries no state) from cfg.ConfigDir or the
	// OPENCODEX_HOME / ~/.opencodex resolution the TS parent uses.
	mux.HandleFunc("GET /api/shadow-call-settings", func(w http.ResponseWriter, r *http.Request) {
		loaded, err := loadSidecarConfig(cfg.ConfigDir)
		if err != nil {
			// A missing or unreadable config is an empty Config (the TS runtime
			// defaults too); a malformed file was already logged by the loader.
			loaded = &config.Config{Raw: map[string]any{}}
		}
		view := loaded.ShadowCallSettingsView()
		payload := shadowCallSettingsPayload{
			Enabled:      view.Enabled,
			Model:        view.Model,
			SourceModels: view.SourceModels,
		}
		respondJSON(w, payload, "shadow-call-settings")
	})
	return mux
}

// loadSidecarConfig is the config-file loader used by the shadow-call route.
// An explicit dir (unit tests) wins; otherwise the same OPENCODEX_HOME then
// ~/.opencodex resolution the TS parent uses at spawn.
func loadSidecarConfig(configDir string) (*config.Config, error) {
	if configDir != "" {
		return config.LoadFromDir(configDir)
	}
	return config.Load()
}

// respondJSON writes a fixed-shape payload exactly the way the TS handlers
// emit jsonResponse: Content-Type application/json, a 200 status, and the
// marshalled bytes with NO trailing newline (Encoder.Encode would append one
// and the differential oracle compares bytes). On the impossible marshal error
// it logs and writes nothing rather than emitting a partial body.
func respondJSON(w http.ResponseWriter, payload any, owner string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	raw, err := json.Marshal(payload)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ocx-sidecar: marshal %s payload: %v\n", owner, err)
		return
	}
	if _, err := w.Write(raw); err != nil {
		fmt.Fprintf(os.Stderr, "ocx-sidecar: write %s payload: %v\n", owner, err)
	}
}

// shadowCallSettingsPayload mirrors the JSON object literal in
// src/server/management/config-routes.ts (GET /api/shadow-call-settings). Field
// order is the byte contract, matching the TS handler's insertion order. Model
// is the raw decoded value (normally a string; a non-string value in the file
// is echoed as-is, exactly like the TS projection sci.model ?? "" collapses
// only null/absent).
type shadowCallSettingsPayload struct {
	Enabled      bool     `json:"enabled"`
	Model        any      `json:"model"`
	SourceModels []string `json:"sourceModels"`
}

// ReadyLinePrefix is the stdout marker the TypeScript supervisor parses to
// learn the sidecar's bound address. The full line is
// "<prefix> http://<host>:<port>"; see the supervisor's reader in
// src/server/go-sidecar.ts. Parsing is deliberately trivial (a space-separated
// http URL) so the parent never needs a JSON handshake to supervise the
// sidecar.
const ReadyLinePrefix = "ocx-sidecar-ready"
