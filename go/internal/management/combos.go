package management

import (
	"net/http"
	"sort"
	"strings"
)

func (a *API) handleCombos(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path == "/api/combos/reset" && r.Method == http.MethodPost {
		a.mu.Lock()
		a.combos = map[string]Combo{}
		a.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
		return true
	}
	if r.URL.Path != "/api/combos" {
		return false
	}
	switch r.Method {
	case http.MethodGet:
		a.mu.RLock()
		values := make([]Combo, 0, len(a.combos))
		for _, combo := range a.combos {
			values = append(values, combo)
		}
		a.mu.RUnlock()
		sort.Slice(values, func(i, j int) bool { return values[i].ID < values[j].ID })
		writeJSON(w, http.StatusOK, map[string]any{"combos": values})
	case http.MethodPut:
		var body struct {
			ID         string `json:"id"`
			RenameFrom string `json:"renameFrom,omitempty"`
			Combo      Combo  `json:"combo"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		body.ID = strings.TrimSpace(body.ID)
		if validateIdentifier(body.ID, "id") != nil || len(body.Combo.Targets) == 0 {
			writeError(w, http.StatusBadRequest, "id and at least one target are required")
			return true
		}
		for _, target := range body.Combo.Targets {
			if validateIdentifier(target.Provider, "provider") != nil || strings.TrimSpace(target.Model) == "" {
				writeError(w, http.StatusBadRequest, "invalid combo target")
				return true
			}
		}
		body.Combo.ID = body.ID
		if body.Combo.Strategy == "" {
			body.Combo.Strategy = "fallback"
		}
		a.mu.Lock()
		if body.RenameFrom != "" {
			if _, ok := a.combos[body.RenameFrom]; !ok {
				a.mu.Unlock()
				writeError(w, http.StatusNotFound, "rename source not found")
				return true
			}
			delete(a.combos, body.RenameFrom)
		}
		a.combos[body.ID] = body.Combo
		a.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "id": body.ID, "combo": body.Combo})
	case http.MethodDelete:
		id, err := queryRequired(r.URL.Query(), "id")
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return true
		}
		a.mu.Lock()
		if _, ok := a.combos[id]; !ok {
			a.mu.Unlock()
			writeError(w, http.StatusNotFound, "unknown combo")
			return true
		}
		delete(a.combos, id)
		a.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "id": id})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
	return true
}
