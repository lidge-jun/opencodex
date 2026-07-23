package management

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
	"github.com/lidge-jun/opencodex-go/internal/usage"
)

const maxManagementBody = 2 << 20

type ModelFetcher func(r *http.Request, provider string, providerConfig config.ProviderConfig) ([]types.ModelEntry, error)

type OAuthAccount struct {
	ID          string `json:"id"`
	Alias       string `json:"alias,omitempty"`
	Email       string `json:"email,omitempty"`
	Active      bool   `json:"active"`
	NeedsReauth bool   `json:"needsReauth,omitempty"`
}
type OAuthStatus struct {
	Provider         string `json:"provider"`
	State            string `json:"state"`
	AuthorizationURL string `json:"authorizationUrl,omitempty"`
	Instructions     string `json:"instructions,omitempty"`
	Error            string `json:"error,omitempty"`
}
type OAuthBackend interface {
	Providers() []string
	Start(r *http.Request, provider string, addAccount bool) (OAuthStatus, error)
	Cancel(provider string) error
	SubmitCode(r *http.Request, provider, code string) (OAuthStatus, error)
	Status(provider string) OAuthStatus
	Logout(r *http.Request, provider string) error
	Accounts(provider string) ([]OAuthAccount, error)
	SetActive(r *http.Request, provider, accountID string) error
	SetAlias(r *http.Request, provider, accountID, alias string) error
	RemoveAccount(r *http.Request, provider, accountID string) error
}

type CustomModel struct {
	ID              string   `json:"id"`
	Provider        string   `json:"provider"`
	ModelID         string   `json:"modelId"`
	DisplayName     string   `json:"displayName,omitempty"`
	ContextWindow   int      `json:"contextWindow,omitempty"`
	InputModalities []string `json:"inputModalities,omitempty"`
	AddedAt         string   `json:"addedAt"`
}
type ComboTarget struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Effort   string `json:"effort,omitempty"`
}
type Combo struct {
	ID       string        `json:"id"`
	Strategy string        `json:"strategy"`
	Alias    string        `json:"alias,omitempty"`
	Targets  []ComboTarget `json:"targets"`
}
type AgentSettings struct {
	Models            []string `json:"models"`
	InjectionModel    string   `json:"injectionModel,omitempty"`
	InjectionEffort   string   `json:"injectionEffort,omitempty"`
	EffortCap         string   `json:"effortCap,omitempty"`
	SubagentEffortCap string   `json:"subagentEffortCap,omitempty"`
	MaxConcurrency    int      `json:"maxConcurrency"`
	MultiAgentMode    string   `json:"multiAgentMode"`
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": message})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, destination any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxManagementBody)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		if strings.Contains(err.Error(), "request body too large") {
			writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
		} else {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
		}
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "request body must contain one JSON value")
		return false
	}
	return true
}

func publicProvider(name string, provider config.ProviderConfig) map[string]any {
	return map[string]any{"name": name, "adapter": provider.Adapter, "baseUrl": provider.BaseURL, "defaultModel": provider.DefaultModel, "hasApiKey": provider.APIKey != "", "allowPrivateNetwork": provider.AllowPrivateNetwork, "models": provider.Models, "authMode": provider.AuthMode, "disabled": provider.Disabled}
}

func safeConfig(value *config.Config) map[string]any {
	providers := make([]map[string]any, 0, len(value.Providers))
	for name, provider := range value.Providers {
		providers = append(providers, publicProvider(name, provider))
	}
	return map[string]any{"port": value.Port, "hostname": value.Host, "defaultProvider": value.DefaultProvider, "streamMode": value.StreamMode, "debug": value.Debug, "log": value.Log, "providers": providers}
}

func validateIdentifier(value, field string) error {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 || strings.ContainsAny(value, "/\\\x00") {
		return fmt.Errorf("%s is invalid", field)
	}
	return nil
}
func queryRequired(values url.Values, key string) (string, error) {
	value := strings.TrimSpace(values.Get(key))
	if err := validateIdentifier(value, key); err != nil {
		return "", err
	}
	return value, nil
}

func metricDTO(entry RequestLogEntry) map[string]any {
	result := map[string]any{"requestId": entry.RequestID, "timestamp": entry.Timestamp, "provider": entry.Provider, "model": entry.Model, "status": entry.Status, "durationMs": entry.DurationMS, "usageStatus": entry.UsageStatus, "usage": entry.Usage}
	metrics := map[string]any{}
	if entry.Usage != nil {
		if speed, ok := usage.TokensPerSecond(entry.Usage.OutputTokens, entry.DurationMS); ok {
			metrics["tokPerSecond"] = map[string]any{"kind": "value", "value": speed, "estimated": entry.Usage.Estimated}
		} else {
			metrics["tokPerSecond"] = map[string]any{"kind": "unavailable", "reason": "output_missing"}
		}
		if estimate, ok := usage.EstimateCost(entry.Provider, entry.Model, *entry.Usage, entry.UsageStatus, nil); ok {
			metrics["cost"] = map[string]any{"kind": "value", "estimate": estimate}
		} else {
			metrics["cost"] = map[string]any{"kind": "unavailable", "reason": "price_unmatched"}
		}
	} else {
		metrics["tokPerSecond"] = map[string]any{"kind": "unavailable", "reason": "usage_missing"}
		metrics["cost"] = map[string]any{"kind": "unavailable", "reason": "usage_missing"}
	}
	result["displayMetrics"] = metrics
	return result
}
