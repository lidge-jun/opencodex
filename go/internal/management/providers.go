package management

import (
	"net/http"
	"sort"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
)

func (a *API) handleProviders(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path == "/api/provider-presets" && r.Method == http.MethodGet {
		presets := registry.DeriveProviderPresets(registry.Providers)
		writeJSON(w, http.StatusOK, map[string]any{"providers": presets})
		return true
	}
	if r.URL.Path == "/api/providers/test" && r.Method == http.MethodPost {
		return a.testProvider(w, r)
	}
	if r.URL.Path != "/api/providers" {
		return false
	}
	switch r.Method {
	case http.MethodGet:
		a.mu.RLock()
		names := make([]string, 0, len(a.config.Providers))
		for name := range a.config.Providers {
			names = append(names, name)
		}
		sort.Strings(names)
		rows := make([]map[string]any, 0, len(names))
		for _, name := range names {
			rows = append(rows, publicProvider(name, a.config.Providers[name]))
		}
		a.mu.RUnlock()
		writeJSON(w, http.StatusOK, rows)
	case http.MethodPost:
		var body struct {
			Name       string                `json:"name"`
			Provider   config.ProviderConfig `json:"provider"`
			SetDefault bool                  `json:"setDefault,omitempty"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		body.Name = strings.TrimSpace(body.Name)
		if err := validateIdentifier(body.Name, "name"); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return true
		}
		a.mu.Lock()
		candidate := *a.config
		candidate.Providers = cloneProviders(a.config.Providers)
		candidate.Providers[body.Name] = body.Provider
		if body.SetDefault {
			candidate.DefaultProvider = body.Name
		}
		if err := candidate.Validate(); err != nil {
			a.mu.Unlock()
			writeError(w, http.StatusBadRequest, err.Error())
			return true
		}
		a.config.Providers = candidate.Providers
		a.config.DefaultProvider = candidate.DefaultProvider
		err := a.saveLocked()
		a.mu.Unlock()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "save provider failed")
			return true
		}
		writeJSON(w, http.StatusCreated, map[string]any{"success": true, "name": body.Name})
	case http.MethodPatch:
		name, err := queryRequired(r.URL.Query(), "name")
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return true
		}
		var patch map[string]any
		if !decodeJSON(w, r, &patch) {
			return true
		}
		if _, found := patch["apiKey"]; found {
			writeError(w, http.StatusBadRequest, "apiKey cannot be patched here")
			return true
		}
		a.mu.Lock()
		provider, found := a.config.Providers[name]
		if !found {
			a.mu.Unlock()
			writeError(w, http.StatusNotFound, "unknown provider")
			return true
		}
		if err = applyProviderPatch(&provider, patch); err == nil {
			candidate := *a.config
			candidate.Providers = cloneProviders(a.config.Providers)
			candidate.Providers[name] = provider
			err = candidate.Validate()
			if err == nil {
				a.config.Providers = candidate.Providers
				err = a.saveLocked()
			}
		}
		a.mu.Unlock()
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "name": name, "disabled": provider.Disabled, "hasApiKey": provider.APIKey != ""})
	case http.MethodDelete:
		name, err := queryRequired(r.URL.Query(), "name")
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return true
		}
		a.mu.Lock()
		if _, found := a.config.Providers[name]; !found {
			a.mu.Unlock()
			writeError(w, http.StatusNotFound, "unknown provider")
			return true
		}
		if name == a.config.DefaultProvider {
			a.mu.Unlock()
			writeError(w, http.StatusConflict, "cannot delete the default provider")
			return true
		}
		delete(a.config.Providers, name)
		err = a.saveLocked()
		a.mu.Unlock()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "save provider removal failed")
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
	return true
}

func (a *API) testProvider(w http.ResponseWriter, r *http.Request) bool {
	name, err := queryRequired(r.URL.Query(), "name")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return true
	}
	a.mu.RLock()
	provider, found := a.config.Providers[name]
	a.mu.RUnlock()
	if !found {
		writeError(w, http.StatusNotFound, "unknown provider")
		return true
	}
	if provider.Disabled {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Provider is disabled"})
		return true
	}
	if a.fetchModels == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]any{"ok": false, "error": "live model fetch is not configured"})
		return true
	}
	models, err := a.fetchModels(r, name, provider)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
		return true
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "models": len(models)})
	return true
}

func cloneProviders(input map[string]config.ProviderConfig) map[string]config.ProviderConfig {
	out := make(map[string]config.ProviderConfig, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func applyProviderPatch(provider *config.ProviderConfig, patch map[string]any) error {
	for key, value := range patch {
		switch key {
		case "disabled":
			v, ok := value.(bool)
			if !ok {
				return fieldError(key, "must be a boolean")
			}
			provider.Disabled = v
		case "adapter":
			v, ok := value.(string)
			if !ok || strings.TrimSpace(v) == "" {
				return fieldError(key, "must be a non-empty string")
			}
			provider.Adapter = strings.TrimSpace(v)
		case "baseUrl":
			v, ok := value.(string)
			if !ok || strings.TrimSpace(v) == "" {
				return fieldError(key, "must be a non-empty string")
			}
			provider.BaseURL = strings.TrimSpace(v)
		case "defaultModel":
			v, ok := value.(string)
			if !ok {
				return fieldError(key, "must be a string")
			}
			provider.DefaultModel = strings.TrimSpace(v)
		case "authMode":
			v, ok := value.(string)
			if !ok {
				return fieldError(key, "must be a string")
			}
			if v != "" && v != "key" && v != "forward" && v != "oauth" && v != "local" {
				return fieldError(key, "must be key, forward, oauth, or local")
			}
			provider.AuthMode = v
		case "allowPrivateNetwork":
			v, ok := value.(bool)
			if !ok {
				return fieldError(key, "must be a boolean")
			}
			provider.AllowPrivateNetwork = v
		default:
			return fieldError(key, "is not patchable")
		}
	}
	return nil
}

type fieldValidationError struct{ field, message string }

func (e fieldValidationError) Error() string { return e.field + " " + e.message }
func fieldError(field, message string) error {
	return fieldValidationError{field: field, message: message}
}
