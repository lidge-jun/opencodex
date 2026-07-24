package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/combos"
)

const (
	DefaultPort = 10100
	DefaultHost = "127.0.0.1"
)

var providerNamePattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$`)

type Config struct {
	Port            int                       `json:"port"`
	Host            string                    `json:"hostname,omitempty"`
	AuthToken       string                    `json:"authToken,omitempty"`
	Providers       map[string]ProviderConfig `json:"providers"`
	Combos          map[string]combos.Combo   `json:"combos,omitempty"`
	DefaultProvider string                    `json:"defaultProvider"`
	StreamMode      string                    `json:"streamMode,omitempty"`
	Debug           DebugConfig               `json:"debug,omitempty"`
	Log             LogConfig                 `json:"log,omitempty"`
}

type ProviderConfig struct {
	Adapter                 string                       `json:"adapter"`
	BaseURL                 string                       `json:"baseUrl"`
	ResponsesPath           string                       `json:"responsesPath,omitempty"`
	AllowPrivateNetwork     bool                         `json:"allowPrivateNetwork,omitempty"`
	Disabled                bool                         `json:"disabled,omitempty"`
	APIKey                  string                       `json:"apiKey,omitempty"`
	DefaultModel            string                       `json:"defaultModel,omitempty"`
	Models                  []string                     `json:"models,omitempty"`
	Headers                 map[string]string            `json:"headers,omitempty"`
	AuthMode                string                       `json:"authMode,omitempty"`
	ReasoningEfforts        []string                     `json:"reasoningEfforts,omitempty"`
	ModelReasoningEfforts   map[string][]string          `json:"modelReasoningEfforts,omitempty"`
	ReasoningEffortMap      map[string]string            `json:"reasoningEffortMap,omitempty"`
	ModelReasoningEffortMap map[string]map[string]string `json:"modelReasoningEffortMap,omitempty"`
	NoReasoningModels       []string                     `json:"noReasoningModels,omitempty"`
}

type DebugConfig struct {
	Enabled      bool `json:"enabled,omitempty"`
	IncludeStack bool `json:"includeStack,omitempty"`
}

type LogConfig struct {
	Level      string `json:"level,omitempty"`
	File       string `json:"file,omitempty"`
	MaxSizeMB  int    `json:"maxSizeMB,omitempty"`
	MaxBackups int    `json:"maxBackups,omitempty"`
}

func Default() Config {
	return Config{
		Port:            DefaultPort,
		Host:            DefaultHost,
		Providers:       make(map[string]ProviderConfig),
		Combos:          make(map[string]combos.Combo),
		DefaultProvider: "openai",
		StreamMode:      "auto",
	}
}

// Load reads one complete file image, expands environment references in string
// values, applies defaults, and validates the resulting configuration.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	expanded, err := json.Marshal(expandValue(raw))
	if err != nil {
		return nil, fmt.Errorf("expand config: %w", err)
	}

	cfg := Default()
	if err := json.Unmarshal(expanded, &cfg); err != nil {
		return nil, fmt.Errorf("decode config: %w", err)
	}
	if cfg.Providers == nil {
		cfg.Providers = make(map[string]ProviderConfig)
	}
	if cfg.Combos == nil {
		cfg.Combos = make(map[string]combos.Combo)
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// Save writes JSON to a same-directory temporary file and atomically renames it
// over the destination. Configuration files are owner-readable and writable only.
func Save(path string, cfg *Config) error {
	if cfg == nil {
		return &ConfigError{Field: "config", Message: "must not be nil"}
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	data = append(data, '\n')

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary config: %w", err)
	}
	tmpPath := tmp.Name()
	committed := false
	defer func() {
		_ = tmp.Close()
		if !committed {
			_ = os.Remove(tmpPath)
		}
	}()

	if err := tmp.Chmod(0o600); err != nil {
		return fmt.Errorf("protect temporary config: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		return fmt.Errorf("write temporary config: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("sync temporary config: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temporary config: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("replace config: %w", err)
	}
	committed = true
	return nil
}

func (c Config) Validate() error {
	if c.Port < 0 || c.Port > 65535 {
		return &ConfigError{Field: "port", Message: "must be between 0 and 65535"}
	}
	if strings.TrimSpace(c.Host) == "" {
		return &ConfigError{Field: "hostname", Message: "must not be blank"}
	}
	if strings.TrimSpace(c.DefaultProvider) == "" {
		return &ConfigError{Field: "defaultProvider", Message: "must not be blank"}
	}
	switch c.StreamMode {
	case "", "auto", "legacy-tee", "eager-relay":
	default:
		return &ConfigError{Field: "streamMode", Message: "must be auto, legacy-tee, or eager-relay"}
	}
	for name, provider := range c.Providers {
		reservedName := strings.ToLower(name)
		if !providerNamePattern.MatchString(name) || reservedName == "constructor" || reservedName == "prototype" || reservedName == "__proto__" {
			return &ConfigError{Field: "providers." + name, Message: "invalid provider name"}
		}
		if strings.TrimSpace(provider.Adapter) == "" {
			return &ConfigError{Field: "providers." + name + ".adapter", Message: "must not be blank"}
		}
		parsed, err := url.ParseRequestURI(strings.TrimSpace(provider.BaseURL))
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return &ConfigError{Field: "providers." + name + ".baseUrl", Message: "must be an http(s) URL"}
		}
		if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return &ConfigError{Field: "providers." + name + ".baseUrl", Message: "must not contain credentials, query, or fragment"}
		}
	}
	for id, combo := range c.Combos {
		if err := combos.ValidateBasic(id, combo); err != nil {
			return &ConfigError{Field: "combos." + id, Message: err.Error()}
		}
	}
	return nil
}

func expandValue(value any) any {
	switch v := value.(type) {
	case string:
		return os.ExpandEnv(v)
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = expandValue(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = expandValue(item)
		}
		return out
	default:
		return value
	}
}

type ConfigError struct {
	Field   string
	Message string
}

func (e *ConfigError) Error() string {
	if e == nil {
		return "invalid configuration"
	}
	return fmt.Sprintf("invalid configuration %s: %s", e.Field, e.Message)
}

func IsConfigError(err error) bool {
	var target *ConfigError
	return errors.As(err, &target)
}
