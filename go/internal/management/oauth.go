package management

import (
	"net/http"
	"strings"
)

func (a *API) handleOAuth(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasPrefix(r.URL.Path, "/api/oauth/") {
		return false
	}
	if a.oauth == nil {
		writeError(w, http.StatusNotImplemented, "OAuth management is not configured")
		return true
	}
	switch r.Method + " " + r.URL.Path {
	case "GET /api/oauth/providers":
		writeJSON(w, http.StatusOK, map[string]any{"providers": a.oauth.Providers()})
	case "POST /api/oauth/login":
		var body struct {
			Provider   string `json:"provider"`
			AddAccount bool   `json:"addAccount,omitempty"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		if err := validateIdentifier(body.Provider, "provider"); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return true
		}
		status, err := a.oauth.Start(r, body.Provider, body.AddAccount)
		if err != nil {
			writeError(w, http.StatusBadGateway, "OAuth login could not start")
			return true
		}
		writeJSON(w, http.StatusAccepted, status)
	case "POST /api/oauth/login/cancel":
		var body struct {
			Provider string `json:"provider"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		if err := a.oauth.Cancel(body.Provider); err != nil {
			writeError(w, http.StatusBadGateway, "OAuth login could not be cancelled")
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "POST /api/oauth/login/code":
		var body struct {
			Provider string `json:"provider"`
			Code     string `json:"code"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		body.Code = strings.TrimSpace(body.Code)
		if body.Code == "" || len(body.Code) > 4096 {
			writeError(w, http.StatusBadRequest, "code is required")
			return true
		}
		status, err := a.oauth.SubmitCode(r, body.Provider, body.Code)
		if err != nil {
			writeError(w, http.StatusBadGateway, "OAuth code was rejected")
			return true
		}
		writeJSON(w, http.StatusOK, status)
	case "GET /api/oauth/status":
		provider, err := queryRequired(r.URL.Query(), "provider")
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return true
		}
		writeJSON(w, http.StatusOK, a.oauth.Status(provider))
	case "POST /api/oauth/logout":
		var body struct {
			Provider string `json:"provider"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		if err := a.oauth.Logout(r, body.Provider); err != nil {
			writeError(w, http.StatusBadGateway, "OAuth logout failed")
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "GET /api/oauth/accounts":
		provider, err := queryRequired(r.URL.Query(), "provider")
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return true
		}
		accounts, err := a.oauth.Accounts(provider)
		if err != nil {
			writeError(w, http.StatusBadGateway, "OAuth accounts could not be read")
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"provider": provider, "accounts": accounts})
	case "PUT /api/oauth/accounts/active":
		var body struct {
			Provider  string `json:"provider"`
			AccountID string `json:"accountId"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		if err := a.oauth.SetActive(r, body.Provider, body.AccountID); err != nil {
			writeError(w, http.StatusBadRequest, "account could not be activated")
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "PUT /api/oauth/accounts/alias":
		var body struct {
			Provider  string `json:"provider"`
			AccountID string `json:"accountId"`
			Alias     string `json:"alias"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		if len(body.Alias) > 128 {
			writeError(w, http.StatusBadRequest, "alias is too long")
			return true
		}
		if err := a.oauth.SetAlias(r, body.Provider, body.AccountID, strings.TrimSpace(body.Alias)); err != nil {
			writeError(w, http.StatusBadRequest, "account alias could not be updated")
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "DELETE /api/oauth/accounts":
		var body struct {
			Provider  string `json:"provider"`
			AccountID string `json:"accountId"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		if err := a.oauth.RemoveAccount(r, body.Provider, body.AccountID); err != nil {
			writeError(w, http.StatusBadRequest, "account could not be removed")
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
	return true
}
