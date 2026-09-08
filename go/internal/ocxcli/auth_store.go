// Auth-store reads and rewrites for the Go-owned credential commands
// (ocx logout today; ocx login OAuth persistence joins it on the same seam).
//
// The store lives at <config-dir>/auth.json and is owned by TypeScript's
// src/oauth/store.ts: multiauth values are `{ activeAccountId, accounts: [...] }`
// per provider, each account is `{ id, credential, alias?, needsReauth?,
// addedAt? }`, and credentials are `{ access, refresh, expires, email?,
// accountId?, source?, projectId?, apiBaseUrl?, kiro? }`.
//
// Every Go write must reproduce what store.ts's mutateStore would persist:
// the file is normalised on load (legacy single-credential values become
// multiauth sets, unknown or invalid rows are dropped, key order is rebuilt),
// and the result is written as JSON.stringify(store, null, 2) + "\n". The
// differential oracle pins both the stdout contract and the resulting auth.json
// bytes, so this module mirrors the normalisation exactly rather than only
// mutating the JSON tree.
package ocxcli

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// authStorePath mirrors getAuthStorePath in src/oauth/store.ts.
func authStorePath() (string, error) {
	dir, err := config.Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "auth.json"), nil
}

// readAuthStore loads and normalises auth.json the way loadAuthStoreInternal
// does: a missing file yields an empty store, and a file that is not valid
// JSON yields an empty store too (TypeScript additionally backs the invalid
// file up; the Go CLI must not move user files, so it only logs and proceeds).
// The returned object mirrors the normalised AuthStore: one member per
// provider in file order.
func readAuthStore() (*jsonwire.Value, error) {
	path, err := authStorePath()
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return jsonwire.ObjectValue(), nil
		}
		return nil, err
	}
	parsed, parseErr := jsonwire.Parse(raw)
	if parseErr != nil || parsed.Kind() != jsonwire.Object {
		return jsonwire.ObjectValue(), nil
	}
	return normalizeAuthStore(parsed), nil
}

// writeAuthStore persists the normalised store exactly like store.ts persist():
// JSON.stringify(store, null, 2) followed by a trailing newline.
func writeAuthStore(store *jsonwire.Value) error {
	path, err := authStorePath()
	if err != nil {
		return err
	}
	pretty, err := store.EncodePretty()
	if err != nil {
		return err
	}
	pretty = append(pretty, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, pretty, 0o600)
}

// normalizeAuthStore mirrors normalizeAuthStore in src/oauth/store.ts. Rows
// that do not normalise (no accounts, invalid credential) are dropped; legacy
// single-credential values are upgraded to a one-account multiauth set whose
// account id is sha256(accountId ?? email ?? refresh)[:32].
func normalizeAuthStore(parsed *jsonwire.Value) *jsonwire.Value {
	out := jsonwire.ObjectValue()
	for _, member := range parsed.Members() {
		set := normalizeAccountSet(member.Value)
		if set == nil {
			continue
		}
		out.Set(member.Key, set)
	}
	return out
}

// normalizeAccountSet mirrors normalizeAccountSet: a value with an `accounts`
// array normalises each row and repins the active id; any other object is
// treated as a legacy single credential and upgraded.
func normalizeAccountSet(raw *jsonwire.Value) *jsonwire.Value {
	if raw == nil || raw.Kind() != jsonwire.Object {
		return nil
	}
	accountsArray := raw.Find("accounts")
	if accountsArray != nil && accountsArray.Kind() == jsonwire.Array {
		set := jsonwire.ObjectValue()
		accounts := jsonwire.EmptyArray()
		activeAccountId := ""
		if active := raw.Find("activeAccountId"); active != nil && active.Kind() == jsonwire.String {
			activeAccountId = active.String()
		}
		firstID := ""
		for _, element := range accountsArray.Elements() {
			account := normalizeAccount(element)
			if account == nil {
				continue
			}
			accounts.AppendArray(account)
			if firstID == "" {
				if id := account.Find("id"); id != nil && id.Kind() == jsonwire.String {
					firstID = id.String()
				}
			}
		}
		if len(accounts.Elements()) == 0 {
			return nil
		}
		active := firstID
		if activeAccountId != "" {
			for _, element := range accounts.Elements() {
				if id := element.Find("id"); id != nil && id.Kind() == jsonwire.String && id.String() == activeAccountId {
					active = activeAccountId
					break
				}
			}
		}
		set.Set("activeAccountId", jsonwire.StringValue(active))
		set.Set("accounts", accounts)
		return set
	}
	// Legacy single-credential value.
	credential := normalizeCredential(raw)
	if credential == nil {
		return nil
	}
	id := newAccountID(credential)
	set := jsonwire.ObjectValue()
	account := jsonwire.ObjectValue()
	account.Set("id", jsonwire.StringValue(id))
	account.Set("credential", credential)
	accounts := jsonwire.EmptyArray()
	accounts.AppendArray(account)
	set.Set("activeAccountId", jsonwire.StringValue(id))
	set.Set("accounts", accounts)
	return set
}

// normalizeAccount mirrors normalizeAccount in src/oauth/store.ts.
func normalizeAccount(raw *jsonwire.Value) *jsonwire.Value {
	if raw == nil || raw.Kind() != jsonwire.Object {
		return nil
	}
	id := raw.Find("id")
	if id == nil || id.Kind() != jsonwire.String || id.String() == "" {
		return nil
	}
	credential := normalizeCredential(raw.Find("credential"))
	if credential == nil {
		return nil
	}
	account := jsonwire.ObjectValue()
	account.Set("id", jsonwire.StringValue(id.String()))
	account.Set("credential", credential)
	if alias := raw.Find("alias"); alias != nil && alias.Kind() == jsonwire.String {
		if trimmed := strings.TrimSpace(alias.String()); trimmed != "" {
			account.Set("alias", jsonwire.StringValue(trimmed))
		}
	}
	if needsReauth := raw.Find("needsReauth"); needsReauth != nil && needsReauth.Kind() == jsonwire.Bool && needsReauth.Bool() {
		account.Set("needsReauth", jsonwire.BoolValue(true))
	}
	if addedAt := raw.Find("addedAt"); addedAt != nil && addedAt.Kind() == jsonwire.Number {
		if number, err := numberAsFloat(addedAt); err == nil && number == number { // not NaN
			account.Set("addedAt", jsonwire.NumberFrom(number))
		}
	}
	return account
}

// normalizeCredential mirrors normalizeCredential in src/oauth/store.ts: only
// access/refresh/expires survive unconditionally, followed by the optional
// identity, source, project, and (allowlisted) apiBaseUrl fields.
func normalizeCredential(raw *jsonwire.Value) *jsonwire.Value {
	if raw == nil || raw.Kind() != jsonwire.Object {
		return nil
	}
	access := raw.Find("access")
	refresh := raw.Find("refresh")
	expires := raw.Find("expires")
	if access == nil || access.Kind() != jsonwire.String ||
		refresh == nil || refresh.Kind() != jsonwire.String ||
		expires == nil || expires.Kind() != jsonwire.Number {
		return nil
	}
	out := jsonwire.ObjectValue()
	out.Set("access", jsonwire.StringValue(access.String()))
	out.Set("refresh", jsonwire.StringValue(refresh.String()))
	number, err := numberAsFloat(expires)
	if err != nil {
		return nil
	}
	out.Set("expires", jsonwire.NumberFrom(number))
	setStringIfPresent := func(key string, out *jsonwire.Value) {
		if field := raw.Find(key); field != nil && field.Kind() == jsonwire.String && field.String() != "" {
			out.Set(key, jsonwire.StringValue(field.String()))
		}
	}
	setStringIfPresent("email", out)
	setStringIfPresent("accountId", out)
	if source := raw.Find("source"); source != nil && source.Kind() == jsonwire.String {
		switch source.String() {
		case "oauth", "local-cli", "credential-file", "environment", "manual":
			out.Set("source", jsonwire.StringValue(source.String()))
		}
	}
	setStringIfPresent("projectId", out)
	if apiBaseURL := raw.Find("apiBaseUrl"); apiBaseURL != nil && apiBaseURL.Kind() == jsonwire.String {
		if validated := validateCopilotAPIBaseURL(apiBaseURL.String()); validated != "" {
			out.Set("apiBaseUrl", jsonwire.StringValue(validated))
		}
	}
	if kiro := normalizeKiro(raw.Find("kiro")); kiro != nil {
		out.Set("kiro", kiro)
	}
	return out
}

// normalizeKiro mirrors the kiro block of normalizeCredential: string fields
// survive trimmed when non-empty, within bounds, and free of control chars.
func normalizeKiro(raw *jsonwire.Value) *jsonwire.Value {
	if raw == nil || raw.Kind() != jsonwire.Object {
		return nil
	}
	clean := func(key string, max int) string {
		field := raw.Find(key)
		if field == nil || field.Kind() != jsonwire.String {
			return ""
		}
		value := strings.TrimSpace(field.String())
		if value == "" || len(value) > max {
			return ""
		}
		for _, r := range value {
			if r < 0x20 || r == 0x7f {
				return ""
			}
		}
		return value
	}
	out := jsonwire.ObjectValue()
	profileARN := clean("profileArn", 1024)
	ssoRegion := clean("ssoRegion", 64)
	apiRegion := clean("apiRegion", 64)
	clientID := clean("clientId", 4096)
	clientSecret := clean("clientSecret", 4096)
	if profileARN == "" && ssoRegion == "" && apiRegion == "" && clientID == "" && clientSecret == "" {
		return nil
	}
	if profileARN != "" {
		out.Set("profileArn", jsonwire.StringValue(profileARN))
	}
	if ssoRegion != "" {
		out.Set("ssoRegion", jsonwire.StringValue(ssoRegion))
	}
	if apiRegion != "" {
		out.Set("apiRegion", jsonwire.StringValue(apiRegion))
	}
	if clientID != "" {
		out.Set("clientId", jsonwire.StringValue(clientID))
	}
	if clientSecret != "" {
		out.Set("clientSecret", jsonwire.StringValue(clientSecret))
	}
	return out
}

// newAccountID mirrors newAccountId: sha256 of accountId ?? email ?? refresh,
// hex, first 32 characters.
func newAccountID(credential *jsonwire.Value) string {
	identity := ""
	if field := credential.Find("accountId"); field != nil && field.Kind() == jsonwire.String && field.String() != "" {
		identity = field.String()
	} else if field := credential.Find("email"); field != nil && field.Kind() == jsonwire.String && field.String() != "" {
		identity = field.String()
	} else if field := credential.Find("refresh"); field != nil && field.Kind() == jsonwire.String {
		identity = field.String()
	}
	sum := sha256.Sum256([]byte(identity))
	return hex.EncodeToString(sum[:])[:32]
}

// numberAsFloat reads a jsonwire Number as float64 (V8-style parse).
func numberAsFloat(value *jsonwire.Value) (float64, error) {
	return strconv.ParseFloat(value.NumberRaw(), 64)
}

// validateCopilotAPIBaseURL mirrors validateCopilotApiBaseUrl in
// src/oauth/github-copilot.ts: only https origins under githubcopilot.com
// (or bare api.githubcopilot.com) survive a credential rewrite; everything
// else is dropped so auth.json cannot become an SSRF springboard.
func validateCopilotAPIBaseURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return ""
	}
	if parsed.Scheme != "https" {
		return ""
	}
	if parsed.User != nil {
		return ""
	}
	if parsed.Port() != "" && parsed.Port() != "443" {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "localhost" || host == "127.0.0.1" || host == "::1" || strings.HasSuffix(host, ".localhost") {
		return ""
	}
	if isNumericIPv4(host) || strings.Contains(host, ":") {
		return ""
	}
	if host != "api.githubcopilot.com" && !strings.HasSuffix(host, ".githubcopilot.com") {
		return ""
	}
	return "https://" + host
}

func isNumericIPv4(host string) bool {
	if net.ParseIP(host) == nil {
		return false
	}
	parts := strings.Split(host, ".")
	if len(parts) != 4 {
		return false
	}
	for _, part := range parts {
		if part == "" || len(part) > 3 {
			return false
		}
		for _, r := range part {
			if r < '0' || r > '9' {
				return false
			}
		}
	}
	return true
}
