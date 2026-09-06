// Package config is the shared Go config reader of the incremental runtime
// takeover (ADR-0008, devlog/_plan/260905_go_sidecar_takeover, ticket #16).
//
// It reads the same on-disk config the TypeScript runtime reads
// (OPENCODEX_HOME/config.json, defaulting to ~/.opencodex/config.json) so a
// Go-served management read route can answer from the operator's real state
// instead of a snapshot invented inside the sidecar. The TypeScript side
// validates and normalises the file through its zod pipeline on load
// (src/config.ts); this package deliberately mirrors only the parts of that
// pipeline that the Go-owned read routes depend on, and it does NOT rewrite or
// move the file. Divergence is confined to configs that are invalid enough for
// TypeScript to salvage or back up, which the differential oracle never feeds.
//
// The route bodies this package feeds (today: GET /api/shadow-call-settings)
// are pure functions of the config subsection they read, so byte parity with
// the in-process TypeScript handler holds as long as both processes read the
// same file content. Numbers are decoded with json.Number so a value echoed
// into a response keeps its exact on-disk literal instead of being reformatted
// through float64, which is what byte parity requires for config-derived DTOs.
package config

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// DefaultShadowSourceModels mirrors DEFAULT_SHADOW_SOURCE_MODELS in
// src/lib/shadow-call.ts. It is the value the shadow-call settings read route
// reports when the config carries no usable sourceModels override, and it must
// stay in lockstep with that constant — the differential oracle compares bytes.
var DefaultShadowSourceModels = []string{"gpt-5.6-luna"}

// Dir resolves the config directory exactly like getConfigDir in
// src/config/paths.ts: OPENCODEX_HOME when set (trimmed, a leading ~ expanded),
// otherwise <home>/.opencodex.
func Dir() (string, error) {
	raw := strings.TrimSpace(os.Getenv("OPENCODEX_HOME"))
	if raw == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".opencodex"), nil
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
		return filepath.Join(home, raw[2:]), nil
	}
	return filepath.Clean(raw), nil
}

// Path returns the config file path (getConfigPath in src/config/paths.ts).
func Path() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.json"), nil
}

// Config is the parsed config.json. It holds exactly the subsections the
// Go-owned read routes consume; unknown top-level keys are preserved in Raw so
// a later route can project from them without a schema re-read. This is a
// foundation, not a full schema port: TS-side validation/normalisation is
// replicated only where a Go-owned route body depends on it (see package doc).
type Config struct {
	// Port and Hostname are the listener defaults used by the initial Go CLI
	// diagnostics. Other status projections stay TypeScript-owned until their
	// own parity increments add them.
	Port     int
	Hostname string
	// ShadowCallIntercept mirrors config.shadowCallIntercept (the optional
	// shadow/helper-call rewrite section). Nil when absent from the file.
	ShadowCallIntercept *ShadowCallIntercept
	// Raw is the whole file decoded with numbers preserved as json.Number.
	Raw map[string]any
}

// ShadowCallIntercept mirrors the shadowCallIntercept subsection of OcxConfig
// (src/types/config.ts). Values are kept as decoded JSON (not narrowed to the
// expected types) because the TypeScript runtime stores whatever the file
// carried and the read route's projection is where type coercion happens.
type ShadowCallIntercept struct {
	// Enabled mirrors sci.enabled: the route reports exactly sci.enabled === true.
	Enabled any `json:"enabled"`
	// Model mirrors sci.model, retained as the decoded JSON value so a string
	// stays a string and an absent/null key stays distinguishable.
	Model any `json:"model"`
	// SourceModels mirrors sci.sourceModels (decoded array or nil).
	SourceModels any `json:"sourceModels"`
}

// Load reads and decodes config.json. A missing file yields an empty Config
// (the TypeScript runtime defaults on ENOENT and getDefaultConfig carries no
// shadowCallIntercept). A malformed file yields an empty Config plus the
// decode error: the TypeScript runtime backs the file up and defaults, and the
// Go side must not move user files, so it only logs.
func Load() (*Config, error) {
	path, err := Path()
	if err != nil {
		return nil, err
	}
	return LoadFromPath(path)
}

// LoadFromDir is Load with an explicit config directory (test seam and
// supervisor-injected homes).
func LoadFromDir(dir string) (*Config, error) {
	return LoadFromPath(filepath.Join(dir, "config.json"))
}

// LoadFromPath is the raw loader; the path comes from Path() or LoadFromDir.
func LoadFromPath(path string) (*Config, error) {
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &Config{Raw: map[string]any{}}, nil
		}
		return &Config{Raw: map[string]any{}}, err
	}
	defer file.Close()
	return decode(file)
}

func decode(reader io.Reader) (*Config, error) {
	decoder := json.NewDecoder(reader)
	decoder.UseNumber()
	raw := map[string]any{}
	if err := decoder.Decode(&raw); err != nil {
		log.Printf("ocx-sidecar: config.json is not valid JSON; treating it as empty: %v", err)
		return &Config{Raw: map[string]any{}}, err
	}
	cfg := &Config{Raw: raw}
	if port, ok := raw["port"].(json.Number); ok {
		if parsed, err := port.Int64(); err == nil && parsed > 0 && parsed <= 65535 {
			cfg.Port = int(parsed)
		}
	}
	if hostname, ok := raw["hostname"].(string); ok {
		cfg.Hostname = hostname
	}
	if section, ok := raw["shadowCallIntercept"]; ok {
		if obj, ok := section.(map[string]any); ok {
			cfg.ShadowCallIntercept = &ShadowCallIntercept{
				Enabled:      obj["enabled"],
				Model:        obj["model"],
				SourceModels: obj["sourceModels"],
			}
		}
	}
	return cfg, nil
}

// ListenTarget returns normalized listener defaults for a no-runtime status
// report. The TypeScript default port is 10100.
func (c *Config) ListenTarget() (port int, hostname string) {
	if c.Port > 0 {
		port = c.Port
	} else {
		port = 10100
	}
	return port, c.Hostname
}

// ShadowCallSettings is the projection the shadow-call settings read route
// emits (src/server/management/config-routes.ts, GET /api/shadow-call-settings).
type ShadowCallSettings struct {
	Enabled      bool
	Model        any
	SourceModels []string
}

// ShadowCallSettingsView mirrors the TypeScript handler's projection:
// enabled = sci.enabled === true, model = sci.model ?? "" (so absent or null
// becomes the empty string), and sourceModels = shadowSourceModels(sci.
// sourceModels) from src/lib/shadow-call.ts — non-string entries are dropped,
// entries are trimmed, and an empty result falls back to the default list.
func (c *Config) ShadowCallSettingsView() ShadowCallSettings {
	// Absent section and null model both project to the empty string (the TS
	// handler's `sci.model ?? ""`), so Model starts as "" and only a present,
	// non-null value replaces it.
	out := ShadowCallSettings{Model: ""}
	sci := c.ShadowCallIntercept
	if sci == nil {
		out.SourceModels = defaultSourceModels()
		return out
	}
	out.Enabled = sci.Enabled == true
	if sci.Model != nil {
		out.Model = sci.Model
	}
	out.SourceModels = normalizeSourceModels(sci.SourceModels)
	return out
}

func normalizeSourceModels(configured any) []string {
	normalized := []string{}
	if array, ok := configured.([]any); ok {
		for _, entry := range array {
			value, ok := entry.(string)
			if !ok {
				continue
			}
			trimmed := strings.TrimSpace(value)
			if trimmed != "" {
				normalized = append(normalized, trimmed)
			}
		}
	}
	if len(normalized) == 0 {
		return defaultSourceModels()
	}
	return normalized
}

func defaultSourceModels() []string {
	// Fresh slice per call: a caller must not be able to mutate the shared
	// default and skew a later response.
	return append([]string(nil), DefaultShadowSourceModels...)
}

// SaveRaw atomically replaces config.json with an indented JSON representation
// of raw. It creates the config directory as needed and keeps user config
// private (0600). Validation deliberately belongs to the owning command: this
// shared reader must preserve unknown config fields.
func SaveRaw(raw map[string]any) error {
	path, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	temp, err := os.CreateTemp(filepath.Dir(path), ".config.json-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(encoded); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempName, path)
}
