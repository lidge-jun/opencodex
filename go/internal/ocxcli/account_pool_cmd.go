// ocx account selection-order subcommands (priority, pause/resume,
// pause-exhausted, strategy, sticky and alias) — byte-faithful Go-native port
// of the matching handlers in src/cli/account-extended.ts.
package ocxcli

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// accountPriorityPresets mirrors PRIORITY_PRESETS.
var accountPriorityPresets = map[string]float64{
	"first": 2, "earlier": 1, "normal": 0, "later": -1, "last": -2,
}

// accountPriorityNames is the canonical key order for preset messages.
var accountPriorityNames = []string{"first", "earlier", "normal", "later", "last"}

func accountPriorityPresetName(priority float64) string {
	for name, value := range accountPriorityPresets {
		if value == priority {
			return name
		}
	}
	return ""
}

func accountFormatPriority(priority float64) string {
	preset := accountPriorityPresetName(priority)
	signed := strconv.FormatFloat(priority, 'f', -1, 64)
	if priority > 0 {
		signed = "+" + signed
	}
	if preset != "" {
		return signed + " (" + preset + ")"
	}
	return signed
}

// accountParsePriorityArgument mirrors parsePriorityArgument: null = reset,
// nil-ok = unparseable.
func accountParsePriorityArgument(raw string) (*float64, bool) {
	word := strings.ToLower(strings.TrimSpace(raw))
	if word == "reset" {
		return nil, true
	}
	if _, ok := accountPriorityPresets[word]; ok {
		value := accountPriorityPresets[word]
		return &value, true
	}
	if !signedIntegerString(word) {
		return nil, false
	}
	number, err := strconv.ParseFloat(word, 64)
	if err != nil {
		return nil, false
	}
	// parseAccountPriority returns null outside [-100,100]; that null maps to
	// "unparseable" in parsePriorityArgument.
	if number < -100 || number > 100 {
		return nil, false
	}
	return &number, true
}

func accountPriorityJSON(provider, id string, priority float64) *jsonwire.Value {
	value := jsonwire.ObjectValue()
	value.Set("ok", jsonwire.BoolValue(true))
	value.Set("provider", jsonwire.StringValue(provider))
	value.Set("id", jsonwire.StringValue(id))
	value.Set("priority", jsonwire.NumberFrom(priority))
	preset := accountPriorityPresetName(priority)
	if preset != "" {
		value.Set("preset", jsonwire.StringValue(preset))
	} else {
		value.Set("preset", jsonwire.NullValue())
	}
	return value
}

// runAccountPriority mirrors cmdPriority.
func runAccountPriority(rest []string, acc accountDeps) int {
	wantsJSON := consumeAccountFlag(&rest, "--json")
	name := accountShift(&rest)
	requestedID := accountShift(&rest)
	requestedPriority := accountShift(&rest)
	if name == "" || requestedID == "" || len(rest) > 0 {
		return accountExtendedUsageError(acc, "")
	}
	raw := loadAccountConfigRaw()
	errorText, rowType, ok := classifyAccount(raw, name)
	if !ok {
		return accountExtendedUsageError(acc, "Error: "+errorText)
	}
	if rowType != accountTypeCodex {
		return accountExtendedUsageError(acc, "Error: selection order only applies to the openai Codex account pool")
	}
	id := requestedID
	if requestedID == mainAlias {
		id = mainAccountID
	}
	// Validate before touching the network so a typo never reaches the proxy.
	var priority *float64
	parseable := true
	if requestedPriority != "" {
		priority, parseable = accountParsePriorityArgument(requestedPriority)
		if !parseable {
			return accountExtendedUsageError(acc, "Error: selection order must be an integer -100..100, one of first/earlier/normal/later/last, or reset")
		}
	}
	baseURL := resolveAccountBaseURL(acc)
	if baseURL == "" {
		return reportProxyUnreachable(acc.deps, "")
	}
	// No value means "show" — a read must not rewrite what it is reporting.
	if requestedPriority == "" {
		result := fetchCodexRows(acc.httpClientOr(), baseURL, false, false)
		if failed := accountFamilyFailure(acc.deps, result, fmt.Sprintf("failed to read %s accounts", name)); failed != nil {
			return *failed
		}
		var row *accountRow
		for _, candidate := range result.rows {
			if candidate.id == id {
				row = candidate
				break
			}
		}
		if row == nil {
			return accountExtendedUsageError(acc, "Error: no "+name+" account "+requestedID)
		}
		current := 0.0
		if row.hasPriority {
			current = row.priority
		}
		if wantsJSON {
			printPrettyJSON(acc.deps, accountPriorityJSON(name, id, current))
		} else {
			fmt.Fprintln(acc.deps.Stdout, fmt.Sprintf("%s: %s selection order is %s", name, requestedID, accountFormatPriority(current)))
		}
		return 0
	}
	// "reset" parses to nil and is sent as JSON null (the API's default).
	body := jsonwire.ObjectValue()
	body.Set("id", jsonwire.StringValue(id))
	if priority != nil {
		body.Set("priority", jsonwire.NumberFrom(*priority))
	} else {
		body.Set("priority", jsonwire.NullValue())
	}
	applied := 0.0
	if priority != nil {
		applied = *priority
	}
	response := accountHTTP(acc.httpClientOr(), baseURL, "PUT", "/api/codex-auth/accounts/priority", body)
	if response.status == 0 {
		return reportProxyUnreachable(acc.deps, response.transportError)
	}
	if response.status != 200 {
		return accountAPIError(acc.deps, response.body, fmt.Sprintf("failed to set selection order for %s", requestedID), response.status)
	}
	appliedPriority := applied
	if number, ok := accountNumber(response.body, "priority"); ok {
		appliedPriority = number
	}
	if wantsJSON {
		printPrettyJSON(acc.deps, accountPriorityJSON(name, id, appliedPriority))
	} else {
		fmt.Fprintln(acc.deps.Stdout, fmt.Sprintf("%s: %s selection order is now %s", name, requestedID, accountFormatPriority(appliedPriority)))
	}
	reportAccountStderrLine(acc, "Takes effect from the next unbound request; running threads keep their current account until drained.")
	reportAccountStderrLine(acc, `Also releases any manual "use this account now" pin, on any account.`)
	return 0
}

// runAccountPause mirrors cmdPause.
func runAccountPause(rest []string, acc accountDeps, paused bool) int {
	wantsJSON := consumeAccountFlag(&rest, "--json")
	verb := "pause"
	if !paused {
		verb = "resume"
	}
	name := accountShift(&rest)
	requestedID := accountShift(&rest)
	if name == "" || requestedID == "" || len(rest) > 0 {
		return accountExtendedUsageError(acc, "")
	}
	raw := loadAccountConfigRaw()
	errorText, rowType, ok := classifyAccount(raw, name)
	if !ok {
		return accountExtendedUsageError(acc, "Error: "+errorText)
	}
	if rowType != accountTypeCodex {
		return accountExtendedUsageError(acc, "Error: "+verb+" applies to the openai Codex account pool")
	}
	id := requestedID
	if requestedID == mainAlias {
		id = mainAccountID
	}
	baseURL := resolveAccountBaseURL(acc)
	if baseURL == "" {
		return reportProxyUnreachable(acc.deps, "")
	}
	body := jsonwire.ObjectValue()
	body.Set("id", jsonwire.StringValue(id))
	body.Set("paused", jsonwire.BoolValue(paused))
	response := accountHTTP(acc.httpClientOr(), baseURL, "PUT", "/api/codex-auth/accounts/pause", body)
	if response.status == 0 {
		return reportProxyUnreachable(acc.deps, response.transportError)
	}
	if response.status != 200 {
		return accountAPIError(acc.deps, response.body, fmt.Sprintf("failed to %s %s", verb, requestedID), response.status)
	}
	if wantsJSON {
		value := jsonwire.ObjectValue()
		value.Set("ok", jsonwire.BoolValue(true))
		value.Set("provider", jsonwire.StringValue(name))
		value.Set("id", jsonwire.StringValue(id))
		value.Set("paused", jsonwire.BoolValue(paused))
		printPrettyJSON(acc.deps, value)
	} else {
		fmt.Fprintln(acc.deps.Stdout, fmt.Sprintf("%s: %s %s", name, requestedID, verb+"d"))
	}
	if paused {
		reportAccountStderrLine(acc, "Threads bound to this account are unbound, and a fallback account is selected if this one was active.")
	}
	return 0
}

// runAccountPauseExhausted mirrors cmdPauseExhausted.
func runAccountPauseExhausted(rest []string, acc accountDeps) int {
	wantsJSON := consumeAccountFlag(&rest, "--json")
	name := accountShift(&rest)
	if name == "" || len(rest) > 0 {
		return accountExtendedUsageError(acc, "")
	}
	raw := loadAccountConfigRaw()
	errorText, rowType, classified := classifyAccount(raw, name)
	if !classified {
		return accountExtendedUsageError(acc, "Error: "+errorText)
	}
	if rowType != accountTypeCodex {
		return accountExtendedUsageError(acc, "Error: pause-exhausted applies to the openai Codex account pool")
	}
	baseURL := resolveAccountBaseURL(acc)
	if baseURL == "" {
		return reportProxyUnreachable(acc.deps, "")
	}
	body := jsonwire.ObjectValue()
	response := accountHTTP(acc.httpClientOr(), baseURL, "PUT", "/api/codex-auth/accounts/pause-exhausted", body)
	if response.status == 0 {
		return reportProxyUnreachable(acc.deps, response.transportError)
	}
	if response.status != 200 {
		return accountAPIError(acc.deps, response.body, "failed to pause exhausted accounts", response.status)
	}
	var pausedIDs []string
	if field := response.body.Find("pausedAccountIds"); field != nil && field.Kind() == jsonwire.Array {
		for _, value := range field.Elements() {
			if value.Kind() == jsonwire.String {
				pausedIDs = append(pausedIDs, value.String())
			}
		}
	}
	checked, hasChecked := accountNumber(response.body, "checkedAccountCount")
	failed, hasFailed := accountNumber(response.body, "failedAccountCount")
	complete := !hasFailed || failed == 0
	ok := complete
	if hasFailed && failed > 0 {
		reportAccountStderrLine(acc, fmt.Sprintf("Quota refresh failed for %s account(s); those were not evaluated.", jsonwire.FormatV8Number(failed)))
	}
	if wantsJSON {
		value := jsonwire.ObjectValue()
		value.Set("ok", jsonwire.BoolValue(ok))
		value.Set("complete", jsonwire.BoolValue(complete))
		value.Set("provider", jsonwire.StringValue(name))
		ids := jsonwire.EmptyArray()
		for _, id := range pausedIDs {
			ids.AppendArray(jsonwire.StringValue(id))
		}
		value.Set("pausedAccountIds", ids)
		if hasChecked {
			value.Set("checkedAccountCount", jsonwire.NumberFrom(checked))
		} else {
			value.Set("checkedAccountCount", jsonwire.NullValue())
		}
		if hasFailed {
			value.Set("failedAccountCount", jsonwire.NumberFrom(failed))
		} else {
			value.Set("failedAccountCount", jsonwire.NullValue())
		}
		printPrettyJSON(acc.deps, value)
		if !ok {
			return 1
		}
		return 0
	}
	if len(pausedIDs) > 0 {
		fmt.Fprintln(acc.deps.Stdout, fmt.Sprintf("%s: paused %d exhausted account(s): %s", name, len(pausedIDs), strings.Join(pausedIDs, ", ")))
	} else {
		fmt.Fprintln(acc.deps.Stdout, fmt.Sprintf("%s: no exhausted accounts to pause", name))
	}
	if !ok {
		return 1
	}
	return 0
}

// runAccountStrategy mirrors cmdStrategy, runAccountSticky mirrors cmdSticky;
// both delegate to poolSetting.
func runAccountStrategy(rest []string, acc accountDeps) int {
	return accountPoolSetting(rest, acc, "strategy")
}

func runAccountSticky(rest []string, acc accountDeps) int {
	return accountPoolSetting(rest, acc, "stickyLimit")
}

func accountPoolSetting(rest []string, acc accountDeps, field string) int {
	wantsJSON := consumeAccountFlag(&rest, "--json")
	label := "pool strategy"
	if field == "stickyLimit" {
		label = "sticky limit"
	}
	name := accountShift(&rest)
	requested := accountShift(&rest)
	if name == "" || len(rest) > 0 {
		return accountExtendedUsageError(acc, "")
	}
	raw := loadAccountConfigRaw()
	errorText, rowType, ok := classifyAccount(raw, name)
	if !ok {
		return accountExtendedUsageError(acc, "Error: "+errorText)
	}
	// poolTransportFor: codex → codex transport; oauth → anthropic transport;
	// api-key → refusal string.
	if rowType == accountTypeAPIKey {
		return accountExtendedUsageError(acc, fmt.Sprintf("Error: pool settings apply to OAuth account pools, not the API-key provider %q", name))
	}
	baseURL := resolveAccountBaseURL(acc)
	if baseURL == "" {
		return reportProxyUnreachable(acc.deps, "")
	}
	readPath := "/api/codex-auth/active"
	writePath := "/api/codex-auth/pool-strategy"
	strategyKey := "accountPoolStrategy"
	stickyKey := "accountPoolStickyLimit"
	writeBody := func(value *jsonwire.Value) *jsonwire.Value {
		body := jsonwire.ObjectValue()
		body.Set(field, value)
		return body
	}
	if rowType == accountTypeOAuth {
		readPath = "/api/oauth/accounts/pool?provider=" + urlQueryEscape(name)
		writePath = "/api/oauth/accounts/pool"
		strategyKey = "strategy"
		stickyKey = "stickyLimit"
		writeBody = func(value *jsonwire.Value) *jsonwire.Value {
			body := jsonwire.ObjectValue()
			body.Set("provider", jsonwire.StringValue(name))
			body.Set(field, value)
			return body
		}
	}
	// No value means show.
	if requested == "" {
		response := accountHTTP(acc.httpClientOr(), baseURL, "GET", readPath, nil)
		if response.status == 0 {
			return reportProxyUnreachable(acc.deps, response.transportError)
		}
		if response.status != 200 {
			return accountAPIError(acc.deps, response.body, fmt.Sprintf("failed to read %s", label), response.status)
		}
		strategyField := response.body.Find(strategyKey)
		stickyField := response.body.Find(stickyKey)
		if wantsJSON {
			value := jsonwire.ObjectValue()
			value.Set("ok", jsonwire.BoolValue(true))
			value.Set("provider", jsonwire.StringValue(name))
			if strategyField != nil {
				value.Set("strategy", strategyField)
			}
			if stickyField != nil {
				value.Set("stickyLimit", stickyField)
			}
			printPrettyJSON(acc.deps, value)
		} else {
			shown := strategyField
			if field == "stickyLimit" {
				shown = stickyField
			}
			fmt.Fprintln(acc.deps.Stdout, fmt.Sprintf("%s: %s is %s", name, label, jsonwireWireText(shown)))
		}
		return 0
	}
	// Sent as a number when it parses as one so the server sees the type it
	// validates; a non-numeric string still goes through.
	var value *jsonwire.Value
	if field == "strategy" {
		value = jsonwire.StringValue(requested)
	} else {
		number, err := strconv.ParseFloat(requested, 64)
		if err != nil {
			value = jsonwire.StringValue(requested)
		} else {
			value = jsonwire.NumberFrom(number)
		}
	}
	response := accountHTTP(acc.httpClientOr(), baseURL, "PUT", writePath, writeBody(value))
	if response.status == 0 {
		return reportProxyUnreachable(acc.deps, response.transportError)
	}
	if response.status != 200 {
		return accountAPIError(acc.deps, response.body, fmt.Sprintf("failed to set %s", label), response.status)
	}
	if wantsJSON {
		out := jsonwire.ObjectValue()
		out.Set("ok", jsonwire.BoolValue(true))
		out.Set("provider", jsonwire.StringValue(name))
		if fieldResp := response.body.Find(strategyKey); fieldResp != nil {
			out.Set("strategy", fieldResp)
		}
		if stickyResp := response.body.Find(stickyKey); stickyResp != nil {
			out.Set("stickyLimit", stickyResp)
		}
		printPrettyJSON(acc.deps, out)
	} else {
		appliedField := response.body.Find(strategyKey)
		if field == "stickyLimit" {
			appliedField = response.body.Find(stickyKey)
		}
		fmt.Fprintln(acc.deps.Stdout, fmt.Sprintf("%s: %s is now %s", name, label, jsonwireWireText(appliedField)))
	}
	return 0
}

// jsonwireWireText renders a json value the way String(jsValue) does for the
// keys poolSetting prints: an absent key is "undefined", JSON null is "null",
// numbers use the V8 spelling.
func jsonwireWireText(value *jsonwire.Value) string {
	if value == nil {
		return "undefined"
	}
	switch value.Kind() {
	case jsonwire.String:
		return value.String()
	case jsonwire.Number:
		number, err := numberAsFloat(value)
		if err != nil {
			return ""
		}
		return jsonwire.FormatV8Number(number)
	case jsonwire.Bool:
		if value.Bool() {
			return "true"
		}
		return "false"
	case jsonwire.Null:
		return "null"
	default:
		return ""
	}
}

// runAccountAlias mirrors cmdAlias. An alias of "-" (or an explicitly empty
// positional) clears the alias.
func runAccountAlias(rest []string, acc accountDeps) int {
	wantsJSON := consumeAccountFlag(&rest, "--json")
	if len(rest) < 3 || len(rest) > 3 {
		return accountExtendedUsageError(acc, "")
	}
	name := rest[0]
	requestedID := rest[1]
	requestedAlias := rest[2]
	raw := loadAccountConfigRaw()
	errorText, rowType, ok := classifyAccount(raw, name)
	if !ok {
		return accountExtendedUsageError(acc, "Error: "+errorText)
	}
	id := requestedID
	if rowType == accountTypeCodex && requestedID == mainAlias {
		id = mainAccountID
	}
	if id == mainAccountID {
		return accountExtendedUsageError(acc, "Error: the main Codex App login cannot be renamed")
	}
	alias := requestedAlias
	if alias == "-" {
		alias = ""
	} else {
		alias = strings.TrimSpace(alias)
	}
	if len([]rune(alias)) > 80 || accountHasControlChars(alias) {
		return accountExtendedUsageError(acc, "Error: alias must be at most 80 printable characters")
	}
	baseURL := resolveAccountBaseURL(acc)
	if baseURL == "" {
		return reportProxyUnreachable(acc.deps, "")
	}
	path := "/api/codex-auth/accounts/alias"
	body := jsonwire.ObjectValue()
	if rowType == accountTypeCodex {
		body.Set("id", jsonwire.StringValue(id))
		body.Set("alias", jsonwire.StringValue(alias))
	} else if rowType == accountTypeOAuth {
		path = "/api/oauth/accounts/alias"
		body.Set("provider", jsonwire.StringValue(name))
		body.Set("accountId", jsonwire.StringValue(id))
		body.Set("alias", jsonwire.StringValue(alias))
	} else {
		path = "/api/providers/keys/alias"
		body.Set("name", jsonwire.StringValue(name))
		body.Set("id", jsonwire.StringValue(id))
		body.Set("alias", jsonwire.StringValue(alias))
	}
	response := accountHTTP(acc.httpClientOr(), baseURL, "PUT", path, body)
	if response.status == 0 {
		return reportProxyUnreachable(acc.deps, response.transportError)
	}
	if response.status != 200 {
		return accountAPIError(acc.deps, response.body, fmt.Sprintf("failed to rename %s", requestedID), response.status)
	}
	value := jsonwire.ObjectValue()
	value.Set("ok", jsonwire.BoolValue(true))
	value.Set("provider", jsonwire.StringValue(name))
	value.Set("id", jsonwire.StringValue(id))
	if alias != "" {
		value.Set("alias", jsonwire.StringValue(alias))
	} else {
		value.Set("alias", jsonwire.NullValue())
	}
	if wantsJSON {
		printPrettyJSON(acc.deps, value)
	} else if alias != "" {
		fmt.Fprintln(acc.deps.Stdout, fmt.Sprintf("%s: %s is now \u201c%s\u201d", name, requestedID, alias))
	} else {
		fmt.Fprintln(acc.deps.Stdout, fmt.Sprintf("%s: cleared alias for %s", name, requestedID))
	}
	return 0
}

func accountHasControlChars(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// runAccountClearCooldown mirrors cmdClearCooldown in account-extended.ts.
func runAccountClearCooldown(rest []string, acc accountDeps) int {
	wantsJSON := consumeAccountFlag(&rest, "--json")
	name := accountShift(&rest)
	requestedID := accountShift(&rest)
	if name == "" || requestedID == "" || len(rest) > 0 {
		return accountExtendedUsageError(acc, "")
	}
	raw := loadAccountConfigRaw()
	errorText, rowType, ok := classifyAccount(raw, name)
	if !ok {
		return accountExtendedUsageError(acc, "Error: "+errorText)
	}
	if rowType != accountTypeCodex {
		return accountExtendedUsageError(acc, "Error: "+name+" is not a Codex account pool; cooldown clearing applies to Codex accounts only")
	}
	id := requestedID
	if requestedID == mainAlias {
		id = mainAccountID
	}
	baseURL := resolveAccountBaseURL(acc)
	if baseURL == "" {
		return reportProxyUnreachable(acc.deps, "")
	}
	body := jsonwire.ObjectValue()
	body.Set("id", jsonwire.StringValue(id))
	response := accountHTTP(acc.httpClientOr(), baseURL, "POST", "/api/codex-auth/accounts/clear-cooldown", body)
	if response.status == 0 {
		return reportProxyUnreachable(acc.deps, response.transportError)
	}
	if response.status != 200 {
		return accountAPIError(acc.deps, response.body, fmt.Sprintf("failed to clear cooldown for %s", requestedID), response.status)
	}
	cleared := false
	if field := response.body.Find("cleared"); field != nil && field.Kind() == jsonwire.Bool {
		cleared = field.Bool()
	}
	if wantsJSON {
		value := jsonwire.ObjectValue()
		value.Set("ok", jsonwire.BoolValue(true))
		value.Set("provider", jsonwire.StringValue(name))
		value.Set("id", jsonwire.StringValue(id))
		value.Set("cleared", jsonwire.BoolValue(cleared))
		printPrettyJSON(acc.deps, value)
	} else if cleared {
		fmt.Fprintln(acc.deps.Stdout, fmt.Sprintf("%s: cooldown lifted for %s", name, requestedID))
	} else {
		fmt.Fprintln(acc.deps.Stdout, fmt.Sprintf("%s: no active cooldown for %s", name, requestedID))
	}
	return 0
}

func signedIntegerString(value string) bool {
	if value == "" {
		return false
	}
	start := 0
	if value[0] == '+' || value[0] == '-' {
		start = 1
	}
	if start >= len(value) {
		return false
	}
	for i := start; i < len(value); i++ {
		if value[i] < '0' || value[i] > '9' {
			return false
		}
	}
	return true
}
