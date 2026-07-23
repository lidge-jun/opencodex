package management

import (
	"net/http"
	"strings"
)

var allowedEfforts = map[string]bool{"low": true, "medium": true, "high": true, "xhigh": true}

func (a *API) handleAgents(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case "/api/subagent-models":
		if r.Method == http.MethodGet {
			a.mu.RLock()
			models := append([]string(nil), a.agents.Models...)
			a.mu.RUnlock()
			writeJSON(w, http.StatusOK, map[string]any{"chosen": models})
			return true
		}
		if r.Method == http.MethodPut {
			var body struct {
				Models []string `json:"models"`
			}
			if !decodeJSON(w, r, &body) {
				return true
			}
			body.Models = uniqueStrings(body.Models)
			if len(body.Models) > 5 {
				body.Models = body.Models[:5]
			}
			a.mu.Lock()
			a.agents.Models = body.Models
			a.mu.Unlock()
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "applied": body.Models})
			return true
		}
	case "/api/injection-model":
		if r.Method == http.MethodGet {
			a.mu.RLock()
			settings := a.agents
			a.mu.RUnlock()
			writeJSON(w, http.StatusOK, map[string]any{"model": nullable(settings.InjectionModel), "effort": nullable(settings.InjectionEffort), "efforts": []string{"low", "medium", "high", "xhigh"}})
			return true
		}
		if r.Method == http.MethodPut {
			var body struct {
				Model  *string `json:"model,omitempty"`
				Effort *string `json:"effort,omitempty"`
			}
			if !decodeJSON(w, r, &body) {
				return true
			}
			a.mu.Lock()
			if body.Model != nil {
				a.agents.InjectionModel = strings.TrimSpace(*body.Model)
				if a.agents.InjectionModel == "" {
					a.agents.InjectionEffort = ""
				}
			}
			if body.Effort != nil {
				value := strings.TrimSpace(*body.Effort)
				if value != "" && !allowedEfforts[value] {
					a.mu.Unlock()
					writeError(w, http.StatusBadRequest, "unknown reasoning effort")
					return true
				}
				if a.agents.InjectionModel == "" && value != "" {
					a.mu.Unlock()
					writeError(w, http.StatusBadRequest, "effort requires a model")
					return true
				}
				a.agents.InjectionEffort = value
			}
			settings := a.agents
			a.mu.Unlock()
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "model": nullable(settings.InjectionModel), "effort": nullable(settings.InjectionEffort)})
			return true
		}
	case "/api/effort-caps":
		if r.Method == http.MethodGet {
			a.mu.RLock()
			settings := a.agents
			a.mu.RUnlock()
			writeJSON(w, http.StatusOK, map[string]any{"effortCap": nullable(settings.EffortCap), "subagentEffortCap": nullable(settings.SubagentEffortCap), "efforts": []string{"low", "medium", "high", "xhigh"}})
			return true
		}
		if r.Method == http.MethodPut {
			var body struct {
				EffortCap         *string `json:"effortCap,omitempty"`
				SubagentEffortCap *string `json:"subagentEffortCap,omitempty"`
			}
			if !decodeJSON(w, r, &body) {
				return true
			}
			for _, value := range []*string{body.EffortCap, body.SubagentEffortCap} {
				if value != nil && *value != "" && !allowedEfforts[*value] {
					writeError(w, http.StatusBadRequest, "unknown reasoning effort")
					return true
				}
			}
			a.mu.Lock()
			if body.EffortCap != nil {
				a.agents.EffortCap = *body.EffortCap
			}
			if body.SubagentEffortCap != nil {
				a.agents.SubagentEffortCap = *body.SubagentEffortCap
			}
			settings := a.agents
			a.mu.Unlock()
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "effortCap": nullable(settings.EffortCap), "subagentEffortCap": nullable(settings.SubagentEffortCap)})
			return true
		}
	case "/api/v2":
		if r.Method == http.MethodGet {
			a.mu.RLock()
			settings := a.agents
			a.mu.RUnlock()
			writeJSON(w, http.StatusOK, map[string]any{"enabled": settings.MultiAgentMode == "v2", "multiAgentMode": settings.MultiAgentMode, "maxConcurrentThreadsPerSession": settings.MaxConcurrency})
			return true
		}
		if r.Method == http.MethodPut {
			var body struct {
				Enabled        *bool   `json:"enabled,omitempty"`
				MultiAgentMode *string `json:"multiAgentMode,omitempty"`
				MaxConcurrency *int    `json:"maxConcurrentThreadsPerSession,omitempty"`
			}
			if !decodeJSON(w, r, &body) {
				return true
			}
			if body.MultiAgentMode != nil && *body.MultiAgentMode != "v1" && *body.MultiAgentMode != "v2" && *body.MultiAgentMode != "default" {
				writeError(w, http.StatusBadRequest, "multiAgentMode must be v1, default, or v2")
				return true
			}
			if body.MaxConcurrency != nil && *body.MaxConcurrency < 1 {
				writeError(w, http.StatusBadRequest, "max concurrency must be at least 1")
				return true
			}
			if body.Enabled != nil && body.MultiAgentMode != nil && ((*body.Enabled && *body.MultiAgentMode == "v1") || (!*body.Enabled && *body.MultiAgentMode == "v2")) {
				writeError(w, http.StatusBadRequest, "enabled conflicts with multiAgentMode")
				return true
			}
			a.mu.Lock()
			if body.MultiAgentMode != nil {
				a.agents.MultiAgentMode = *body.MultiAgentMode
			} else if body.Enabled != nil {
				if *body.Enabled {
					a.agents.MultiAgentMode = "v2"
				} else {
					a.agents.MultiAgentMode = "v1"
				}
			}
			if body.MaxConcurrency != nil {
				a.agents.MaxConcurrency = *body.MaxConcurrency
			}
			settings := a.agents
			a.mu.Unlock()
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "enabled": settings.MultiAgentMode == "v2", "multiAgentMode": settings.MultiAgentMode, "maxConcurrentThreadsPerSession": settings.MaxConcurrency})
			return true
		}
	}
	return false
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}
