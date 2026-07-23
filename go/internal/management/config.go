package management

import (
	"net/http"
)

func (a *API) handleConfig(w http.ResponseWriter, r *http.Request) bool {
	switch r.Method + " " + r.URL.Path {
	case "GET /api/config":
		a.mu.RLock()
		defer a.mu.RUnlock()
		writeJSON(w, http.StatusOK, safeConfig(a.config))
		return true
	case "PUT /api/config":
		writeError(w, http.StatusMethodNotAllowed, "Full config PUT is disabled. Use provider and settings routes.")
		return true
	case "GET /api/settings":
		a.mu.RLock()
		defer a.mu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{"port": a.config.Port, "hostname": a.config.Host, "streamMode": a.config.StreamMode})
		return true
	case "PUT /api/settings":
		var body struct {
			StreamMode *string `json:"streamMode"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		if body.StreamMode == nil {
			writeError(w, http.StatusBadRequest, "streamMode is required")
			return true
		}
		if *body.StreamMode != "auto" && *body.StreamMode != "legacy-tee" && *body.StreamMode != "eager-relay" {
			writeError(w, http.StatusBadRequest, "streamMode must be auto, legacy-tee, or eager-relay")
			return true
		}
		a.mu.Lock()
		a.config.StreamMode = *body.StreamMode
		err := a.saveLocked()
		a.mu.Unlock()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "save settings failed")
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "streamMode": *body.StreamMode})
		return true
	case "GET /api/diagnostics/project-config":
		a.mu.RLock()
		defer a.mu.RUnlock()
		warnings := []map[string]string{}
		if err := a.config.Validate(); err != nil {
			warnings = append(warnings, map[string]string{"code": "INVALID_CONFIG", "message": err.Error()})
		}
		writeJSON(w, http.StatusOK, map[string]any{"warnings": warnings})
		return true
	}
	return false
}
