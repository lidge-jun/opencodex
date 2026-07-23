package management

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func (a *API) handleModels(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path == "/api/models" && r.Method == http.MethodGet {
		models := []types.ModelEntry{}
		if a.registry != nil {
			models = a.registry.ListModels()
		}
		a.mu.RLock()
		custom := make([]CustomModel, 0, len(a.customModels))
		for _, model := range a.customModels {
			custom = append(custom, model)
		}
		a.mu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{"models": models, "customModels": custom})
		return true
	}
	if strings.HasPrefix(r.URL.Path, "/api/custom-models") {
		return a.handleCustomModels(w, r)
	}
	if r.URL.Path == "/api/model-aliases" {
		if r.Method == http.MethodGet {
			a.mu.RLock()
			aliases := cloneStringMap(a.aliases)
			a.mu.RUnlock()
			writeJSON(w, http.StatusOK, aliases)
			return true
		}
		if r.Method == http.MethodPut {
			var body struct {
				Aliases map[string]string `json:"aliases"`
			}
			if !decodeJSON(w, r, &body) {
				return true
			}
			for alias, target := range body.Aliases {
				if validateIdentifier(alias, "alias") != nil || strings.TrimSpace(target) == "" {
					writeError(w, http.StatusBadRequest, "invalid model alias")
					return true
				}
			}
			a.mu.Lock()
			a.aliases = cloneStringMap(body.Aliases)
			a.mu.Unlock()
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "aliases": body.Aliases})
			return true
		}
	}
	if r.URL.Path == "/api/provider-context-caps" {
		if r.Method == http.MethodGet {
			a.mu.RLock()
			caps := cloneIntMap(a.contextCaps)
			a.mu.RUnlock()
			writeJSON(w, http.StatusOK, map[string]any{"caps": caps})
			return true
		}
		if r.Method == http.MethodPut {
			var body struct {
				Provider string `json:"provider"`
				Enabled  bool   `json:"enabled"`
				Value    int    `json:"value,omitempty"`
			}
			if !decodeJSON(w, r, &body) {
				return true
			}
			if validateIdentifier(body.Provider, "provider") != nil {
				writeError(w, http.StatusBadRequest, "invalid provider")
				return true
			}
			if body.Enabled && body.Value <= 0 {
				writeError(w, http.StatusBadRequest, "value must be a positive integer")
				return true
			}
			a.mu.Lock()
			if body.Enabled {
				a.contextCaps[body.Provider] = body.Value
			} else {
				delete(a.contextCaps, body.Provider)
			}
			caps := cloneIntMap(a.contextCaps)
			a.mu.Unlock()
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "caps": caps})
			return true
		}
	}
	return false
}

func (a *API) handleCustomModels(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path == "/api/custom-models" {
		switch r.Method {
		case http.MethodGet:
			a.mu.RLock()
			models := make([]CustomModel, 0, len(a.customModels))
			for _, model := range a.customModels {
				models = append(models, model)
			}
			a.mu.RUnlock()
			sort.Slice(models, func(i, j int) bool { return models[i].AddedAt < models[j].AddedAt })
			writeJSON(w, http.StatusOK, models)
		case http.MethodPost:
			var body struct {
				Provider        string   `json:"provider"`
				ModelID         string   `json:"modelId"`
				DisplayName     string   `json:"displayName,omitempty"`
				ContextWindow   int      `json:"contextWindow,omitempty"`
				InputModalities []string `json:"inputModalities,omitempty"`
			}
			if !decodeJSON(w, r, &body) {
				return true
			}
			body.Provider = strings.TrimSpace(body.Provider)
			body.ModelID = strings.TrimSpace(body.ModelID)
			if validateIdentifier(body.Provider, "provider") != nil || validateIdentifier(body.ModelID, "modelId") != nil || body.ContextWindow < 0 {
				writeError(w, http.StatusBadRequest, "invalid custom model")
				return true
			}
			model := CustomModel{ID: randomID(), Provider: body.Provider, ModelID: body.ModelID, DisplayName: strings.TrimSpace(body.DisplayName), ContextWindow: body.ContextWindow, InputModalities: uniqueStrings(body.InputModalities), AddedAt: time.Now().UTC().Format(time.RFC3339)}
			a.mu.Lock()
			for _, current := range a.customModels {
				if current.Provider == model.Provider && current.ModelID == model.ModelID {
					a.mu.Unlock()
					writeError(w, http.StatusConflict, "duplicate model")
					return true
				}
			}
			a.customModels[model.ID] = model
			a.mu.Unlock()
			writeJSON(w, http.StatusCreated, model)
		default:
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
		return true
	}
	id := r.PathValue("id")
	if id == "" {
		id = strings.TrimPrefix(r.URL.Path, "/api/custom-models/")
	}
	if validateIdentifier(id, "id") != nil {
		writeError(w, http.StatusBadRequest, "invalid model id")
		return true
	}
	switch r.Method {
	case http.MethodPut:
		var body struct {
			DisplayName     *string  `json:"displayName,omitempty"`
			ContextWindow   *int     `json:"contextWindow,omitempty"`
			InputModalities []string `json:"inputModalities,omitempty"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		a.mu.Lock()
		model, found := a.customModels[id]
		if !found {
			a.mu.Unlock()
			writeError(w, http.StatusNotFound, "not found")
			return true
		}
		if body.DisplayName != nil {
			model.DisplayName = strings.TrimSpace(*body.DisplayName)
		}
		if body.ContextWindow != nil {
			if *body.ContextWindow < 0 {
				a.mu.Unlock()
				writeError(w, http.StatusBadRequest, "contextWindow must be non-negative")
				return true
			}
			model.ContextWindow = *body.ContextWindow
		}
		if body.InputModalities != nil {
			model.InputModalities = uniqueStrings(body.InputModalities)
		}
		a.customModels[id] = model
		a.mu.Unlock()
		writeJSON(w, http.StatusOK, model)
	case http.MethodDelete:
		a.mu.Lock()
		if _, found := a.customModels[id]; !found {
			a.mu.Unlock()
			writeError(w, http.StatusNotFound, "not found")
			return true
		}
		delete(a.customModels, id)
		a.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
	return true
}

func randomID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return time.Now().UTC().Format("20060102150405.000000000")
	}
	return hex.EncodeToString(value[:])
}
func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" && !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	return out
}
func cloneStringMap(input map[string]string) map[string]string {
	out := make(map[string]string, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}
func cloneIntMap(input map[string]int) map[string]int {
	out := make(map[string]int, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}
