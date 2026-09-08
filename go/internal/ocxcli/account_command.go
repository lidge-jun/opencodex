// ocx account — Go-native port of src/cli/account.ts (the command switch and
// the list/current/use handlers) over the account_runtime data layer. The
// differential oracle feeds one attested fixture proxy and the same
// config.json to the TypeScript CLI and this binary and requires identical
// stdout/stderr and exit codes for every subcommand.
package ocxcli

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// accountFamilyRows is the FamilyRows shape account-api.ts returns.
type accountFamilyRows struct {
	rows          []*accountRow
	activeID      string
	hasActiveID   bool
	hasAutoSwitch bool
	autoSwitch    float64
	status        int
	errorBody     *jsonwire.Value
	networkDown   bool
	transportErr  string
}

func accountRowObject(row *accountRow, includeQuota bool) *jsonwire.Value {
	out := jsonwire.ObjectValue()
	out.Set("provider", jsonwire.StringValue(row.provider))
	out.Set("type", jsonwire.StringValue(string(row.rowType)))
	out.Set("id", jsonwire.StringValue(row.id))
	if row.hasLabel {
		out.Set("label", jsonwire.StringValue(row.label))
	}
	if row.hasEmail {
		out.Set("email", jsonwire.StringValue(row.email))
	}
	if row.hasPlan {
		out.Set("plan", jsonwire.StringValue(row.plan))
	}
	if row.hasMasked {
		out.Set("masked", jsonwire.StringValue(row.masked))
	}
	out.Set("active", jsonwire.BoolValue(row.active))
	if row.needsReauthSet {
		out.Set("needsReauth", jsonwire.BoolValue(row.needsReauth))
	}
	if row.rowType == accountTypeCodex {
		out.Set("priority", jsonwire.NumberFrom(row.priority))
		out.Set("paused", jsonwire.BoolValue(row.paused))
		if includeQuota {
			out.Set("quota", row.quota)
		}
	}
	if row.rowType == accountTypeOAuth {
		if row.hasQuota {
			out.Set("quota", row.quota)
		}
		if row.quotaUnavailable {
			out.Set("quotaUnavailable", jsonwire.BoolValue(true))
		}
	}
	return out
}

func projectQuota(quota *jsonwire.Value) *jsonwire.Value {
	if quota == nil || quota.Kind() != jsonwire.Object {
		return jsonwire.NullValue()
	}
	keys := []string{"fiveHourPercent", "fiveHourResetAt", "weeklyPercent", "monthlyPercent", "weeklyResetAt", "monthlyResetAt", "shortPercent", "shortResetAt", "shortWindowSeconds"}
	out := jsonwire.ObjectValue()
	for _, key := range keys {
		field := quota.Find(key)
		if field == nil || field.Kind() != jsonwire.Number {
			continue
		}
		if number, err := numberAsFloat(field); err == nil && number == number {
			out.Set(key, field)
		}
	}
	return out
}

// fetchCodexRows mirrors fetchCodexRows in account-api.ts (two parallel GETs).
func fetchCodexRows(client *http.Client, baseURL string, forceRefresh, includeQuota bool) accountFamilyRows {
	accountsPath := "/api/codex-auth/accounts"
	if forceRefresh {
		accountsPath += "?refresh=1"
	}
	accounts := accountHTTP(client, baseURL, "GET", accountsPath, nil)
	active := accountHTTP(client, baseURL, "GET", "/api/codex-auth/active", nil)
	rows := accountFamilyRows{status: 200}
	if accounts.status != 0 && accounts.status != 200 {
		return accountFamilyRows{status: accounts.status, errorBody: accounts.body}
	}
	if active.status != 0 && active.status != 200 {
		return accountFamilyRows{status: active.status, errorBody: active.body}
	}
	if accounts.status == 0 || active.status == 0 {
		transportErr := accounts.transportError
		if transportErr == "" {
			transportErr = active.transportError
		}
		return accountFamilyRows{status: 0, networkDown: true, transportErr: transportErr}
	}
	if field := active.body.Find("activeCodexAccountId"); field != nil && field.Kind() == jsonwire.String {
		rows.activeID = field.String()
		rows.hasActiveID = true
	}
	if number, ok := accountNumber(active.body, "autoSwitchThreshold"); ok {
		rows.autoSwitch = number
		rows.hasAutoSwitch = true
	}
	accountsArray := activeOrEmptyArray(accounts.body, "accounts")
	for _, account := range accountsArray {
		row := &accountRow{provider: "openai", rowType: accountTypeCodex}
		row.id = objectString(account, "id")
		// label = a.alias ?? a.plan ?? a.email (nullish, not empty-coalescing).
		aliasValue, aliasSet := objectField(account, "alias")
		planValue, planSet := objectField(account, "plan")
		emailValue, emailSet := objectField(account, "email")
		row.hasPlan = planSet
		row.plan = planValue
		row.hasEmail = emailSet
		row.email = emailValue
		if aliasSet {
			row.hasLabel = true
			row.label = aliasValue
		} else if planSet {
			row.hasLabel = true
			row.label = planValue
		} else if emailSet {
			row.hasLabel = true
			row.label = emailValue
		}
		row.active = row.id != "" && row.id == rows.activeID
		row.needsReauthSet, row.needsReauth = objectBool(account, "needsReauth")
		row.hasPriority = true
		if number, ok := accountNumber(account, "priority"); ok {
			row.priority = number
		}
		if paused, present := objectBool(account, "paused"); present {
			row.paused = paused
		}
		if includeQuota {
			row.quota = projectQuota(account.Find("quota"))
			row.hasQuota = true
		}
		rows.rows = append(rows.rows, row)
	}
	return rows
}

// fetchOAuthRows mirrors fetchOAuthRows.
func fetchOAuthRows(client *http.Client, baseURL, name string, withQuota, refreshQuota bool) accountFamilyRows {
	query := ""
	if withQuota {
		query = "?provider=" + urlQueryEscape(name) + "&quota=1"
		if refreshQuota {
			query += "&refresh=1"
		}
	} else {
		query = "?provider=" + urlQueryEscape(name)
	}
	response := accountHTTP(client, baseURL, "GET", "/api/oauth/accounts"+query, nil)
	if response.status == 0 {
		return accountFamilyRows{status: 0, networkDown: true, transportErr: response.transportError}
	}
	if response.status != 200 {
		return accountFamilyRows{status: response.status, errorBody: response.body}
	}
	rows := accountFamilyRows{status: 200}
	if field := response.body.Find("activeAccountId"); field != nil && field.Kind() == jsonwire.String {
		rows.activeID = field.String()
		rows.hasActiveID = true
	}
	for index, account := range activeOrEmptyArray(response.body, "accounts") {
		row := &accountRow{provider: name, rowType: accountTypeOAuth}
		row.id = objectString(account, "id")
		aliasValue, aliasSet := objectField(account, "alias")
		emailValue, emailSet := objectField(account, "email")
		row.hasEmail = emailSet
		row.email = emailValue
		if aliasSet {
			row.hasLabel = true
			row.label = aliasValue
		} else if emailSet {
			row.hasLabel = true
			row.label = emailValue
		} else {
			row.hasLabel = true
			row.label = fmt.Sprintf("Account %d", index+1)
		}
		row.active = false
		if activeField := account.Find("active"); activeField != nil && activeField.Kind() == jsonwire.Bool {
			row.active = activeField.Bool()
		} else if row.id != "" {
			row.active = row.id == rows.activeID
		}
		row.needsReauthSet, row.needsReauth = objectBool(account, "needsReauth")
		if quota := account.Find("quota"); quota != nil {
			row.quota = quota
			row.hasQuota = true
		}
		if unavailable := account.Find("quotaUnavailable"); unavailable != nil && unavailable.Kind() == jsonwire.Bool {
			row.quotaUnavailable = unavailable.Bool()
		}
		rows.rows = append(rows.rows, row)
	}
	return rows
}

// fetchKeyRows mirrors fetchKeyRows.
func fetchKeyRows(client *http.Client, baseURL, name string) accountFamilyRows {
	response := accountHTTP(client, baseURL, "GET", "/api/providers/keys?name="+urlQueryEscape(name), nil)
	if response.status == 0 {
		return accountFamilyRows{status: 0, networkDown: true, transportErr: response.transportError}
	}
	if response.status != 200 {
		return accountFamilyRows{status: response.status, errorBody: response.body}
	}
	rows := accountFamilyRows{status: 200}
	if field := response.body.Find("activeId"); field != nil && field.Kind() == jsonwire.String {
		rows.activeID = field.String()
		rows.hasActiveID = true
	}
	for _, key := range activeOrEmptyArray(response.body, "keys") {
		row := &accountRow{provider: name, rowType: accountTypeAPIKey}
		row.id = objectString(key, "id")
		labelValue, labelSet := objectField(key, "label")
		maskedValue, maskedSet := objectField(key, "masked")
		row.hasMasked = maskedSet
		row.masked = maskedValue
		// row.label = k.label ?? k.masked (nullish).
		if labelSet {
			row.hasLabel = true
			row.label = labelValue
		} else if maskedSet {
			row.hasLabel = true
			row.label = maskedValue
		}
		row.active = false
		if activeField := key.Find("active"); activeField != nil && activeField.Kind() == jsonwire.Bool {
			row.active = activeField.Bool()
		} else if row.id != "" {
			row.active = row.id == rows.activeID
		}
		rows.rows = append(rows.rows, row)
	}
	return rows
}

func fetchAccountRows(client *http.Client, baseURL, name string, rowType AccountType, withQuota, refreshQuota bool) accountFamilyRows {
	switch rowType {
	case accountTypeCodex:
		return fetchCodexRows(client, baseURL, refreshQuota, withQuota)
	case accountTypeOAuth:
		return fetchOAuthRows(client, baseURL, name, withQuota, refreshQuota)
	default:
		return fetchKeyRows(client, baseURL, name)
	}
}

// familyFailure maps a FamilyRows error to an exit code, mirroring the
// familyFailure helper in account-extended.ts; nil means no failure.
func accountFamilyFailure(deps Deps, result accountFamilyRows, fallback string) *int {
	if result.networkDown {
		code := reportProxyUnreachable(deps, result.transportErr)
		return &code
	}
	if result.errorBody != nil {
		code := accountAPIError(deps, result.errorBody, fallback, result.status)
		return &code
	}
	return nil
}

func objectField(object *jsonwire.Value, key string) (value string, present bool) {
	if object == nil || object.Kind() != jsonwire.Object {
		return "", false
	}
	field := object.Find(key)
	if field == nil || field.Kind() != jsonwire.String {
		return "", false
	}
	return field.String(), true
}

func objectBool(object *jsonwire.Value, key string) (value bool, present bool) {
	if object == nil || object.Kind() != jsonwire.Object {
		return false, false
	}
	field := object.Find(key)
	if field == nil || field.Kind() != jsonwire.Bool {
		return false, false
	}
	return field.Bool(), true
}

func objectString(object *jsonwire.Value, key string) string {
	if object == nil || object.Kind() != jsonwire.Object {
		return ""
	}
	field := object.Find(key)
	if field == nil || field.Kind() != jsonwire.String {
		return ""
	}
	return field.String()
}

func activeOrEmptyArray(object *jsonwire.Value, key string) []*jsonwire.Value {
	if object == nil || object.Kind() != jsonwire.Object {
		return nil
	}
	field := object.Find(key)
	if field == nil || field.Kind() != jsonwire.Array {
		return nil
	}
	return field.Elements()
}

func firstPresent(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// urlQueryEscape mirrors encodeURIComponent: every byte outside the RFC 3986
// unreserved set (A-Z a-z 0-9 - _ . ~) becomes an uppercase %XX escape.
func urlQueryEscape(value string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&0xf])
	}
	return b.String()
}

// consumeAccountPositionals strips a leading positional (returned as the
// trimmed name) after all flags were consumed.
func accountShift(args *[]string) string {
	if len(*args) == 0 {
		return ""
	}
	value := (*args)[0]
	*args = (*args)[1:]
	return value
}

// runAccountList mirrors cmdList in account.ts.
func runAccountList(rest []string, deps accountDeps) int {
	wantsJSON := consumeAccountFlag(&rest, "--json")
	showAll := consumeAccountFlag(&rest, "--all")
	wantsQuota := consumeAccountFlag(&rest, "--quota")
	refreshQuota := consumeAccountFlag(&rest, "--refresh")
	name := accountShift(&rest)
	if leftover := accountLeftoverError(rest); leftover != "" {
		reportAccountStderrLine(deps, leftover)
		reportAccountUsage(deps, accountUsage)
		return 1
	}
	raw := loadAccountConfigRaw()
	baseURL := resolveAccountBaseURL(deps)
	if baseURL == "" {
		return reportProxyUnreachable(deps.deps, "")
	}

	type target struct {
		name    string
		rowType AccountType
	}
	var targets []target
	if name != "" {
		errorText, rowType, ok := classifyAccount(raw, name)
		if !ok {
			reportAccountStderrLine(deps, fmt.Sprintf("Error: %s. Known candidates: %s", errorText, candidateNames(raw)))
			return 1
		}
		targets = append(targets, target{name: name, rowType: rowType})
	} else {
		seen := map[string]bool{}
		push := func(n string) {
			if seen[n] {
				return
			}
			seen[n] = true
			_, rowType, ok := classifyAccount(raw, n)
			if !ok {
				return
			}
			targets = append(targets, target{name: n, rowType: rowType})
		}
		push("openai")
		providersRes := accountHTTP(deps.httpClientOr(), baseURL, "GET", "/api/oauth/providers", nil)
		if providersRes.status == 0 {
			return reportProxyUnreachable(deps.deps, providersRes.transportError)
		}
		if providersRes.status != 200 {
			return accountAPIError(deps.deps, providersRes.body, "failed to list OAuth providers", providersRes.status)
		}
		if providers := activeOrEmptyArray(providersRes.body, "providers"); providers != nil {
			for _, provider := range providers {
				if provider.Kind() == jsonwire.String {
					push(provider.String())
				}
			}
		}
		providersSection, _ := raw["providers"].(map[string]any)
		for providerName := range providersSection {
			push(providerName)
		}
	}

	var rows []*accountRow
	var notes []string
	for _, target := range targets {
		var result accountFamilyRows
		if wantsQuota {
			result = fetchAccountRows(deps.httpClientOr(), baseURL, target.name, target.rowType, true, refreshQuota)
		} else {
			result = fetchAccountRows(deps.httpClientOr(), baseURL, target.name, target.rowType, false, false)
		}
		if result.networkDown {
			return reportProxyUnreachable(deps.deps, result.transportErr)
		}
		if result.errorBody != nil {
			if name != "" {
				return accountAPIError(deps.deps, result.errorBody, fmt.Sprintf("failed to list %s", target.name), result.status)
			}
			errorText := objectString(result.errorBody, "error")
			skipUnknownKey := target.rowType == accountTypeAPIKey && result.status == 404 && strings.Contains(errorText, "unknown provider")
			skipConfigOAuth := target.rowType == accountTypeOAuth && result.status == 400 && strings.Contains(errorText, "unknown oauth provider")
			if skipUnknownKey || skipConfigOAuth {
				continue
			}
			return accountAPIError(deps.deps, result.errorBody, fmt.Sprintf("failed to list %s", target.name), result.status)
		}
		if len(result.rows) == 0 {
			if showAll {
				notes = append(notes, fmt.Sprintf("%s: no stored accounts or keys", target.name))
			}
			continue
		}
		rows = append(rows, result.rows...)
		if target.rowType == accountTypeCodex {
			if !result.hasActiveID {
				notes = append(notes, "openai: auto (no pin — lowest-usage account is selected per request)")
			}
			providerRow, _ := configProviderMode(raw, "openai")
			if codexAccountModeFor("openai", providerRow) == "direct" {
				notes = append(notes, "openai is in direct mode — the selection takes effect when pool mode is enabled")
			}
		}
	}

	if wantsJSON {
		value := jsonwire.ObjectValue()
		accounts := jsonwire.EmptyArray()
		for _, row := range rows {
			accounts.AppendArray(accountRowObject(row, wantsQuota))
		}
		value.Set("accounts", accounts)
		noteArray := jsonwire.EmptyArray()
		for _, note := range notes {
			noteArray.AppendArray(jsonwire.StringValue(note))
		}
		value.Set("notes", noteArray)
		printPrettyJSON(deps.deps, value)
		return 0
	}
	if len(rows) > 0 {
		fmt.Fprintln(deps.deps.Stdout, formatAccountTable(rows, wantsQuota))
	}
	for _, note := range notes {
		fmt.Fprintln(deps.deps.Stdout, note)
	}
	if len(rows) == 0 && len(notes) == 0 {
		fmt.Fprintln(deps.deps.Stdout, "No stored accounts or keys.")
	}
	return 0
}

// runAccountCurrent mirrors cmdCurrent in account.ts.
func runAccountCurrent(rest []string, deps accountDeps) int {
	wantsJSON := consumeAccountFlag(&rest, "--json")
	name := accountShift(&rest)
	leftover := accountLeftoverError(rest)
	if name == "" || leftover != "" {
		if leftover != "" {
			reportAccountStderrLine(deps, leftover)
		}
		reportAccountUsage(deps, accountUsage)
		return 1
	}
	raw := loadAccountConfigRaw()
	errorText, rowType, ok := classifyAccount(raw, name)
	if !ok {
		reportAccountStderrLine(deps, fmt.Sprintf("Error: %s. Known candidates: %s", errorText, candidateNames(raw)))
		return 1
	}
	baseURL := resolveAccountBaseURL(deps)
	if baseURL == "" {
		return reportProxyUnreachable(deps.deps, "")
	}
	result := fetchAccountRows(deps.httpClientOr(), baseURL, name, rowType, false, false)
	if result.networkDown {
		return reportProxyUnreachable(deps.deps, result.transportErr)
	}
	if result.errorBody != nil {
		return accountAPIError(deps.deps, result.errorBody, fmt.Sprintf("failed to read %s", name), result.status)
	}
	var activeRow *accountRow
	for _, row := range result.rows {
		if row.active {
			activeRow = row
			break
		}
	}
	if wantsJSON {
		value := jsonwire.ObjectValue()
		value.Set("provider", jsonwire.StringValue(name))
		value.Set("type", jsonwire.StringValue(string(rowType)))
		if result.hasActiveID {
			value.Set("activeId", jsonwire.StringValue(result.activeID))
		} else {
			value.Set("activeId", jsonwire.NullValue())
		}
		if result.hasAutoSwitch {
			value.Set("autoSwitchThreshold", jsonwire.NumberFrom(result.autoSwitch))
		}
		if activeRow != nil {
			value.Set("account", accountRowObject(activeRow, false))
		} else {
			value.Set("account", jsonwire.NullValue())
		}
		printPrettyJSON(deps.deps, value)
		return 0
	}
	if activeRow != nil {
		fmt.Fprintln(deps.deps.Stdout, formatAccountTable([]*accountRow{activeRow}, false))
	} else if rowType == accountTypeCodex && !result.hasActiveID {
		fmt.Fprintln(deps.deps.Stdout, "openai: auto (no pin — lowest-usage account is selected per request)")
	} else {
		fmt.Fprintln(deps.deps.Stdout, fmt.Sprintf("%s: no active account or key", name))
	}
	return 0
}

// runAccountUse mirrors cmdUse in account.ts.
func runAccountUse(rest []string, deps accountDeps) int {
	wantsJSON := consumeAccountFlag(&rest, "--json")
	name := accountShift(&rest)
	id := accountShift(&rest)
	leftover := accountLeftoverError(rest)
	if name == "" || id == "" || leftover != "" {
		if leftover != "" {
			reportAccountStderrLine(deps, leftover)
		}
		reportAccountUsage(deps, accountUsage)
		return 1
	}
	raw := loadAccountConfigRaw()
	errorText, rowType, ok := classifyAccount(raw, name)
	if !ok {
		reportAccountStderrLine(deps, fmt.Sprintf("Error: %s. Known candidates: %s", errorText, candidateNames(raw)))
		return 1
	}
	baseURL := resolveAccountBaseURL(deps)
	if baseURL == "" {
		return reportProxyUnreachable(deps.deps, "")
	}
	var response accountAPIResult
	activeID := ""
	switch rowType {
	case accountTypeCodex:
		activeID = id
		if id == mainAlias {
			activeID = mainAccountID
		}
		body := jsonwire.ObjectValue()
		body.Set("accountId", jsonwire.StringValue(activeID))
		response = accountHTTP(deps.httpClientOr(), baseURL, "PUT", "/api/codex-auth/active", body)
	case accountTypeOAuth:
		activeID = id
		body := jsonwire.ObjectValue()
		body.Set("provider", jsonwire.StringValue(name))
		body.Set("accountId", jsonwire.StringValue(id))
		response = accountHTTP(deps.httpClientOr(), baseURL, "PUT", "/api/oauth/accounts/active", body)
	default:
		activeID = id
		body := jsonwire.ObjectValue()
		body.Set("name", jsonwire.StringValue(name))
		body.Set("id", jsonwire.StringValue(id))
		response = accountHTTP(deps.httpClientOr(), baseURL, "PUT", "/api/providers/keys/active", body)
	}
	if response.status == 0 {
		return reportProxyUnreachable(deps.deps, response.transportError)
	}
	if response.status != 200 {
		return accountAPIError(deps.deps, response.body, fmt.Sprintf("failed to switch %s", name), response.status)
	}
	if wantsJSON {
		value := jsonwire.ObjectValue()
		value.Set("ok", jsonwire.BoolValue(true))
		value.Set("provider", jsonwire.StringValue(name))
		value.Set("type", jsonwire.StringValue(string(rowType)))
		value.Set("activeId", jsonwire.StringValue(activeID))
		printPrettyJSON(deps.deps, value)
	} else {
		kind := "account"
		if rowType == accountTypeAPIKey {
			kind = "key"
		}
		fmt.Fprintln(deps.deps.Stdout, fmt.Sprintf("%s: active %s is now %s", name, kind, displayID(activeID)))
	}
	if rowType == accountTypeCodex {
		reportAccountStderrLine(deps, "Takes effect immediately; running threads move on their next request, and in-flight requests keep the account they captured.")
		active := accountHTTP(deps.httpClientOr(), baseURL, "GET", "/api/codex-auth/active", nil)
		if active.status == 200 {
			if number, ok := accountNumber(active.body, "autoSwitchThreshold"); ok && number > 0 {
				reportAccountStderrLine(deps, fmt.Sprintf("Note: auto-switch (threshold %s%%) may override this pin.", jsonwire.FormatV8Number(number)))
			}
		}
	}
	return 0
}

func reportAccountStderrLine(deps accountDeps, line string) {
	fmt.Fprintln(deps.deps.Stderr, line)
}

func reportAccountUsage(deps accountDeps, usage string) {
	fmt.Fprintln(deps.deps.Stderr, usage)
}

func (d accountDeps) httpClientOr() *http.Client {
	if d.httpClient != nil {
		return d.httpClient
	}
	return defaults(d.deps).HTTPClient
}
