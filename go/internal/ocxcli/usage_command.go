package ocxcli

import (
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
	"github.com/lidge-jun/opencodex/go/internal/managementauth"
)

// ocx usage — the token and estimated-cost report (top-level alias of
// `ocx observe usage`). This file ports the TypeScript owner (src/cli/observe.ts
// usage + src/cli/usage-report.ts + the runtime-api error taxonomy) so the
// ownership flip keeps the documented surface identical; the differential
// harness diffs TS CLI output against this implementation for the same argv and
// mocked API payload.
//
// Exit codes mirror runCliAction:
//   - usage errors: exit 2, "Error: <msg>" + the observe USAGE block on stderr
//   - RuntimeApiError: exit 4 on 404, 5 on 409, otherwise 1

const observeUsageUsage = `Usage:
  ocx observe logs [--provider <name>] [--model <id>] [--status <code>]
      [--conversation <id>] [--limit <n>] [--follow] [--json|--jsonl]
  ocx logs explain <request-id> [--json]
  ocx logs rebuild-index
  ocx logs index-status
  ocx observe usage [--range <today|1d|7d|30d|all>] [--surface <all|codex|claude|grok>]
      [--provider <name>] [--model <id>] [--json]
  ocx observe storage [codex-logs [status|protect|unprotect|repair|compact] [--mode <compat|quiet>]] [--json]
  ocx observe memory [--json]
  ocx observe debug [--json]
  ocx observe claude-inbound [--limit <n>] [--json]
  ocx observe injection [--limit <n>] [--json]`

var usageRanges = []string{"today", "7d", "30d", "all"}
var usageSurfaces = []string{"all", "codex", "claude", "grok"}

// Exit codes from the runCliAction taxonomy, named for the command file.
const (
	usageExitUsage    = 2 // CliUsageError
	usageExitMissing  = 4 // RuntimeApiError status 404
	usageExitConflict = 5 // RuntimeApiError status 409
)

// usageUnexpectedArgs mirrors rejectArgs without redaction (usage filters carry
// no secret options).
func usageUnexpectedArgs(args []string) error {
	return fmt.Errorf("Unexpected argument(s): %s", strings.Join(args, " "))
}

// takeUsageFlag mirrors takeFlag: remove `flag` from args anywhere in argv and
// report whether it was present.
func takeUsageFlag(args *[]string, flag string) bool {
	for index, arg := range *args {
		if arg == flag {
			*args = append((*args)[:index], (*args)[index+1:]...)
			return true
		}
	}
	return false
}

// takeUsageOption mirrors takeOption: `--flag value`, rejecting a missing value
// with the exact TypeScript message.
func takeUsageOption(args *[]string, flag string) (string, bool, error) {
	for index, arg := range *args {
		if arg != flag {
			continue
		}
		if index+1 >= len(*args) || strings.HasPrefix((*args)[index+1], "--") {
			return "", false, fmt.Errorf("%s requires a value", flag)
		}
		value := (*args)[index+1]
		*args = append((*args)[:index], (*args)[index+2:]...)
		return value, true, nil
	}
	return "", false, nil
}

// configuredUsageAdminToken mirrors configuredAdminToken: env first, then the
// validated admin-api-token file.
func configuredUsageAdminToken() string {
	if env := managementauth.EnvAdminToken(os.Getenv); env != "" {
		return env
	}
	dir, err := config.Dir()
	if err != nil {
		return ""
	}
	return managementauth.LoadAdminToken(dir)
}

// usageQuery mirrors the observe.ts query helper: URLSearchParams.set for every
// provided param in declaration order (Go's url.Values would sort keys, so the
// order is built by hand). A nil entry means "not provided" (undefined).
func usageQuery(params ...*string) string {
	keys := []string{"range", "surface", "provider", "model"}
	var b strings.Builder
	for i, value := range params {
		if value == nil {
			continue
		}
		if b.Len() == 0 {
			b.WriteByte('?')
		} else {
			b.WriteByte('&')
		}
		b.WriteString(url.QueryEscape(keys[i]))
		b.WriteByte('=')
		b.WriteString(url.QueryEscape(*value))
	}
	return b.String()
}

// usageResponseMessage mirrors responseMessage in runtime-api.ts: compose the
// operator-facing message from a management error body.
func usageResponseMessage(body *jsonwire.Value, rawText string, status int) string {
	if rawText != "" {
		trimmed := strings.TrimSpace(rawText)
		if trimmed != "" {
			return truncateRunes(trimmed, 400)
		}
	}
	if body == nil || body.Kind() != jsonwire.Object {
		return fmt.Sprintf("Management request failed (%d)", status)
	}
	primary := ""
	for _, key := range []string{"error", "message", "detail"} {
		if field := body.Find(key); field != nil && field.Kind() == jsonwire.String {
			if trimmed := strings.TrimSpace(field.String()); trimmed != "" {
				primary = trimmed
				break
			}
		}
	}
	if primary == "" {
		primary = fmt.Sprintf("Management request failed (%d)", status)
	}
	parts := []string{primary}
	for _, key := range []string{"reason", "hint"} {
		if field := body.Find(key); field != nil && field.Kind() == jsonwire.String {
			trimmed := strings.TrimSpace(field.String())
			if trimmed != "" && trimmed != primary {
				parts = append(parts, key+": "+trimmed)
			}
		}
	}
	return truncateRunes(strings.Join(parts, "\n"), 1200)
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

// liveProxyEndpoint locates the running proxy the way findLiveProxy does:
// the runtime-port record is probed with a /healthz identity check before it is
// trusted, and the configured port is the fallback only when no runtime record
// answers. The returned state carries the record's attestation secret so
// callers keep one shape; only Hostname and Port are consumed here.
func liveProxyEndpoint(deps Deps) (RuntimeState, bool) {
	deps = defaults(deps)
	if state, err := deps.ReadRuntime(); err == nil {
		if proxyServesOpencodex(deps, state.Hostname, state.Port) {
			return state, true
		}
	}
	cfg, err := loadCLIConfig()
	if err != nil {
		return RuntimeState{}, false
	}
	port := 10100
	if raw, ok := cfg["port"].(float64); ok && raw == math.Trunc(raw) && raw >= 1 && raw <= 65535 {
		port = int(raw)
	}
	hostname, _ := cfg["hostname"].(string)
	if proxyServesOpencodex(deps, hostname, port) {
		return RuntimeState{Hostname: hostname, Port: port}, true
	}
	return RuntimeState{}, false
}

// proxyServesOpencodex mirrors proxyIdentityAt + isOpencodexHealthz: a single
// 750ms GET /healthz whose body must name the service (or carry the legacy
// ok+version+uptime identity).
func proxyServesOpencodex(deps Deps, hostname string, port int) bool {
	host := hostname
	if strings.TrimSpace(host) == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		host = "127.0.0.1"
	}
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	request, err := http.NewRequest(http.MethodGet, "http://"+host+":"+strconv.Itoa(port)+"/healthz", nil)
	if err != nil {
		return false
	}
	response, err := deps.HTTPClient.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return false
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return false
	}
	body, err := jsonwire.Parse(raw)
	if err != nil || body.Kind() != jsonwire.Object {
		return false
	}
	if service := body.Find("service"); service != nil {
		return service.Kind() == jsonwire.String && service.String() == "opencodex"
	}
	if status := body.Find("status"); status == nil || status.Kind() != jsonwire.String || status.String() != "ok" {
		return false
	}
	version := body.Find("version")
	uptime := body.Find("uptime")
	return version != nil && version.Kind() == jsonwire.String && uptime != nil && uptime.Kind() == jsonwire.Number
}

// fetchUsageReport performs the management GET for /api/usage with the exact
// error messages of runtimeRequest/runtimeBaseUrl. rawText is set only when the
// body was not valid JSON (runtimeRequest keeps the text in that case).
func fetchUsageReport(deps Deps, queryString string) (body *jsonwire.Value, rawText string, status int, err error) {
	deps = defaults(deps)
	state, found := liveProxyEndpoint(deps)
	if !found {
		return nil, "", 503, errors.New("Proxy is not running. Start it with: ocx start")
	}
	request, requestErr := http.NewRequest(http.MethodGet, baseURL(state)+"/api/usage"+queryString, nil)
	if requestErr != nil {
		return nil, "", 503, fmt.Errorf("Management API is unreachable: %s", requestErr)
	}
	request.Header.Set("Content-Type", "application/json")
	if token := configuredUsageAdminToken(); token != "" {
		request.Header.Set("X-OpenCodex-API-Key", token)
	}
	response, doErr := deps.HTTPClient.Do(request)
	if doErr != nil {
		return nil, "", 503, fmt.Errorf("Management API is unreachable: %s", doErr)
	}
	defer response.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024))
	if readErr != nil {
		return nil, "", 503, fmt.Errorf("Management API is unreachable: %s", readErr)
	}
	value, parseErr := jsonwire.Parse(raw)
	if parseErr != nil {
		return nil, string(raw), response.StatusCode, nil
	}
	return value, "", response.StatusCode, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Human rendering — port of src/cli/usage-report.ts.

const usageMaxModelRows = 10

// usageTerminalText mirrors terminalText: control characters become \xNN / \uNNNN.
func usageTerminalText(value string) string {
	var b strings.Builder
	for _, character := range []rune(value) {
		code := int(character)
		if character >= 0x00 && character <= 0x1f || character >= 0x7f && character <= 0x9f {
			if code <= 0x7f {
				b.WriteString(fmt.Sprintf("\\x%02x", code))
			} else {
				b.WriteString(fmt.Sprintf("\\u%04x", code))
			}
			continue
		}
		b.WriteRune(character)
	}
	return b.String()
}

// usageCount mirrors count: toLocaleString("en-US") on the value or 0.
func usageCount(value float64, ok bool) string {
	if !ok {
		value = 0
	}
	return formatENUS(value)
}

// formatENUS renders a float64 the way Number.prototype.toLocaleString("en-US")
// does for the integer magnitudes usage reports carry: grouped integer digits
// with commas, and a fraction only when the value is not an integer.
func formatENUS(value float64) string {
	if value == math.Trunc(value) && math.Abs(value) < 1e15 {
		return groupDigits(strconv.FormatInt(int64(value), 10))
	}
	fixed := strconv.FormatFloat(value, 'f', -1, 64)
	intPart, fracPart, _ := strings.Cut(fixed, ".")
	return groupDigits(intPart) + "." + fracPart
}

func groupDigits(digits string) string {
	if len(digits) == 0 {
		return digits
	}
	negative := digits[0] == '-'
	if negative {
		digits = digits[1:]
	}
	var b strings.Builder
	first := len(digits) % 3
	if first > 0 {
		b.WriteString(digits[:first])
	}
	for i := first; i < len(digits); i += 3 {
		if b.Len() > 0 {
			b.WriteByte(',')
		}
		b.WriteString(digits[i : i+3])
	}
	if negative {
		return "-" + b.String()
	}
	return b.String()
}

// usageUSD mirrors usd: ~$ with four fraction digits, or an em dash for a
// missing or non-finite estimate.
func usageUSD(value float64, ok bool) string {
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
		return "—"
	}
	return fmt.Sprintf("~$%.4f", value)
}

// usageTable mirrors table: terminal-text every cell, dynamic padEnd columns,
// two-space joins, trailing spaces trimmed.
func usageTable(header []string, rows [][]string) []string {
	if len(rows) == 0 {
		return nil
	}
	for i, cell := range header {
		header[i] = usageTerminalText(cell)
	}
	for _, row := range rows {
		for c, cell := range row {
			row[c] = usageTerminalText(cell)
		}
	}
	widths := make([]int, len(header))
	for i, cell := range header {
		widths[i] = utf8.RuneCountInString(cell)
	}
	for _, row := range rows {
		for i := range header {
			if i < len(row) {
				if n := utf8.RuneCountInString(row[i]); n > widths[i] {
					widths[i] = n
				}
			}
		}
	}
	line := func(cols []string) string {
		var b strings.Builder
		for i := range header {
			if i > 0 {
				b.WriteString("  ")
			}
			cell := ""
			if i < len(cols) {
				cell = cols[i]
			}
			b.WriteString(cell)
			if pad := widths[i] - utf8.RuneCountInString(cell); pad > 0 {
				b.WriteString(strings.Repeat(" ", pad))
			}
		}
		return strings.TrimRight(b.String(), " ")
	}
	lines := []string{line(header)}
	for _, row := range rows {
		lines = append(lines, line(row))
	}
	return lines
}

// usageReportView is the decoded projection of the /api/usage payload the
// renderer consumes. Field presence (ok) matters: the TS renderer branches on
// undefined, not on zero.
type usageCostRow struct {
	provider        string
	model           string
	modelOK         bool
	requests        float64
	requestsOK      bool
	totalTokens     float64
	tokensOK        bool
	estimatedCost   float64
	costOK          bool
	ambiguous       bool
	accountLogLabel string
}

type usageReportView struct {
	rangeValue       string
	rangeOK          bool
	surface          string
	surfaceOK        bool
	filterProvider   string
	filterProviderOK bool
	filterModel      string
	filterModelOK    bool
	filterMatched    bool
	filterPresent    bool
	comboOverlap     bool
	requests         float64
	requestsOK       bool
	totalTokens      float64
	tokensOK         bool
	inputTokens      float64
	inputOK          bool
	outputTokens     float64
	outputOK         bool
	cachedTokens     float64
	cachedOK         bool
	estimatedCost    float64
	costOK           bool
	unpriced         float64
	unpricedOK       bool
	unmetered        float64
	unmeteredOK      bool
	providers        []usageCostRow
	models           []usageCostRow
	accounts         []usageCostRow
}

func numberField(object *jsonwire.Value, key string) (float64, bool) {
	if object == nil || object.Kind() != jsonwire.Object {
		return 0, false
	}
	field := object.Find(key)
	if field == nil || field.Kind() != jsonwire.Number {
		return 0, false
	}
	return parseJSONNumber(field.NumberRaw())
}

func stringField(object *jsonwire.Value, key string) (string, bool) {
	if object == nil || object.Kind() != jsonwire.Object {
		return "", false
	}
	field := object.Find(key)
	if field == nil || field.Kind() != jsonwire.String {
		return "", false
	}
	return field.String(), true
}

func parseJSONNumber(raw string) (float64, bool) {
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, false
	}
	return value, true
}

func costRowFrom(object *jsonwire.Value) usageCostRow {
	row := usageCostRow{}
	row.provider, _ = stringField(object, "provider")
	row.model, row.modelOK = stringField(object, "model")
	row.requests, row.requestsOK = numberField(object, "requests")
	row.totalTokens, row.tokensOK = numberField(object, "totalTokens")
	row.estimatedCost, row.costOK = numberField(object, "estimatedCostUsd")
	row.ambiguous = object != nil && object.Find("ambiguous") != nil && object.Find("ambiguous").Kind() == jsonwire.Bool && object.Find("ambiguous").Bool()
	row.accountLogLabel, _ = stringField(object, "accountLogLabel")
	return row
}

func rowsFromArray(value *jsonwire.Value) []usageCostRow {
	if value == nil || value.Kind() != jsonwire.Array {
		return nil
	}
	var rows []usageCostRow
	for _, element := range value.Elements() {
		if element == nil || element.Kind() != jsonwire.Object {
			continue
		}
		rows = append(rows, costRowFrom(element))
	}
	return rows
}

func hasArray(value *jsonwire.Value) bool {
	return value != nil && value.Kind() == jsonwire.Array
}

// viewUsageReport decodes the raw payload into the renderer view. Bodies that
// are not JSON objects render against an empty view, exactly like the TS
// renderer's `?? {}` / `?? []` defaults.
func viewUsageReport(body *jsonwire.Value) usageReportView {
	view := usageReportView{}
	if body == nil || body.Kind() != jsonwire.Object {
		return view
	}
	view.rangeValue, view.rangeOK = stringField(body, "range")
	view.surface, view.surfaceOK = stringField(body, "surface")
	if filter := body.Find("filter"); filter != nil && filter.Kind() == jsonwire.Object {
		view.filterPresent = true
		view.filterProvider, view.filterProviderOK = stringField(filter, "provider")
		view.filterModel, view.filterModelOK = stringField(filter, "model")
		if matched := filter.Find("matched"); matched != nil && matched.Kind() == jsonwire.Bool {
			view.filterMatched = matched.Bool()
		}
		if overlap := filter.Find("comboOverlap"); overlap != nil && overlap.Kind() == jsonwire.Bool {
			view.comboOverlap = overlap.Bool()
		}
	}
	summary := body.Find("summary")
	view.requests, view.requestsOK = numberField(summary, "requests")
	view.totalTokens, view.tokensOK = numberField(summary, "totalTokens")
	view.inputTokens, view.inputOK = numberField(summary, "inputTokens")
	view.outputTokens, view.outputOK = numberField(summary, "outputTokens")
	view.cachedTokens, view.cachedOK = numberField(summary, "cachedInputTokens")
	view.estimatedCost, view.costOK = numberField(summary, "estimatedCostUsd")
	view.unpriced, view.unpricedOK = numberField(summary, "unpricedRequests")
	view.unmetered, view.unmeteredOK = numberField(summary, "unmeteredRequests")
	view.providers = rowsFromArray(body.Find("providers"))
	view.models = rowsFromArray(body.Find("models"))
	view.accounts = rowsFromArray(body.Find("accounts"))
	return view
}

func describeUsageScope(view usageReportView) string {
	rangeText := "?"
	if view.rangeOK {
		rangeText = view.rangeValue
	}
	parts := []string{"Usage — " + rangeText}
	if view.surfaceOK && view.surface != "all" {
		parts = append(parts, "surface="+view.surface)
	}
	if view.filterProviderOK && view.filterProvider != "" {
		parts = append(parts, "provider="+view.filterProvider)
	}
	if view.filterModelOK && view.filterModel != "" {
		parts = append(parts, "model="+view.filterModel)
	}
	return usageTerminalText(strings.Join(parts, ", "))
}

func formatUsageReportLines(view usageReportView) []string {
	lines := []string{describeUsageScope(view), ""}

	if view.filterPresent && !view.filterMatched {
		var whatParts []string
		if view.filterProviderOK && view.filterProvider != "" {
			whatParts = append(whatParts, fmt.Sprintf("provider %q", view.filterProvider))
		}
		if view.filterModelOK && view.filterModel != "" {
			whatParts = append(whatParts, fmt.Sprintf("model %q", view.filterModel))
		}
		what := strings.Join(whatParts, " and ")
		lines = append(lines, "No usage recorded for "+usageTerminalText(what)+" in this range.")
		lines = append(lines, "Check the spelling against `ocx usage --json`, or widen --range.")
		return lines
	}

	var splitParts []string
	if view.inputOK {
		splitParts = append(splitParts, "in "+usageCount(view.inputTokens, true))
	}
	if view.outputOK {
		splitParts = append(splitParts, "out "+usageCount(view.outputTokens, true))
	}
	if view.cachedOK && view.cachedTokens != 0 {
		splitParts = append(splitParts, "cached "+usageCount(view.cachedTokens, true))
	}
	tokenSplit := strings.Join(splitParts, " / ")

	lines = append(lines, "Requests   "+usageCount(view.requests, view.requestsOK))
	tokensLine := "Tokens     " + usageCount(view.totalTokens, view.tokensOK)
	if tokenSplit != "" {
		tokensLine += "  (" + tokenSplit + ")"
	}
	lines = append(lines, tokensLine)
	lines = append(lines, "Est. cost  "+usageUSD(view.estimatedCost, view.costOK)+"    API list-price equivalent (this range)")

	unpriced := 0.0
	if view.unpricedOK {
		unpriced = view.unpriced
	}
	unmetered := 0.0
	if view.unmeteredOK {
		unmetered = view.unmetered
	}
	if unpriced > 0 || unmetered > 0 {
		lines = append(lines, "           "+usageCount(unpriced, true)+" unpriced, "+usageCount(unmetered, true)+" unmetered excluded from ~$")
	}

	providers := make([]usageCostRow, 0, len(view.providers))
	for _, row := range view.providers {
		if row.requests > 0 {
			providers = append(providers, row)
		}
	}
	if len(providers) > 0 {
		lines = append(lines, "")
		rows := make([][]string, 0, len(providers))
		for _, row := range providers {
			rows = append(rows, []string{
				row.provider,
				usageCount(row.requests, row.requestsOK),
				usageCount(row.totalTokens, row.tokensOK),
				usageUSD(row.estimatedCost, row.costOK),
			})
		}
		lines = append(lines, usageTable([]string{"PROVIDER", "REQUESTS", "TOKENS", "EST. COST"}, rows)...)
	}

	accountFilterActive := (view.filterProviderOK && view.filterProvider != "") || (view.filterModelOK && view.filterModel != "")
	accounts := make([]usageCostRow, 0, len(view.accounts))
	for _, row := range view.accounts {
		if row.requests > 0 {
			accounts = append(accounts, row)
		}
	}
	if accountFilterActive {
		lines = append(lines, "")
		lines = append(lines, "ACCOUNT: not reported under a provider or model filter; run without filters for per-account totals.")
	} else if len(accounts) > 0 {
		lines = append(lines, "")
		rows := make([][]string, 0, len(accounts))
		for _, row := range accounts {
			label := usageTerminalText(row.accountLogLabel)
			if row.ambiguous {
				label += " (ambiguous)"
			}
			rows = append(rows, []string{
				label,
				usageCount(row.requests, row.requestsOK),
				usageCount(row.totalTokens, row.tokensOK),
				usageUSD(row.estimatedCost, row.costOK),
			})
		}
		lines = append(lines, usageTable([]string{"ACCOUNT", "REQUESTS", "TOKENS", "EST. COST"}, rows)...)
	}

	models := make([]usageCostRow, 0, len(view.models))
	for _, row := range view.models {
		if row.requests > 0 {
			models = append(models, row)
		}
	}
	if len(models) > 0 {
		lines = append(lines, "")
		shown := models
		if len(shown) > usageMaxModelRows {
			shown = shown[:usageMaxModelRows]
		}
		rows := make([][]string, 0, len(shown))
		for _, row := range shown {
			model := "-"
			if row.modelOK {
				model = row.model
			}
			rows = append(rows, []string{
				model,
				row.provider,
				usageCount(row.requests, row.requestsOK),
				usageCount(row.totalTokens, row.tokensOK),
				usageUSD(row.estimatedCost, row.costOK),
			})
		}
		lines = append(lines, usageTable([]string{"MODEL", "PROVIDER", "REQUESTS", "TOKENS", "EST. COST"}, rows)...)
		if len(models) > len(shown) {
			lines = append(lines, fmt.Sprintf("... %d more (use --json)", len(models)-len(shown)))
		}
	}

	if view.comboOverlap {
		lines = append(lines, "")
		lines = append(lines, "Some requests ran as combos, so per-model request counts can overlap. Cost does not.")
	}

	lines = append(lines, "")
	lines = append(lines, "Not a billing receipt. Subscription usage or provider credits may apply instead.")
	return lines
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON output — JSON.stringify(value, null, 2) over the raw payload.

// writeUsageJSON re-emits the raw payload exactly like the TS printData path:
// the server bytes are parsed and re-stringified with two-space indent, V8
// escaping and number rules (jsonwire), then a trailing newline (console.log).
func writeUsageJSON(w io.Writer, body *jsonwire.Value, rawText string) error {
	if body == nil {
		if rawText == "" {
			// Empty 2xx body: the TS runtime parses only non-empty text, so the
			// body stays JS null and JSON.stringify(null) prints `null` — not the
			// quoted empty string a non-JSON body would print.
			_, err := fmt.Fprintln(w, "null")
			return err
		}
		// Non-JSON body: JSON.stringify(text) is a quoted string.
		quoted, err := jsonwire.EncodeString(rawText)
		if err != nil {
			return err
		}
		_, err = fmt.Fprintf(w, "%s\n", quoted)
		return err
	}
	var out strings.Builder
	if err := encodeIndentedJSON(&out, body, 0); err != nil {
		return err
	}
	_, err := fmt.Fprintf(w, "%s\n", out.String())
	return err
}

// encodeIndentedJSON renders a jsonwire value with JSON.stringify(v, null, 2)
// whitespace: two-space indent, `"key": ` members, `[]`/`{}` for empties.
func encodeIndentedJSON(out *strings.Builder, value *jsonwire.Value, depth int) error {
	switch value.Kind() {
	case jsonwire.Array:
		elements := value.Elements()
		if len(elements) == 0 {
			out.WriteString("[]")
			return nil
		}
		out.WriteString("[\n")
		for i, element := range elements {
			writeIndent(out, depth+1)
			if err := encodeIndentedJSON(out, element, depth+1); err != nil {
				return err
			}
			if i < len(elements)-1 {
				out.WriteByte(',')
			}
			out.WriteByte('\n')
		}
		writeIndent(out, depth)
		out.WriteByte(']')
	case jsonwire.Object:
		members := value.Members()
		if len(members) == 0 {
			out.WriteString("{}")
			return nil
		}
		out.WriteString("{\n")
		for i, member := range members {
			writeIndent(out, depth+1)
			quoted, err := jsonwire.EncodeString(member.Key)
			if err != nil {
				return err
			}
			out.Write(quoted)
			out.WriteString(": ")
			if err := encodeIndentedJSON(out, member.Value, depth+1); err != nil {
				return err
			}
			if i < len(members)-1 {
				out.WriteByte(',')
			}
			out.WriteByte('\n')
		}
		writeIndent(out, depth)
		out.WriteByte('}')
	case jsonwire.String:
		quoted, err := jsonwire.EncodeString(value.String())
		if err != nil {
			return err
		}
		out.Write(quoted)
	case jsonwire.Number:
		out.WriteString(value.NumberRaw())
	case jsonwire.Bool:
		if value.Bool() {
			out.WriteString("true")
		} else {
			out.WriteString("false")
		}
	default:
		out.WriteString("null")
	}
	return nil
}

func writeIndent(out *strings.Builder, depth int) {
	for i := 0; i < depth; i++ {
		out.WriteString("  ")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Command entry — port of observe.ts usage().

// runUsage implements `ocx usage` (and `ocx observe usage`). It assumes the
// caller validated ownership; argv carries only this command's own arguments.
func runUsage(args []string, deps Deps) int {
	rest := append([]string(nil), args...)
	jsonOutput := takeUsageFlag(&rest, "--json")
	rangeValue, rangeGiven, err := takeUsageOption(&rest, "--range")
	if err != nil {
		// takeOption throws its CliUsageError without the USAGE block; only the
		// range/surface validation and rejectArgs carry it.
		return usageFailureNoUsage(deps, err)
	}
	if !rangeGiven {
		rangeValue = "30d"
	}
	surfaceValue, surfaceGiven, err := takeUsageOption(&rest, "--surface")
	if err != nil {
		return usageFailureNoUsage(deps, err)
	}
	if !surfaceGiven {
		surfaceValue = "all"
	}
	providerValue, _, err := takeUsageOption(&rest, "--provider")
	if err != nil {
		return usageFailureNoUsage(deps, err)
	}
	modelValue, _, err := takeUsageOption(&rest, "--model")
	if err != nil {
		return usageFailureNoUsage(deps, err)
	}
	// `1d` is accepted here as well as server-side so the CLI does not reject an
	// alias the API would have understood.
	allowedRanges := append([]string(nil), usageRanges...)
	allowedRanges = append(allowedRanges, "1d")
	if !containsString(allowedRanges, rangeValue) {
		return usageFailure(deps, errors.New("--range must be one of "+strings.Join(usageRanges, ", ")+" (1d aliases today)"))
	}
	if !containsString(usageSurfaces, surfaceValue) {
		return usageFailure(deps, errors.New("--surface must be one of "+strings.Join(usageSurfaces, ", ")))
	}
	if len(rest) > 0 {
		return usageFailure(deps, usageUnexpectedArgs(rest))
	}

	var providerParam, modelParam *string
	if providerValue != "" {
		provider := providerValue
		providerParam = &provider
	}
	if modelValue != "" {
		model := modelValue
		modelParam = &model
	}
	queryString := usageQuery(&rangeValue, &surfaceValue, providerParam, modelParam)

	body, rawText, status, fetchErr := fetchUsageReport(deps, queryString)
	if fetchErr != nil {
		apiErr := usageAPIError{message: fetchErr.Error(), status: status}
		return reportUsageAPIError(deps, apiErr)
	}
	if status < 200 || status >= 300 {
		return reportUsageAPIError(deps, usageAPIError{
			message: usageResponseMessage(body, rawText, status),
			status:  status,
		})
	}

	if jsonOutput {
		if err := writeUsageJSON(deps.Stdout, body, rawText); err != nil {
			fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
			return 1
		}
		return 0
	}
	lines := formatUsageReportLines(viewUsageReport(body))
	for _, line := range lines {
		fmt.Fprintln(deps.Stdout, line)
	}
	return 0
}

// usageAPIError mirrors RuntimeApiError's observable shape: a message and an
// HTTP status that selects the exit code.
type usageAPIError struct {
	message string
	status  int
}

func reportUsageAPIError(deps Deps, apiErr usageAPIError) int {
	fmt.Fprintln(deps.Stderr, "Error: "+apiErr.message)
	switch apiErr.status {
	case 404:
		return usageExitMissing
	case 409:
		return usageExitConflict
	default:
		return 1
	}
}

// usageFailure mirrors a CliUsageError carrying the USAGE block reaching
// runCliAction: message plus the observe USAGE block on stderr, exit 2.
func usageFailure(deps Deps, err error) int {
	fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
	fmt.Fprintln(deps.Stderr, observeUsageUsage)
	return usageExitUsage
}

// usageFailureNoUsage mirrors a CliUsageError constructed without a USAGE
// block (takeOption's `--flag requires a value`): only the Error line prints.
func usageFailureNoUsage(deps Deps, err error) int {
	fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
	return usageExitUsage
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
