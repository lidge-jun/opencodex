// Shared data-access layer for the Go-owned `ocx account` command family.
//
// This mirrors src/cli/account-api.ts (live-proxy discovery, the /api/*
// management client and its transport sentinel, the account classification
// rules and the apiError taxonomy) plus the pieces of src/cli/account.ts and
// src/cli/account-extended.ts that every subcommand shares (the usage blocks,
// the account table renderer, candidate names). The differential oracle feeds
// the same fixture config + management payloads to the TypeScript CLI and this
// binary and requires byte-identical stdout/stderr and exit codes.
package ocxcli

import (
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// Exit codes from the account CLI taxonomy (account-api.ts apiError and the
// runtime-api runCliAction used by the account-auth subcommands).
const (
	accountExitMissing  = 4 // RuntimeApiError 404
	accountExitConflict = 5 // RuntimeApiError 409
	mainAccountID       = "__main__"
	mainAlias           = "main"
)

// accountUsage is ACCOUNT_USAGE in src/cli/account.ts (the top-level usage the
// bare command and its list/current/use handlers print on stderr).
const accountUsage = `Usage:
  ocx account list [provider] [--json] [--all] [--quota [--refresh]]
  ocx account current <provider> [--json]
  ocx account use <provider> <account-or-key-id|main> [--json]
  ocx account refresh <provider> [--json]
  ocx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]
  ocx account alias <provider> <account-or-key-id> <display-name|-> [--json]
  ocx account priority <provider> <account-id|main> [<-100..100|first|earlier|normal|later|last|reset>] [--json]
  ocx account pause <provider> <account-id|main> [--json]
  ocx account resume <provider> <account-id|main> [--json]
  ocx account pause-exhausted <provider> [--json]
  ocx account strategy <provider> [<quota|round-robin|fill-first>] [--json]
  ocx account sticky <provider> [<1-100>] [--json]
  ocx account remove <provider> <account-or-key-id|main> --yes [--json]
  ocx account clear-cooldown <provider> <account-id|main> [--json]
  ocx account add-key <provider> [--label <label>] [--json]
  ocx account import <provider> --format <format> (--file <path>|--stdin) [--json]
  ocx account login <provider> [--id <account-id>] [--reauth] [--code -] [--no-wait] [--json]
  ocx account code <provider> [--flow <flow-id>] [--json]   (reads the code from stdin)
  ocx account cancel <provider> [--flow <flow-id>] [--json]
  ocx account reset-credits <account-id|main> [--consume --yes] [--json]
  ocx account main <doctor|list|register|add|switch|recover> ...

List and switch provider accounts and API-key pools (masked output only).
'main' selects the Codex App login for the openai account pool.`

// accountExtendedUsage is EXTENDED_USAGE in src/cli/account-extended.ts.
const accountExtendedUsage = `Usage:
  ocx account refresh <provider> [--json]
  ocx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]
  ocx account alias <provider> <id|main> <display-name|-> [--json]
  ocx account priority <provider> <id|main> [<-100..100|first|earlier|normal|later|last|reset>] [--json]
  ocx account pause <provider> <id|main> [--json]
  ocx account resume <provider> <id|main> [--json]
  ocx account pause-exhausted <provider> [--json]
  ocx account strategy <provider> [<quota|round-robin|fill-first>] [--json]
  ocx account sticky <provider> [<1-100>] [--json]
  ocx account remove <provider> <id|main> --yes [--json]
  ocx account clear-cooldown <provider> <id|main> [--json]
  ocx account add-key <provider> [--label <label>] [--json]
  ocx account import <provider> --format <format> (--file <path>|--stdin) [--json]`

// accountAuthUsage is USAGE in src/cli/account-auth.ts.
const accountAuthUsage = `Usage:
  ocx account login <provider> [--id <account-id>] [--reauth] [--device] [--code -] [--no-wait] [--json]
  ocx account code <provider> [--flow <flow-id>] [--json]   (reads the code from stdin)
  ocx account cancel <provider> [--flow <flow-id>] [--json]
  ocx account reset-credits <account-id|main> [--consume --yes] [--json]

--device runs the OpenAI device-code login instead of the browser callback: use
it when the proxy has no browser or nothing can reach localhost:1455, such as a
headless or remote hub. Enter the printed code at the printed URL from any other
machine.

The redirect URL or authorization code is a short-lived credential. Pipe it in
rather than passing it as an argument, where it lands in shell history and is
visible to anyone who can run ps:
  pbpaste | ocx account code <provider> --flow <flow-id>
  ocx account login <provider> --code -   (same, for the login flow)`

// accountMainUsage is USAGE in src/cli/account-main.ts.
const accountMainUsage = `Usage:
  ocx account main doctor [--json]
  ocx account main list [--json]
  ocx account main register <label> [--json]
  ocx account main add <label>
  ocx account main switch <profile-id-or-label> --yes [--json]
  ocx account main recover [--rollback --yes] [--json]

Native main login profiles change the physical Codex App/CLI login in the effective CODEX_HOME.
They are independent from the OpenCodex Pool selected by 'ocx account use openai'.`

// Public OAuth provider ids, in registry declaration order minus chatgpt
// (isPublicOAuthProvider in src/oauth/index.ts). They classify as type "oauth"
// even without a config row.
var publicOAuthProviders = []string{
	"command-code", "xai", "anthropic", "kimi", "meta-muse", "nous", "kiro",
	"google-antigravity", "cursor", "github-copilot",
}

func isPublicOAuthProvider(name string) bool {
	for _, id := range publicOAuthProviders {
		if id == name {
			return true
		}
	}
	return false
}

// localProviderIDs are registry entries whose authKind is "local"
// (src/providers/registry.ts); account classification refuses them outright.
var localProviderIDs = []string{"ollama", "vllm", "lm-studio"}

func isLocalProvider(name string) bool {
	for _, id := range localProviderIDs {
		if id == name {
			return true
		}
	}
	return false
}

// AccountType mirrors account-api.ts.
type AccountType string

const (
	accountTypeCodex  AccountType = "codex"
	accountTypeOAuth  AccountType = "oauth"
	accountTypeAPIKey AccountType = "api-key"
)

// configProviderMode reports the provider's authMode and whether a provider
// config row exists, reading the raw config map the way loadConfig feeds
// classifyAccount. name is already lowercased by callers.
func configProviderMode(raw map[string]any, name string) (provider map[string]any, ok bool) {
	providersSection, _ := raw["providers"].(map[string]any)
	row, exists := providersSection[name]
	if !exists {
		return nil, false
	}
	obj, _ := row.(map[string]any)
	return obj, obj != nil
}

// codexAccountModeFor mirrors providerCodexAccountMode in
// src/providers/registry.ts for the only provider the account surface treats
// as a Codex pool: openai, whose registry entry declares codexAccountMode
// "pool" and whose persisted config may override it to pool or direct.
func codexAccountModeFor(name string, provider map[string]any) string {
	if name != "openai" {
		return ""
	}
	if provider != nil {
		if mode, _ := provider["codexAccountMode"].(string); mode == "pool" || mode == "direct" {
			return mode
		}
	}
	return "pool"
}

// classifyAccount mirrors classifyAccount in src/cli/account-api.ts. The
// second return is the type; the first carries the error message when the
// provider has no credential surface.
func classifyAccount(raw map[string]any, name string) (string, AccountType, bool) {
	provider, hasProvider := configProviderMode(raw, name)
	if codexAccountModeFor(name, provider) != "" {
		return "", accountTypeCodex, true
	}
	if isLocalProvider(name) {
		return fmt.Sprintf("provider %q is a local provider and has no credentials", name), "", false
	}
	if hasProvider {
		authMode, _ := provider["authMode"].(string)
		if authMode == "forward" {
			return fmt.Sprintf("provider %q uses forward auth and has no switchable credentials", name), "", false
		}
		if authMode == "key" {
			return "", accountTypeAPIKey, true
		}
		if authMode == "" {
			_, hasKey := provider["apiKey"].(string)
			pool := accountStringField(provider, "apiKeyPool")
			if hasKey || pool != "" {
				return "", accountTypeAPIKey, true
			}
		}
	}
	if isPublicOAuthProvider(name) {
		return "", accountTypeOAuth, true
	}
	if hasProvider {
		return "", accountTypeAPIKey, true
	}
	return fmt.Sprintf("unknown provider %q", name), "", false
}

// accountStringField reads a non-empty trimmed string field off a decoded
// JSON map, like the TypeScript helper of the same name.
func accountStringField(json map[string]any, key string) string {
	value, _ := json[key].(string)
	trimmed := strings.TrimSpace(value)
	return trimmed
}

// accountNumber reads a JSON number member as float64 when present and finite.
func accountNumber(json *jsonwire.Value, key string) (float64, bool) {
	if json == nil || json.Kind() != jsonwire.Object {
		return 0, false
	}
	field := json.Find(key)
	if field == nil || field.Kind() != jsonwire.Number {
		return 0, false
	}
	number, err := numberAsFloat(field)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, false
	}
	return number, true
}

// candidateNames mirrors candidateNames in src/cli/account.ts: openai plus
// every configured provider name, in set order.
func candidateNames(raw map[string]any) string {
	seen := []string{"openai"}
	providersSection, _ := raw["providers"].(map[string]any)
	for name := range providersSection {
		present := false
		for _, existing := range seen {
			if existing == name {
				present = true
				break
			}
		}
		if !present {
			seen = append(seen, name)
		}
	}
	return strings.Join(seen, ", ")
}

// accountDeps bundles the injected seams a Go account test uses: an explicit
// base URL (skip live discovery) or a ReadRuntime for the fixture home.
type accountDeps struct {
	deps       Deps
	configRaw  func() map[string]any
	httpClient *http.Client
	stdin      io.Reader
	stdinIsTTY bool
}

func loadAccountConfigRaw() map[string]any {
	loaded, err := config.Load()
	if err != nil {
		return map[string]any{}
	}
	return loaded.Raw
}

// accountAPIResult mirrors ApiResult: status 0 is the transport sentinel.
type accountAPIResult struct {
	status         int
	body           *jsonwire.Value
	transportError string
}

// accountHTTP performs the management request exactly like apiJson in
// src/cli/account-api.ts: method/body carry the running-proxy headers, a
// non-JSON body becomes an empty object, and a network failure returns status 0
// with the cause string.
func accountHTTP(client *http.Client, baseURL, method, path string, body *jsonwire.Value) accountAPIResult {
	var requestBody strings.Reader
	if body != nil {
		encoded, err := body.Encode()
		if err != nil {
			return accountAPIResult{status: 0, body: jsonwire.ObjectValue(), transportError: err.Error()}
		}
		requestBody = *strings.NewReader(string(encoded))
	}
	request, err := http.NewRequest(method, baseURL+path, &requestBody)
	if err != nil {
		return accountAPIResult{status: 0, body: jsonwire.ObjectValue(), transportError: err.Error()}
	}
	request.Header.Set("Content-Type", "application/json")
	if token := configuredUsageAdminToken(); token != "" {
		request.Header.Set("X-OpenCodex-API-Key", token)
	}
	response, doErr := client.Do(request)
	if doErr != nil {
		return accountAPIResult{status: 0, body: jsonwire.ObjectValue(), transportError: doErr.Error()}
	}
	defer response.Body.Close()
	raw := make([]byte, 0, 4096)
	buffer := make([]byte, 32*1024)
	for {
		n, readErr := response.Body.Read(buffer)
		raw = append(raw, buffer[:n]...)
		if readErr != nil {
			break
		}
	}
	value, parseErr := jsonwire.Parse(raw)
	if parseErr != nil {
		value = jsonwire.ObjectValue()
	}
	return accountAPIResult{status: response.StatusCode, body: value}
}

// resolveAccountBaseURL mirrors resolveBaseUrl: the identity-checked live
// proxy discovered from the runtime record / config port, or "" when none.
func resolveAccountBaseURL(deps accountDeps) string {
	if state, found := liveProxyEndpoint(deps.deps); found {
		return baseURL(state)
	}
	return ""
}

// reportProxyUnreachable mirrors proxyUnreachable in account-api.ts.
func reportProxyUnreachable(deps Deps, transportError string) int {
	deps = defaults(deps)
	fmt.Fprintln(deps.Stderr, "Proxy not reachable. Start it with 'ocx start' or 'ocx ensure'.")
	if transportError != "" {
		fmt.Fprintln(deps.Stderr, "reason: "+transportError)
	}
	return 1
}

// accountAPIError returns the apiError exit code after printing the exact
// apiError lines (account-api.ts): the primary error or fallback, optional
// reason/hint lines, and the native-login cleanup warning.
func accountAPIError(deps Deps, json *jsonwire.Value, fallback string, status int) int {
	deps = defaults(deps)
	primary := ""
	if json != nil && json.Kind() == jsonwire.Object {
		if field := json.Find("error"); field != nil && field.Kind() == jsonwire.String {
			primary = strings.TrimSpace(field.String())
		}
	}
	if primary == "" {
		primary = fallback
	}
	fmt.Fprintln(deps.Stderr, "Error: "+primary)
	if json != nil && json.Kind() == jsonwire.Object {
		if field := json.Find("reason"); field != nil && field.Kind() == jsonwire.String {
			reason := strings.TrimSpace(field.String())
			if reason != "" && reason != primary {
				fmt.Fprintln(deps.Stderr, "reason: "+reason)
			}
		}
		if field := json.Find("hint"); field != nil && field.Kind() == jsonwire.String {
			hint := strings.TrimSpace(field.String())
			if hint != "" && hint != primary {
				fmt.Fprintln(deps.Stderr, "hint: "+hint)
			}
		}
		if field := json.Find("cleanupRequired"); field != nil && field.Kind() == jsonwire.Bool && field.Bool() {
			fmt.Fprintln(deps.Stderr, "Warning: native-login staging cleanup is still required; run 'ocx account main doctor'.")
		}
	}
	switch status {
	case 404:
		return accountExitMissing
	case 409:
		return accountExitConflict
	default:
		return 1
	}
}

// consumeAccountFlag removes flag from args anywhere and reports presence
// (flag()/consumeFlag() in the TS handlers).
func consumeAccountFlag(args *[]string, flag string) bool {
	for index, arg := range *args {
		if arg == flag {
			*args = append((*args)[:index], (*args)[index+1:]...)
			return true
		}
	}
	return false
}

// consumeAccountFlagValue mirrors flagValue: `--flag value`, removing both when
// a following value exists.
func consumeAccountFlagValue(args *[]string, flag string) (found bool, value string) {
	for index, arg := range *args {
		if arg != flag {
			continue
		}
		if index+1 >= len(*args) {
			*args = append((*args)[:index], (*args)[index+1:]...)
			return true, ""
		}
		value = (*args)[index+1]
		*args = append((*args)[:index], (*args)[index+2:]...)
		return true, value
	}
	return false, ""
}

// accountLeftoverError mirrors leftoverArgsError.
func accountLeftoverError(args []string) string {
	if len(args) == 0 {
		return ""
	}
	var unknown []string
	for _, arg := range args {
		if strings.HasPrefix(arg, "-") {
			unknown = append(unknown, arg)
		}
	}
	if len(unknown) > 0 {
		return "Unknown flag(s): " + strings.Join(unknown, ", ")
	}
	return "Unexpected argument(s): " + strings.Join(args, ", ")
}

// accountRow mirrors the flattened AccountRow DTO. TS optional fields carry a
// presence flag here so that an explicitly-empty string (written to JSON as "")
// is distinguishable from an absent one (omitted from JSON, "-" in tables).
type accountRow struct {
	provider         string
	rowType          AccountType
	id               string
	hasLabel         bool
	label            string
	hasEmail         bool
	email            string
	hasPlan          bool
	plan             string
	hasMasked        bool
	masked           string
	active           bool
	needsReauth      bool
	needsReauthSet   bool
	hasPriority      bool
	priority         float64
	hasQuota         bool
	quota            *jsonwire.Value
	quotaUnavailable bool
	paused           bool
}

// displayID maps the main account sentinel back to the display alias.
func displayID(id string) string {
	if id == mainAccountID {
		return mainAlias
	}
	return id
}

// accountStatusText mirrors statusText in account.ts: paused leads and does not
// replace selected; a paused-but-selected account is named by both.
func accountStatusText(row *accountRow) string {
	var parts []string
	if row.paused {
		parts = append(parts, "paused")
	}
	if row.active {
		if row.rowType == accountTypeCodex {
			parts = append(parts, "selected")
		} else {
			parts = append(parts, "active")
		}
	}
	if row.needsReauthSet && row.needsReauth {
		parts = append(parts, "needs-reauth")
	}
	return strings.Join(parts, " ")
}

// accountPriorityText mirrors priorityText: signed when above zero, "-" when
// ordering does not apply.
func accountPriorityText(row *accountRow) string {
	if !row.hasPriority {
		return "-"
	}
	value := int64(row.priority)
	if row.priority > 0 {
		return fmt.Sprintf("+%d", value)
	}
	return fmt.Sprintf("%d", value)
}

// formatAccountTable mirrors formatAccountTable in account.ts. TS renders with
// padEnd + join("  ") + trimEnd; the width of an absent cell is 0.
func formatAccountTable(rows []*accountRow, withQuota bool) string {
	header := []string{"PROVIDER", "TYPE", "ID", "PLAN/LABEL", "PRIORITY", "STATUS"}
	if withQuota {
		header = append(header, "QUOTA")
	}
	data := make([][]string, 0, len(rows))
	for _, row := range rows {
		// keyLabel reproduces the JS `masked && label !== masked ? `${masked}
		// (${label})` : masked` expression for present fields only.
		keyLabelPresent := false
		keyLabel := ""
		if row.hasMasked {
			keyLabelPresent = true
			if row.hasLabel && row.masked != row.label {
				keyLabel = row.masked + " (" + row.label + ")"
			} else {
				keyLabel = row.masked
			}
		}
		label := "-"
		if row.rowType == accountTypeAPIKey {
			if keyLabelPresent {
				label = keyLabel
			}
		} else if row.hasLabel {
			label = row.label
		}
		cols := []string{row.provider, string(row.rowType), displayID(row.id), label, accountPriorityText(row), accountStatusText(row)}
		if withQuota {
			cols = append(cols, accountQuotaText(row))
		}
		data = append(data, cols)
	}
	widths := make([]int, len(header))
	for i, heading := range header {
		widths[i] = runeLen(heading)
		for _, cols := range data {
			if runeLen(cols[i]) > widths[i] {
				widths[i] = runeLen(cols[i])
			}
		}
	}
	line := func(cols []string) string {
		parts := make([]string, len(cols))
		for i, col := range cols {
			parts[i] = col + strings.Repeat(" ", widths[i]-runeLen(col))
		}
		return strings.TrimRight(strings.Join(parts, "  "), " ")
	}
	lines := []string{line(header)}
	for _, cols := range data {
		lines = append(lines, line(cols))
	}
	return strings.Join(lines, "\n")
}

// runeLen counts Unicode code points the way JS padEnd counts UTF-16 code
// units for the BMP text account tables carry.
func runeLen(value string) int {
	return len([]rune(value))
}

// isoReset mirrors resetIso: epoch seconds (< 1e10) promoted to millis and
// rendered as the JS Date.toISOString() string.
func isoReset(value float64, ok bool) string {
	if !ok {
		return ""
	}
	ms := int64(value)
	if value < 10_000_000_000 {
		ms = ms * 1000
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

// printPrettyJSON logs JSON.stringify(value, null, 2) to the given writer.
func printPrettyJSON(deps Deps, value *jsonwire.Value) {
	deps = defaults(deps)
	pretty, err := value.EncodePretty()
	if err != nil {
		fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
		return
	}
	deps.Stdout.Write(pretty)
	fmt.Fprintln(deps.Stdout)
}
