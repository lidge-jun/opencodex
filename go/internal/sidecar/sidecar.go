// Package sidecar is the first Go-owned route of the incremental runtime
// takeover (ADR-0008, devlog/_plan/260905_go_sidecar_takeover).
//
// It owns exactly one management route -- GET /api/system/health -- and must
// reproduce the TypeScript handler's HTTP semantics byte-for-byte after the
// caller normalises the declared volatile fields (pid, uptime). The shape,
// key order, and number formatting of the JSON body are part of that contract:
// the Bun differential harness compares the normalised wire bodies, so this
// package's payload struct field order and its use of encoding/json (shortest
// round-trip number formatting, matching ECMAScript) are load-bearing, not
// cosmetic.
package sidecar

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"
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

// NewHandler builds the sidecar's HTTP surface: exactly GET /api/system/health.
// Every other path or method falls through to Go's default ServeMux 404/405 so
// the sidecar never invents management surface of its own. The TypeScript front
// door only forwards the one route, so this handler never sees another request
// while the seam is wired correctly.
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
		// Same header the TS handler produces via jsonResponse without a
		// request/config pair: Content-Type application/json, nothing else.
		// Header names are case-insensitive on the wire, but the harness
		// compares them case-insensitively anyway.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		// json.Marshal (not an Encoder): Encoder.Encode appends a trailing
		// newline, and the TS handler emits none — the differential oracle
		// compares bytes, so the newline would be a divergence.
		raw, err := json.Marshal(payload)
		if err != nil {
			// Unreachable for this fixed struct, but never write a partial body.
			fmt.Fprintf(os.Stderr, "ocx-sidecar: marshal health payload: %v\n", err)
			return
		}
		if _, err := w.Write(raw); err != nil {
			fmt.Fprintf(os.Stderr, "ocx-sidecar: write health payload: %v\n", err)
		}
	})
	return mux
}

// ReadyLinePrefix is the stdout marker the TypeScript supervisor parses to
// learn the sidecar's bound address. The full line is
// "<prefix> http://<host>:<port>"; see the supervisor's reader in
// src/server/go-sidecar.ts. Parsing is deliberately trivial (a space-separated
// http URL) so the parent never needs a JSON handshake to supervise a health
// sidecar.
const ReadyLinePrefix = "ocx-sidecar-ready"
