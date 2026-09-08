// ocx account command switch and the API-mutation subcommands — Go-native port
// of src/cli/account.ts (cmdAccount switch) and the refresh/auto-switch/remove
// handlers in src/cli/account-extended.ts. All of these speak the management
// API through account_runtime; the differential oracle pins their bytes.
package ocxcli

import (
	"fmt"
	"math"
	"strconv"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// runAccount is cmdAccount in src/cli/account.ts.
func runAccount(args []string, deps Deps) int {
	acc := accountDeps{deps: deps}
	sub := ""
	if len(args) > 0 {
		sub = args[0]
	}
	rest := args[1:]
	switch sub {
	case "list":
		return runAccountList(rest, acc)
	case "current":
		return runAccountCurrent(rest, acc)
	case "use":
		return runAccountUse(rest, acc)
	case "refresh":
		return runAccountRefresh(rest, acc)
	case "auto-switch":
		return runAccountAutoSwitch(rest, acc)
	case "alias", "rename":
		return runAccountAlias(rest, acc)
	case "priority":
		return runAccountPriority(rest, acc)
	case "pause":
		return runAccountPause(rest, acc, true)
	case "resume":
		return runAccountPause(rest, acc, false)
	case "pause-exhausted":
		return runAccountPauseExhausted(rest, acc)
	case "strategy":
		return runAccountStrategy(rest, acc)
	case "sticky":
		return runAccountSticky(rest, acc)
	case "remove":
		return runAccountRemove(rest, acc)
	case "clear-cooldown":
		return runAccountClearCooldown(rest, acc)
	case "login", "reauth", "code", "cancel", "reset-credits":
		// OAuth device flows against the management API (account-auth.ts):
		// headless --code - / --no-wait paths are oracle-covered in
		// go-cli-parity; the poll-until-settled browser flows run the same Go
		// client with matching 2s cadence.
		if code, ok := runAccountAuthCommand(sub, rest, acc); ok {
			return code
		}
		return 1
	default:
		// account add-key/import/main stay TypeScript-owned: they need piped
		// stdin I/O shapes or the native CODEX_HOME staging home that have no
		// Go byte-oracle yet. cli.go gates them before dispatch.
		reportAccountUsage(acc, accountUsage)
		return 1
	}
}

// accountExtendedUsageError mirrors usage() in account-extended.ts.
func accountExtendedUsageError(acc accountDeps, message string) int {
	if message != "" {
		reportAccountStderrLine(acc, message)
	}
	reportAccountUsage(acc, accountExtendedUsage)
	return 1
}

func runAccountRefresh(rest []string, acc accountDeps) int {
	wantsJSON := consumeAccountFlag(&rest, "--json")
	name := accountShift(&rest)
	if name == "" || len(rest) > 0 {
		return accountExtendedUsageError(acc, "")
	}
	raw := loadAccountConfigRaw()
	errorText, rowType, ok := classifyAccount(raw, name)
	if !ok {
		return accountExtendedUsageError(acc, "Error: "+errorText)
	}
	baseURL := resolveAccountBaseURL(acc)
	if baseURL == "" {
		return reportProxyUnreachable(acc.deps, "")
	}
	if rowType != accountTypeCodex {
		status, report, errorBody, transportErr := fetchProviderQuotaReport(acc.httpClientOr(), baseURL, name)
		if status == 0 {
			return reportProxyUnreachable(acc.deps, transportErr)
		}
		if status != 200 {
			return accountAPIError(acc.deps, errorBody, fmt.Sprintf("failed to refresh %s", name), status)
		}
		if wantsJSON {
			value := jsonwire.ObjectValue()
			value.Set("provider", jsonwire.StringValue(name))
			if report != nil {
				value.Set("report", report)
			} else {
				value.Set("report", jsonwire.NullValue())
			}
			printPrettyJSON(acc.deps, value)
		} else if report != nil {
			fmt.Fprintln(acc.deps.Stdout, accountProviderQuotaLine(name, report))
		} else if accountHasPassiveQuota(name) {
			fmt.Fprintln(acc.deps.Stdout, name+" reports usage only during a streaming response; there is nothing to refresh. Run a request through this provider to update it, then see `ocx account list "+name+"`.")
		} else {
			fmt.Fprintln(acc.deps.Stdout, "no quota report available for "+name)
		}
		return 0
	}
	result := fetchCodexRows(acc.httpClientOr(), baseURL, true, true)
	if failed := accountFamilyFailure(acc.deps, result, fmt.Sprintf("failed to refresh %s", name)); failed != nil {
		return *failed
	}
	if wantsJSON {
		value := jsonwire.ObjectValue()
		accounts := jsonwire.EmptyArray()
		for _, row := range result.rows {
			accounts.AppendArray(accountRowObject(row, true))
		}
		value.Set("accounts", accounts)
		printPrettyJSON(acc.deps, value)
	} else {
		for _, row := range result.rows {
			fmt.Fprintln(acc.deps.Stdout, accountRefreshLine(row))
		}
	}
	return 0
}

func allDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func accountIsInteger(value float64) bool {
	return value == math.Trunc(value)
}

func hasNumberField(object *jsonwire.Value, key string) bool {
	_, ok := accountNumber(object, key)
	return ok
}

func runAccountAutoSwitch(rest []string, acc accountDeps) int {
	wantsJSON := consumeAccountFlag(&rest, "--json")
	name := accountShift(&rest)
	action := accountShift(&rest)
	if name == "" || action == "" {
		return accountExtendedUsageError(acc, "")
	}
	raw := loadAccountConfigRaw()
	_, rowType, ok := classifyAccount(raw, name)
	genericPool := rowType == accountTypeOAuth
	if !ok || rowType == accountTypeAPIKey || name == "anthropic" {
		return accountExtendedUsageError(acc, "Error: auto-switch only applies to the openai Codex account pool or a generic OAuth provider pool")
	}
	var threshold *float64
	switch {
	case action == "on" && len(rest) == 0:
		value := 80.0
		threshold = &value
	case action == "off" && len(rest) == 0:
		value := 0.0
		threshold = &value
	case action == "threshold" && len(rest) == 1 && allDigits(rest[0]):
		if number, err := strconv.ParseFloat(rest[0], 64); err == nil {
			threshold = &number
		}
	case action != "status" || len(rest) != 0:
		return accountExtendedUsageError(acc, "")
	}
	if threshold != nil && (!accountIsInteger(*threshold) || *threshold < 0 || *threshold > 100) {
		return accountExtendedUsageError(acc, "Error: threshold must be an integer 0-100")
	}
	baseURL := resolveAccountBaseURL(acc)
	if baseURL == "" {
		return reportProxyUnreachable(acc.deps, "")
	}
	if action == "status" {
		var response accountAPIResult
		if genericPool {
			response = accountHTTP(acc.httpClientOr(), baseURL, "GET", "/api/oauth/accounts/pool?provider="+urlQueryEscape(name), nil)
		} else {
			response = accountHTTP(acc.httpClientOr(), baseURL, "GET", "/api/codex-auth/active", nil)
		}
		if response.status == 0 {
			return reportProxyUnreachable(acc.deps, response.transportError)
		}
		if response.status != 200 || (!genericPool && !hasNumberField(response.body, "autoSwitchThreshold")) {
			return accountAPIError(acc.deps, response.body, "failed to read auto-switch status", response.status)
		}
		value, _ := accountNumber(response.body, "autoSwitchThreshold")
		threshold = &value
	} else {
		var body *jsonwire.Value
		var path string
		if genericPool {
			body = jsonwire.ObjectValue()
			body.Set("provider", jsonwire.StringValue(name))
			body.Set("autoSwitchThreshold", jsonwire.NumberFrom(*threshold))
			path = "/api/oauth/accounts/pool"
		} else {
			body = jsonwire.ObjectValue()
			body.Set("threshold", jsonwire.NumberFrom(*threshold))
			path = "/api/codex-auth/auto-switch"
		}
		response := accountHTTP(acc.httpClientOr(), baseURL, "PUT", path, body)
		if response.status == 0 {
			return reportProxyUnreachable(acc.deps, response.transportError)
		}
		if response.status != 200 {
			return accountAPIError(acc.deps, response.body, "failed to update auto-switch", response.status)
		}
	}
	enabled := *threshold > 0
	if wantsJSON {
		value := jsonwire.ObjectValue()
		value.Set("provider", jsonwire.StringValue(name))
		value.Set("autoSwitchThreshold", jsonwire.NumberFrom(*threshold))
		value.Set("enabled", jsonwire.BoolValue(enabled))
		printPrettyJSON(acc.deps, value)
	} else if enabled {
		fmt.Fprintln(acc.deps.Stdout, fmt.Sprintf("auto-switch: on (threshold %s%%)", jsonwire.FormatV8Number(*threshold)))
	} else {
		fmt.Fprintln(acc.deps.Stdout, "auto-switch: off")
	}
	return 0
}

// accountDeletePath mirrors deletePath() in account-extended.ts.
func accountDeletePath(rowType AccountType, name, id string) string {
	switch rowType {
	case accountTypeCodex:
		return "/api/codex-auth/accounts?id=" + urlQueryEscape(id)
	case accountTypeOAuth:
		return "/api/oauth/accounts?provider=" + urlQueryEscape(name) + "&id=" + urlQueryEscape(id)
	default:
		return "/api/providers/keys?name=" + urlQueryEscape(name) + "&id=" + urlQueryEscape(id)
	}
}

func errorTextOf(json *jsonwire.Value, fallback string) string {
	text := objectString(json, "error")
	if text == "" {
		return fallback
	}
	return text
}

func runAccountRemove(rest []string, acc accountDeps) int {
	wantsJSON := consumeAccountFlag(&rest, "--json")
	confirmed := consumeAccountFlag(&rest, "--yes")
	fail := func(message string) int {
		if wantsJSON {
			value := jsonwire.ObjectValue()
			value.Set("error", jsonwire.StringValue(message))
			printPrettyJSON(acc.deps, value)
		} else {
			fmt.Fprintln(acc.deps.Stderr, "Error: "+message)
		}
		return 1
	}
	name := accountShift(&rest)
	requestedID := accountShift(&rest)
	if name == "" || requestedID == "" || len(rest) > 0 {
		if wantsJSON {
			return fail("provider and account id are required")
		}
		return accountExtendedUsageError(acc, "")
	}
	if !confirmed {
		message := fmt.Sprintf("Confirmation required. Re-run: ocx account remove %s %s --yes", name, requestedID)
		if wantsJSON {
			return fail(message)
		}
		return accountExtendedUsageError(acc, message)
	}
	raw := loadAccountConfigRaw()
	errorText, rowType, ok := classifyAccount(raw, name)
	if !ok {
		if wantsJSON {
			return fail(errorText)
		}
		return accountExtendedUsageError(acc, "Error: "+errorText)
	}
	id := requestedID
	if rowType == accountTypeCodex && requestedID == mainAlias {
		id = mainAccountID
	}
	if rowType == accountTypeCodex && id == mainAccountID {
		if wantsJSON {
			return fail("the main Codex App login cannot be removed")
		}
		return accountExtendedUsageError(acc, "Error: the main Codex App login cannot be removed")
	}
	baseURL := resolveAccountBaseURL(acc)
	if baseURL == "" {
		return fail("Proxy not reachable. Start it with 'ocx start' or 'ocx ensure'.")
	}
	before := fetchAccountRows(acc.httpClientOr(), baseURL, name, rowType, false, false)
	if before.networkDown {
		return fail("Proxy not reachable. Start it with 'ocx start' or 'ocx ensure'.")
	}
	if before.errorBody != nil {
		return fail(errorTextOf(before.errorBody, fmt.Sprintf("failed to verify %s before removal", name)))
	}
	found := false
	for _, row := range before.rows {
		if row.id == id {
			found = true
			break
		}
	}
	if !found {
		if wantsJSON {
			return fail(fmt.Sprintf("account or key %q was not found", requestedID))
		}
		return accountExtendedUsageError(acc, fmt.Sprintf("Error: account or key %q was not found", requestedID))
	}
	response := accountHTTP(acc.httpClientOr(), baseURL, "DELETE", accountDeletePath(rowType, name, id), nil)
	if response.status == 0 {
		return fail("Proxy not reachable. Start it with 'ocx start' or 'ocx ensure'.")
	}
	if response.status != 200 {
		return fail(errorTextOf(response.body, fmt.Sprintf("failed to remove %s", requestedID)))
	}
	catalogRefreshPending := rowType == accountTypeCodex && codexCatalogRefreshPending(response.body)
	after := fetchAccountRows(acc.httpClientOr(), baseURL, name, rowType, false, false)
	if after.networkDown || after.errorBody != nil {
		detail := "unknown error"
		if after.networkDown {
			detail = "proxy not reachable"
		} else if after.errorBody != nil {
			detail = objectString(after.errorBody, "error")
			if detail == "" {
				detail = "unknown error"
			}
		}
		return fail(fmt.Sprintf("post-delete verification failed; delete may have succeeded: %s", detail))
	}
	removedActive := before.hasActiveID && before.activeID == id
	value := jsonwire.ObjectValue()
	value.Set("ok", jsonwire.BoolValue(true))
	value.Set("provider", jsonwire.StringValue(name))
	value.Set("id", jsonwire.StringValue(id))
	value.Set("removedActive", jsonwire.BoolValue(removedActive))
	if after.hasActiveID {
		value.Set("promotedActiveId", jsonwire.StringValue(after.activeID))
	} else {
		value.Set("promotedActiveId", jsonwire.NullValue())
	}
	if rowType == accountTypeCodex {
		value.Set("catalogRefreshPending", jsonwire.BoolValue(catalogRefreshPending))
	}
	if wantsJSON {
		printPrettyJSON(acc.deps, value)
	} else if rowType == accountTypeCodex && removedActive && !after.hasActiveID {
		fmt.Fprintln(acc.deps.Stdout, "openai: auto (no pin — lowest-usage account is selected per request)")
	} else if rowType == accountTypeOAuth {
		if len(after.rows) > 0 {
			fmt.Fprintln(acc.deps.Stdout, name+": active account is now "+after.activeID)
		} else {
			fmt.Fprintln(acc.deps.Stdout, name+": no accounts remaining")
		}
	} else if rowType == accountTypeAPIKey {
		if len(after.rows) > 0 {
			fmt.Fprintln(acc.deps.Stdout, name+": active key is now "+after.activeID)
		} else {
			fmt.Fprintln(acc.deps.Stdout, name+": no keys remaining")
		}
	} else {
		fmt.Fprintln(acc.deps.Stdout, fmt.Sprintf("%s: removed account %s", name, requestedID))
	}
	if !wantsJSON && catalogRefreshPending {
		warnIfCodexCatalogRefreshPending(acc, response.body)
	}
	return 0
}
