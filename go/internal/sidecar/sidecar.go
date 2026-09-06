// Package sidecar serves the declared Go-owned management read routes of the
// incremental runtime takeover (ADR-0008, devlog/_plan/260905_go_sidecar_takeover).
//
// Today it owns GET /api/system/health (volatile pid/uptime normalised by the
// oracle), GET /api/shadow-call-settings (a pure function of config.json,
// compared with no normalisation at all) and GET /api/custom-models (the raw
// config.customModels echo, also compared byte-for-byte). Each handler must
// reproduce the TypeScript handler's HTTP semantics byte-for-byte: the shape,
// key order, and number formatting of the JSON body are part of the contract.
package sidecar

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/managementauth"
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
	// ParentURL and BridgeToken identify the private parent endpoint that owns
	// live quota state until the Go runtime flip. RequestToken is required on
	// every forwarded sidecar request, so direct loopback access cannot refresh.
	ParentURL    string
	BridgeToken  string
	RequestToken string
	// WriteRelaySecret signs parent admission claims for public mutations. It is
	// distinct from BridgeToken: the latter only authenticates the child on the
	// private parent hop.
	WriteRelaySecret string
}

const (
	// SidecarRequestHeader proves the parent, rather than an arbitrary local
	// process, asked the sidecar to serve a protected bridge-backed route.
	SidecarRequestHeader = "X-Ocx-Go-Sidecar-Request"
	// SidecarBridgeHeader authenticates the sidecar to the private parent bridge.
	SidecarBridgeHeader    = "X-Ocx-Go-Sidecar-Bridge"
	privateWriteBridgePath = "/__ocx_go_sidecar/write"
	maxWriteBodyBytes      = 2 * 1024 * 1024
)

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
	writeRelay := managementauth.NewWriteRelayVerifier(cfg.WriteRelaySecret)
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
	mux.HandleFunc("/api/shadow-call-settings", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			relayPublicWrite(w, r, cfg, writeRelay, "/api/shadow-call-settings")
			return
		}
		if r.Method != http.MethodGet {
			// Preserve the GET-qualified handler's pre-write ServeMux behavior.
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
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

	// GET /api/custom-models (ticket #17): the TS handler returns
	// JSON.stringify(config.customModels ?? []), i.e. the config subsection echoed
	// back. The subsection is a passthrough in the zod pipeline (verified: unknown
	// keys, key order and non-schema values all survive a save/load round trip), so
	// byte parity needs a document-order echo rather than a typed projection. The
	// sidecar reads the file with the ordered loader and emits JSON.stringify-
	// compatible bytes (compact, insertion order kept, no HTML or U+2028/U+2029
	// escaping, number literals verbatim). Absent or null customModels coalesce to
	// [] exactly like the TS nullish operator.
	mux.HandleFunc("GET /api/custom-models", func(w http.ResponseWriter, r *http.Request) {
		root, err := loadSidecarOrdered(cfg.ConfigDir)
		if err != nil {
			// A missing file yields a null root (no error). A malformed file would
			// have been salvaged by the TS runtime at startup; without it the
			// echo degrades to the nullish fallback, never to a partial body.
			root = nil
		}
		customModels := root.Find("customModels")
		var raw []byte
		if customModels == nil || customModels.IsNull() {
			raw = []byte("[]")
		} else {
			raw, err = customModels.MarshalStringify()
			if err != nil {
				// The ordered tree was decoded from valid JSON, so marshal cannot
				// fail; stay silent rather than emit a partial body.
				fmt.Fprintf(os.Stderr, "ocx-sidecar: marshal custom-models echo: %v\n", err)
				return
			}
		}
		writeRawJSON(w, raw, "custom-models")
	})

	// Ticket #20: provider quota aggregation remains process state until the
	// runtime flip. Go owns this public HTTP route and obtains the existing
	// cache/probe result from a capability-scoped parent loopback bridge, so
	// refresh, invalidation, passive observations and last-good retention keep
	// their established semantics while the wire response stays byte-identical.
	mux.HandleFunc("GET /api/provider-quotas", func(w http.ResponseWriter, r *http.Request) {
		if cfg.RequestToken == "" || !managementauth.EqualSecret(r.Header.Get(SidecarRequestHeader), cfg.RequestToken) {
			http.NotFound(w, r)
			return
		}
		parent, err := url.Parse(cfg.ParentURL)
		if err != nil || parent.Scheme != "http" || parent.Hostname() != "127.0.0.1" || cfg.BridgeToken == "" {
			http.Error(w, "quota state bridge unavailable", http.StatusServiceUnavailable)
			return
		}
		parent.Path = "/__ocx_go_sidecar/provider-quotas"
		parent.RawQuery = r.URL.RawQuery
		bridgeReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, parent.String(), nil)
		if err != nil {
			http.Error(w, "quota state bridge unavailable", http.StatusServiceUnavailable)
			return
		}
		bridgeReq.Header.Set(SidecarBridgeHeader, cfg.BridgeToken)
		bridgeTransport := &http.Transport{
			Proxy:       nil,
			DialContext: (&net.Dialer{}).DialContext,
		}
		defer bridgeTransport.CloseIdleConnections()
		bridgeClient := &http.Client{
			Timeout: 30 * time.Second,
			// The bridge credential must never be sent through HTTP_PROXY or a
			// system proxy. The parent is a literal IPv4 loopback listener.
			Transport: bridgeTransport,
		}
		bridgeResp, err := bridgeClient.Do(bridgeReq)
		if err != nil {
			http.Error(w, "quota state bridge unavailable", http.StatusServiceUnavailable)
			return
		}
		defer bridgeResp.Body.Close()
		raw, err := io.ReadAll(io.LimitReader(bridgeResp.Body, 8*1024*1024+1))
		if err != nil || len(raw) > 8*1024*1024 {
			http.Error(w, "quota state bridge unavailable", http.StatusServiceUnavailable)
			return
		}
		contentType := bridgeResp.Header.Get("Content-Type")
		if contentType == "" {
			contentType = "application/json"
		}
		w.Header().Set("Content-Type", contentType)
		w.WriteHeader(bridgeResp.StatusCode)
		if _, err := w.Write(raw); err != nil {
			fmt.Fprintf(os.Stderr, "ocx-sidecar: write provider-quotas payload: %v\n", err)
		}
	})

	// Ticket #21's public mutation surface is deliberately exact. The sidecar
	// never dispatches by prefix or forwards an unrecognised write: each allowed
	// method/path pair is registered explicitly and the private bridge remains
	// the TypeScript oracle until that route's native mutation lands.
	for _, route := range []string{
		"/api/settings",
		"/api/sidecar-settings",
		"/api/codex-auth/active",
		"/api/codex-auth/pool-strategy",
		"/api/oauth/accounts/active",
		"/api/oauth/accounts/pool",
	} {
		path := route
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			// A method-qualified ServeMux pattern would synthesize 405 for an
			// existing sidecar read probe. Keep the pre-write surface exactly as
			// it was: only an allowlisted PUT exists; every other method is 404.
			if r.Method != http.MethodPut && !(path == "/api/oauth/accounts/pool" && r.Method == http.MethodPatch) && !(path == "/api/codex-auth/pool-strategy" && r.Method == http.MethodPatch) {
				http.NotFound(w, r)
				return
			}
			relayPublicWrite(w, r, cfg, writeRelay, path)
		})
	}
	for _, path := range []string{
		"/api/codex-auth/accounts/clear-cooldown",
		"/api/codex-auth/reset-credits/consume",
		"/api/oauth/accounts/clear-cooldown",
	} {
		path := path
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.NotFound(w, r)
				return
			}
			relayPublicWrite(w, r, cfg, writeRelay, path)
		})
	}
	return mux
}

// relayPublicWrite verifies the parent's request token and one-use relay proof
// before it can contact the private parent bridge. It forwards the original
// bytes and only the authenticated relay metadata; public credentials and
// arbitrary client headers never cross this process boundary.
func relayPublicWrite(w http.ResponseWriter, r *http.Request, cfg Config, verifier *managementauth.WriteRelayVerifier, path string) {
	if cfg.RequestToken == "" || !managementauth.EqualSecret(r.Header.Get(SidecarRequestHeader), cfg.RequestToken) {
		http.NotFound(w, r)
		return
	}
	if r.URL.Path != path || r.URL.RawQuery != "" {
		http.NotFound(w, r)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxWriteBodyBytes+1))
	if err != nil || len(body) > maxWriteBodyBytes {
		http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
		return
	}
	expiresAt, ok := managementauth.ParseWriteRelayExpiry(r.Header.Get(managementauth.WriteRelayExpiresAtHeader))
	relayProof := managementauth.WriteRelayProof{
		Nonce:     r.Header.Get(managementauth.WriteRelayNonceHeader),
		Principal: managementauth.Principal(r.Header.Get(managementauth.WriteRelayPrincipalHeader)),
		Method:    r.Method,
		Path:      path,
		ExpiresAt: expiresAt,
		Proof:     r.Header.Get(managementauth.WriteRelayProofHeader),
	}
	if !ok || !verifier.VerifyAndConsume(relayProof, body) {
		http.Error(w, "write relay unauthorized", http.StatusUnauthorized)
		return
	}

	parent, ok := privateParentBridgeURL(cfg.ParentURL, privateWriteBridgePath)
	if !ok || cfg.BridgeToken == "" {
		http.Error(w, "write state bridge unavailable", http.StatusServiceUnavailable)
		return
	}
	bridgeReq, err := http.NewRequestWithContext(r.Context(), http.MethodPut, parent.String(), bytes.NewReader(body))
	if err != nil {
		http.Error(w, "write state bridge unavailable", http.StatusServiceUnavailable)
		return
	}
	bridgeReq.Header.Set(SidecarBridgeHeader, cfg.BridgeToken)
	bridgeReq.Header.Set(managementauth.WriteRelayNonceHeader, r.Header.Get(managementauth.WriteRelayNonceHeader))
	bridgeReq.Header.Set(managementauth.WriteRelayPrincipalHeader, r.Header.Get(managementauth.WriteRelayPrincipalHeader))
	bridgeReq.Header.Set("X-Ocx-Go-Sidecar-Relay-Method", r.Method)
	bridgeReq.Header.Set("X-Ocx-Go-Sidecar-Relay-Path", path)
	bridgeReq.Header.Set(managementauth.WriteRelayExpiresAtHeader, r.Header.Get(managementauth.WriteRelayExpiresAtHeader))
	bridgeReq.Header.Set(managementauth.WriteRelayProofHeader, r.Header.Get(managementauth.WriteRelayProofHeader))
	if contentType := r.Header.Get("Content-Type"); contentType != "" {
		bridgeReq.Header.Set("Content-Type", contentType)
	}

	bridgeResp, err := privateBridgeClient().Do(bridgeReq)
	if err != nil {
		http.Error(w, "write state bridge unavailable", http.StatusServiceUnavailable)
		return
	}
	defer bridgeResp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(bridgeResp.Body, 8*1024*1024+1))
	if err != nil || len(raw) > 8*1024*1024 {
		http.Error(w, "write state bridge unavailable", http.StatusServiceUnavailable)
		return
	}
	if contentType := bridgeResp.Header.Get("Content-Type"); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	if retryAfter := bridgeResp.Header.Get("Retry-After"); retryAfter != "" {
		w.Header().Set("Retry-After", retryAfter)
	}
	w.WriteHeader(bridgeResp.StatusCode)
	if _, err := w.Write(raw); err != nil {
		fmt.Fprintf(os.Stderr, "ocx-sidecar: write relay response: %v\\n", err)
	}
}

// privateParentBridgeURL derives the exact private route from the loopback
// parent URL supplied to the sidecar in OCX_SIDECAR_PARENT_URL. Credentials,
// proxy destinations and public hosts are rejected before any request occurs.
func privateParentBridgeURL(raw, bridgePath string) (*url.URL, bool) {
	parent, err := url.Parse(raw)
	if err != nil || parent.Scheme != "http" || parent.Hostname() != "127.0.0.1" || parent.User != nil || parent.Fragment != "" {
		return nil, false
	}
	if parent.Port() == "" || !strings.HasPrefix(bridgePath, "/__ocx_go_sidecar/") {
		return nil, false
	}
	parent.Path = bridgePath
	parent.RawPath = ""
	parent.RawQuery = ""
	return parent, true
}

func privateBridgeClient() *http.Client {
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{}).DialContext}
	return &http.Client{
		Timeout:   30 * time.Second,
		Transport: transport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
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

// loadSidecarOrdered loads config.json through the ordered decoder used by the
// echo routes. An explicit dir (unit tests) wins; otherwise the same
// OPENCODEX_HOME then ~/.opencodex resolution the TS parent uses at spawn.
func loadSidecarOrdered(configDir string) (*config.OrderedValue, error) {
	if configDir != "" {
		return config.LoadOrderedFromDir(configDir)
	}
	return config.LoadOrdered()
}

// writeRawJSON writes pre-marshalled bytes exactly the way the TS handlers
// emit jsonResponse: Content-Type application/json, 200, no trailing newline.
// The echo routes marshal through the ordered tree first, so the bytes are
// already the byte contract; re-marshalling would reformat them.
func writeRawJSON(w http.ResponseWriter, raw []byte, owner string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(raw); err != nil {
		fmt.Fprintf(os.Stderr, "ocx-sidecar: write %s payload: %v\n", owner, err)
	}
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
