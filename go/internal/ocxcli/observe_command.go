package ocxcli

import (
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// ocx observe — the runtime-observation family (logs, storage, memory, debug,
// claude-inbound, injection) plus the already-flipped usage subcommand. This
// file ports the TypeScript owner (src/cli/observe.ts + the runtime-api shared
// taxonomy) so `ocx observe <sub>` dispatches natively in the Go binary.
//
// `ocx observe` with no subcommand is `observe logs`, exactly like
// handleObserveCommand's `sub = "logs"` default. Unknown subcommands reproduce
// the TypeScript CliUsageError (exit 2, message + the observe USAGE block).
//
// The request-history indexer actions under `logs` (rebuild-index /
// index-status) read and write the Bun:sqlite-derived index directly with no
// management route, so they stay TypeScript-owned at the action level while the
// rest of the logs surface dispatches natively — the same seam `models live`
// and `codex-shim install` keep.
//
// Exit codes mirror runCliAction: usage errors exit 2 ("Error: <msg>" plus the
// observe USAGE block when the throw carried one); RuntimeApiError exits 4 on
// 404, 5 on 409, otherwise 1.

// runObserve implements `ocx observe [<sub> ...]`. argv is the slice BELOW the
// observe command itself (subcommand first), like handleObserveCommand's argv.
func runObserve(argv []string, deps Deps) int {
	sub := "logs"
	rest := argv
	if len(argv) > 0 {
		sub, rest = argv[0], argv[1:]
	}
	switch sub {
	case "logs":
		return observeLogs(rest, deps)
	case "usage":
		return runUsage(rest, deps)
	case "storage":
		return observeStorage(rest, deps)
	case "memory":
		return observeSimple("/api/system/memory", rest, deps)
	case "debug":
		return observeSimple("/api/debug", rest, deps)
	case "claude-inbound":
		return observeSimple("/api/claude/inbound-debug", rest, deps)
	case "injection":
		return observeSimple("/api/debug/injection-logs", rest, deps)
	default:
		return observeUsageError(deps, errors.New("unknown observe command "+sub), true)
	}
}

// observeUsageError mirrors a CliUsageError reaching runCliAction: message plus
// the observe USAGE block on stderr (when withUsage), exit 2.
func observeUsageError(deps Deps, err error, withUsage bool) int {
	fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
	if withUsage {
		fmt.Fprintln(deps.Stderr, observeUsageUsage)
	}
	return usageExitUsage
}

// observeRejectArgs mirrors rejectArgs without redaction (observe filters carry
// no secret options). ok is false when leftovers remain.
func observeRejectArgs(deps Deps, rest []string) (ok bool, code int) {
	if len(rest) == 0 {
		return true, 0
	}
	return false, observeUsageError(deps, errors.New("Unexpected argument(s): "+strings.Join(rest, " ")), true)
}

// takeUsageIntegerOption mirrors takeIntegerOption: the value is
// Number(raw.replace(/[_,]/g, "")) and must be an integer >= min.
func takeUsageIntegerOption(args *[]string, flag string, min int) (int, bool, error) {
	raw, given, err := takeUsageOption(args, flag)
	if err != nil || !given {
		return 0, given, err
	}
	value := jsNumber(raw)
	if value != math.Trunc(value) || math.IsInf(value, 0) || math.IsNaN(value) || value < float64(min) {
		return 0, true, errors.New(flag + " must be an integer >= " + strconv.Itoa(min))
	}
	if value >= math.MaxInt64 {
		return math.MaxInt64, true, nil
	}
	if value <= math.MinInt64 {
		return math.MinInt64, true, nil
	}
	return int(value), true, nil
}

// jsNumber mirrors Number(raw) for the domain takeIntegerOption feeds it:
// commas/underscores stripped, surrounding whitespace tolerated, hex prefixes
// accepted, empty input is 0, trailing garbage is NaN.
func jsNumber(raw string) float64 {
	cleaned := strings.ReplaceAll(strings.ReplaceAll(raw, ",", ""), "_", "")
	trimmed := strings.TrimSpace(cleaned)
	if trimmed == "" {
		return 0
	}
	if strings.HasPrefix(trimmed, "0x") || strings.HasPrefix(trimmed, "0X") {
		if parsed, err := strconv.ParseInt(trimmed[2:], 16, 64); err == nil {
			return float64(parsed)
		}
		return math.NaN()
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return math.NaN()
	}
	return parsed
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared management fetch — port of runtimeRequest in runtime-api.ts (same
// shape as fetchUsageReport in usage_command.go, parameterized for method and
// body so the codex-logs actions can POST).

// fetchManagementJSON performs one management request through liveProxyEndpoint
// with the runtime admin-token header, exactly like runtimeRequest. On success
// the parsed body is returned (nil + rawText when the body is not valid JSON —
// runtimeRequest keeps the text in that case). Non-2xx responses are returned
// with their status; transport failures return the exact RuntimeApiError
// messages and a 503 status.
func fetchManagementJSON(deps Deps, method, path string, body []byte) (*jsonwire.Value, string, int, error) {
	deps = defaults(deps)
	state, found := liveProxyEndpoint(deps)
	if !found {
		return nil, "", 503, errors.New("Proxy is not running. Start it with: ocx start")
	}
	request, requestErr := http.NewRequest(method, baseURL(state)+path, strings.NewReader(string(body)))
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

// observeReportAPIError reports a RuntimeApiError the way runCliAction does:
// message on stderr, exit 4 on 404, 5 on 409, otherwise 1.
func observeReportAPIError(deps Deps, message string, status int) int {
	fmt.Fprintln(deps.Stderr, "Error: "+message)
	switch status {
	case 404:
		return usageExitMissing
	case 409:
		return usageExitConflict
	default:
		return 1
	}
}

// observeURLQuery mirrors the observe.ts query() helper: URLSearchParams.set for
// every provided param in declaration order (url.Values would sort keys).
func observeURLQuery(params []observeQueryParam) string {
	var b strings.Builder
	for _, param := range params {
		if !param.present {
			continue
		}
		if b.Len() == 0 {
			b.WriteByte('?')
		} else {
			b.WriteByte('&')
		}
		b.WriteString(url.QueryEscape(param.key))
		b.WriteByte('=')
		b.WriteString(url.QueryEscape(param.value))
	}
	return b.String()
}

type observeQueryParam struct {
	key     string
	present bool
	value   string
}

// observePrintPayload emits `--json` output: the server payload re-encoded with
// JSON.stringify(value, null, 2) (V8 rules) plus one newline, or a quoted
// string when the body was not JSON.
func observePrintPayload(deps Deps, body *jsonwire.Value, rawText string) error {
	return writeUsageJSON(deps.Stdout, body, rawText)
}

// ─────────────────────────────────────────────────────────────────────────────
// Human summary rendering — port of summaryLines in runtime-api.ts.

// observeStringify mirrors String(value) for JSON payload values: V8 number
// spelling, container spellings for objects/arrays, the literal text for
// strings. An ABSENT jsonwire member reads as nil and stringifies to
// "undefined" exactly like an undefined property in TypeScript.
func observeStringify(value *jsonwire.Value) string {
	if value == nil {
		return "undefined"
	}
	switch value.Kind() {
	case jsonwire.Null:
		return "null"
	case jsonwire.Bool:
		if value.Bool() {
			return "true"
		}
		return "false"
	case jsonwire.Number:
		return value.NumberRaw()
	case jsonwire.String:
		return value.String()
	case jsonwire.Array:
		elements := value.Elements()
		parts := make([]string, 0, len(elements))
		for _, element := range elements {
			if element == nil || element.Kind() == jsonwire.Null {
				parts = append(parts, "")
			} else {
				parts = append(parts, observeStringify(element))
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// observeSummaryLines mirrors summaryLines: compact human view for safe
// management DTOs. Depth caps at two object levels; arrays of scalars join
// with ", " ("none" when empty); deeper values stringify like String(value).
func observeSummaryLines(value *jsonwire.Value) []string {
	return observeSummaryLinesAt(value, "", 0)
}

// observeSummaryLinesAt mirrors summaryLines(value, prefix, depth): the depth>1
// early exit stringifies the WHOLE value with String() (arrays join with ",");
// object entries iterate in document order; a root array iterates its index
// keys exactly like Object.entries([...]).
func observeSummaryLinesAt(value *jsonwire.Value, prefix string, depth int) []string {
	if value == nil || depth > 1 || (value.Kind() != jsonwire.Object && value.Kind() != jsonwire.Array) {
		return []string{observeSummaryLabel(prefix) + ": " + observeStringify(value)}
	}
	lines := []string{}
	if value.Kind() == jsonwire.Array {
		for index, element := range value.Elements() {
			lines = append(lines, observeSummaryMember(strconv.Itoa(index), element, prefix, depth)...)
		}
		return lines
	}
	for _, member := range value.Members() {
		lines = append(lines, observeSummaryMember(member.Key, member.Value, prefix, depth)...)
	}
	return lines
}

// observeSummaryMember renders one Object.entries row the way summaryLines
// does: arrays of scalars join with ", " ("none" when empty), object children
// recurse one level, null/undefined/"" leaves become "-".
func observeSummaryMember(key string, child *jsonwire.Value, prefix string, depth int) []string {
	label := key
	if prefix != "" {
		label = prefix + "." + key
	}
	if child != nil && child.Kind() == jsonwire.Array {
		elements := child.Elements()
		allScalars := true
		for _, element := range elements {
			if !observeIsScalar(element) {
				allScalars = false
				break
			}
		}
		if allScalars {
			joined := observeArrayJoin(elements)
			if joined == "" {
				joined = "none"
			}
			return []string{label + ": " + joined}
		}
		return []string{label + ": " + strconv.Itoa(len(elements)) + " item(s)"}
	}
	if child != nil && child.Kind() == jsonwire.Object {
		if depth < 1 {
			return observeSummaryLinesAt(child, label, depth+1)
		}
		return []string{label + ": " + observeStringify(child)}
	}
	scalar := observeStringify(child)
	if child == nil || child.Kind() == jsonwire.Null || (child.Kind() == jsonwire.String && child.String() == "") {
		scalar = "-"
	}
	return []string{label + ": " + scalar}
}

func observeSummaryLabel(prefix string) string {
	if prefix == "" {
		return "value"
	}
	return prefix
}

func observeIsScalar(value *jsonwire.Value) bool {
	if value == nil {
		return true // JSON null is a scalar member of the TS scalar set
	}
	switch value.Kind() {
	case jsonwire.String, jsonwire.Number, jsonwire.Bool, jsonwire.Null:
		return true
	}
	return false
}

// observeArrayJoin mirrors Array.prototype.join(", "): null/undefined elements
// become empty strings, everything else String(element).
func observeArrayJoin(elements []*jsonwire.Value) string {
	parts := make([]string, 0, len(elements))
	for _, element := range elements {
		if element == nil || element.Kind() == jsonwire.Null {
			parts = append(parts, "")
			continue
		}
		parts = append(parts, observeStringify(element))
	}
	return strings.Join(parts, ", ")
}

// ─────────────────────────────────────────────────────────────────────────────
// Logs — port of logs()/logRows()/formatLog() in observe.ts.

// observeLogField reads one member of a log row object, nil when absent.
type observeLogRow struct {
	id, timestamp, createdAt, provider, model, status, statusCode, durationMs *jsonwire.Value
}

func decodeLogRow(row *jsonwire.Value) observeLogRow {
	var view observeLogRow
	if row == nil || row.Kind() != jsonwire.Object {
		return view
	}
	view.id = row.Find("id")
	view.timestamp = row.Find("timestamp")
	view.createdAt = row.Find("createdAt")
	view.provider = row.Find("provider")
	view.model = row.Find("model")
	view.status = row.Find("status")
	view.statusCode = row.Find("statusCode")
	view.durationMs = row.Find("durationMs")
	return view
}

// observeFalsy mirrors Boolean(value): absent members, JSON null, empty
// strings, 0/-0, and false are falsy; everything else is truthy.
func observeFalsy(value *jsonwire.Value) bool {
	if value == nil {
		return true
	}
	switch value.Kind() {
	case jsonwire.Null:
		return true
	case jsonwire.String:
		return value.String() == ""
	case jsonwire.Number:
		raw := value.NumberRaw()
		return raw == "0" || raw == "-0"
	case jsonwire.Bool:
		return !value.Bool()
	}
	return false
}

// observeLogFormat mirrors formatLog: one human log line from a request row.
func observeLogFormat(row *jsonwire.Value) string {
	view := decodeLogRow(row)
	timeValue := ""
	switch {
	case view.timestamp != nil && view.timestamp.Kind() != jsonwire.Null:
		timeValue = observeStringify(view.timestamp)
	case view.createdAt != nil && view.createdAt.Kind() != jsonwire.Null:
		timeValue = observeStringify(view.createdAt)
	}
	// `row.createdAt ?? ""` only when timestamp is absent/null: an explicitly
	// null createdAt also lands here and stringifies to "".
	route := ""
	{
		parts := make([]string, 0, 2)
		for _, part := range []*jsonwire.Value{view.provider, view.model} {
			if observeFalsy(part) {
				continue
			}
			parts = append(parts, observeStringify(part))
		}
		route = strings.Join(parts, "/")
	}
	// `row.status ?? row.statusCode ?? "?"`: nullish coalescing skips only
	// absent/null members — 0 and "" and false are kept and stringified.
	statusValue := "?"
	for _, candidate := range []*jsonwire.Value{view.status, view.statusCode} {
		if candidate == nil || candidate.Kind() == jsonwire.Null {
			continue
		}
		statusValue = observeStringify(candidate)
		break
	}
	duration := ""
	if view.durationMs != nil {
		duration = observeStringify(view.durationMs) + "ms"
	}
	conversation := ""
	if row != nil && row.Kind() == jsonwire.Object {
		if member := row.Find("conversationId"); member != nil && member.Kind() == jsonwire.String && member.String() != "" {
			conversation = "conv=" + member.String()
		}
	}
	parts := make([]string, 0, 5)
	for _, part := range []string{timeValue, statusValue, route, duration, conversation} {
		if part != "" {
			parts = append(parts, part)
		}
	}
	return strings.Join(parts, "  ")
}

// observeLogKey mirrors the follow dedup key in observe.ts logs():
// String(row.id ?? `${timestamp}:${provider}:${model}:${status}`) — absent
// members read "undefined", null members read "null".
func observeLogKey(row *jsonwire.Value) string {
	view := decodeLogRow(row)
	if view.id != nil && view.id.Kind() != jsonwire.Null {
		return observeStringify(view.id)
	}
	parts := make([]string, 0, 4)
	for _, part := range []*jsonwire.Value{view.timestamp, view.provider, view.model, view.status} {
		parts = append(parts, observeStringify(part))
	}
	return strings.Join(parts, ":")
}

// observeLogRows mirrors logRows: the payload's array, or the first array
// under logs/entries/requests.
func observeLogRows(data *jsonwire.Value) []*jsonwire.Value {
	if data == nil {
		return nil
	}
	if data.Kind() == jsonwire.Array {
		return data.Elements()
	}
	if data.Kind() == jsonwire.Object {
		for _, key := range []string{"logs", "entries", "requests"} {
			if record := data.Find(key); record != nil && record.Kind() == jsonwire.Array {
				return record.Elements()
			}
		}
	}
	return nil
}

func observeLogs(argv []string, deps Deps) int {
	rest := append([]string(nil), argv...)
	// `ocx observe logs <action>`: explain reads the management route natively;
	// rebuild-index / index-status touch the Bun:sqlite index with no
	// management route, so OwnershipFor keeps them TypeScript-owned and they
	// delegate before this dispatch ever runs. The branch is defensive for
	// direct (test) callers of runObserve.
	if len(rest) > 0 {
		switch rest[0] {
		case "explain":
			return observeLogsExplain(rest[1:], deps)
		case "rebuild-index", "index-status":
			return runDelegated(append([]string{"observe", "logs"}, rest...), deps)
		}
	}

	wantsJSON := takeUsageFlag(&rest, "--json")
	wantsJSONL := takeUsageFlag(&rest, "--jsonl")
	follow := takeUsageFlag(&rest, "--follow") || takeUsageFlag(&rest, "-f")
	provider, providerGiven, err := takeUsageOption(&rest, "--provider")
	if err != nil {
		return observeUsageError(deps, err, false)
	}
	model, modelGiven, err := takeUsageOption(&rest, "--model")
	if err != nil {
		return observeUsageError(deps, err, false)
	}
	status, statusGiven, err := takeUsageOption(&rest, "--status")
	if err != nil {
		return observeUsageError(deps, err, false)
	}
	// Both spellings, because the server accepts both and an operator should
	// not have to remember which one this surface wanted.
	conversation, conversationGiven, err := takeUsageOption(&rest, "--conversation")
	if err != nil {
		return observeUsageError(deps, err, false)
	}
	if !conversationGiven {
		conversation, conversationGiven, err = takeUsageOption(&rest, "--conversationId")
		if err != nil {
			return observeUsageError(deps, err, false)
		}
	}
	limit := 200
	if limitRaw, limitGiven, err := takeUsageIntegerOption(&rest, "--limit", 1); err != nil {
		return observeUsageError(deps, err, false)
	} else if limitGiven {
		limit = limitRaw
	}
	if ok, code := observeRejectArgs(deps, rest); !ok {
		return code
	}
	if wantsJSON && wantsJSONL {
		return observeUsageError(deps, errors.New("--json and --jsonl cannot be combined"), true)
	}
	if follow && wantsJSON {
		return observeUsageError(deps, errors.New("--follow cannot be combined with --json; use --jsonl for streaming JSONL"), true)
	}

	params := []observeQueryParam{
		{key: "provider", present: providerGiven, value: provider},
		{key: "model", present: modelGiven, value: model},
		{key: "status", present: statusGiven, value: status},
		{key: "conversationId", present: conversationGiven, value: conversation},
		{key: "limit", present: true, value: strconv.Itoa(limit)},
	}
	query := observeURLQuery(params)

	// follow keeps insertion order so the size cap below mirrors
	// `seen = new Set([...seen].slice(-2_500))` (map order would prune the
	// wrong tail and change which rows a long-lived follow re-prints).
	seenOrder := make([]string, 0, 64)
	seen := map[string]bool{}
	for {
		body, rawText, responseStatus, fetchErr := fetchManagementJSON(deps, http.MethodGet, "/api/logs"+query, nil)
		if fetchErr != nil {
			return observeReportAPIError(deps, fetchErr.Error(), responseStatus)
		}
		if responseStatus < 200 || responseStatus >= 300 {
			return observeReportAPIError(deps, usageResponseMessage(body, rawText, responseStatus), responseStatus)
		}
		rows := observeLogRows(body)
		if !follow && wantsJSON {
			if err := observePrintPayload(deps, body, rawText); err != nil {
				fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
				return 1
			}
		} else {
			for _, row := range rows {
				key := observeLogKey(row)
				if follow && seen[key] {
					continue
				}
				if wantsJSONL {
					encoded, err := row.Encode()
					if err != nil {
						fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
						return 1
					}
					fmt.Fprintln(deps.Stdout, string(encoded))
				} else {
					fmt.Fprintln(deps.Stdout, observeLogFormat(row))
				}
				if follow {
					seen[key] = true
					seenOrder = append(seenOrder, key)
				}
			}
		}
		if !follow {
			return 0
		}
		if len(seen) > 5_000 {
			tail := seenOrder[len(seenOrder)-2_500:]
			pruned := make(map[string]bool, len(tail))
			for _, key := range tail {
				pruned[key] = true
			}
			seenOrder = append([]string(nil), tail...)
			seen = pruned
		}
		time.Sleep(1 * time.Second)
	}
}

// observeLogsExplain mirrors explain(): GET the route-decision payload for one
// request id and print the JSON.stringify(result, null, 2) document — both
// --json and human spellings print the same pretty document.
func observeLogsExplain(argv []string, deps Deps) int {
	rest := append([]string(nil), argv...)
	requestID := ""
	if len(rest) > 0 {
		requestID = rest[0]
		rest = rest[1:]
	}
	_ = takeUsageFlag(&rest, "--json")
	if requestID == "" {
		return observeUsageError(deps, errors.New("request id is required"), true)
	}
	if ok, code := observeRejectArgs(deps, rest); !ok {
		return code
	}
	body, rawText, responseStatus, fetchErr := fetchManagementJSON(deps, http.MethodGet, "/api/request-history/"+url.PathEscape(requestID)+"/route-decision", nil)
	if fetchErr != nil {
		return observeReportAPIError(deps, fetchErr.Error(), responseStatus)
	}
	if responseStatus < 200 || responseStatus >= 300 {
		return observeReportAPIError(deps, usageResponseMessage(body, rawText, responseStatus), responseStatus)
	}
	if err := observePrintPayload(deps, body, rawText); err != nil {
		fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
		return 1
	}
	return 0
}

// ─────────────────────────────────────────────────────────────────────────────
// Simple management reads — port of simple() + printData.

// observeSimple implements memory/debug/claude-inbound/injection: one GET with
// an optional --limit, then either the payload as pretty JSON (--json) or the
// compact summaryLines view.
func observeSimple(path string, argv []string, deps Deps) int {
	rest := append([]string(nil), argv...)
	wantsJSON := takeUsageFlag(&rest, "--json")
	var limitParam *observeQueryParam
	if limitRaw, limitGiven, err := takeUsageIntegerOption(&rest, "--limit", 1); err != nil {
		return observeUsageError(deps, err, false)
	} else if limitGiven {
		limitParam = &observeQueryParam{key: "limit", present: true, value: strconv.Itoa(limitRaw)}
	}
	if ok, code := observeRejectArgs(deps, rest); !ok {
		return code
	}
	params := []observeQueryParam{}
	if limitParam != nil {
		params = append(params, *limitParam)
	}
	body, rawText, responseStatus, fetchErr := fetchManagementJSON(deps, http.MethodGet, path+observeURLQuery(params), nil)
	if fetchErr != nil {
		return observeReportAPIError(deps, fetchErr.Error(), responseStatus)
	}
	if responseStatus < 200 || responseStatus >= 300 {
		return observeReportAPIError(deps, usageResponseMessage(body, rawText, responseStatus), responseStatus)
	}
	if wantsJSON {
		if err := observePrintPayload(deps, body, rawText); err != nil {
			fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
			return 1
		}
		return 0
	}
	for _, line := range observeSummaryLines(body) {
		fmt.Fprintln(deps.Stdout, line)
	}
	return 0
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage — port of storage() in observe.ts.

func observeStorage(argv []string, deps Deps) int {
	if len(argv) == 0 || argv[0] != "codex-logs" {
		return observeSimple("/api/storage", argv, deps)
	}
	rest := append([]string(nil), argv[1:]...)
	action := "status"
	if len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
		action = rest[0]
		rest = rest[1:]
	}
	wantsJSON := takeUsageFlag(&rest, "--json")
	mode, modeGiven, err := takeUsageOption(&rest, "--mode")
	if err != nil {
		return observeUsageError(deps, err, false)
	}
	if ok, code := observeRejectArgs(deps, rest); !ok {
		return code
	}

	var body *jsonwire.Value
	var rawText string
	var responseStatus int
	var fetchErr error
	switch action {
	case "status":
		if modeGiven {
			return observeUsageError(deps, errors.New("--mode is only valid with codex-logs protect"), true)
		}
		body, rawText, responseStatus, fetchErr = fetchManagementJSON(deps, http.MethodGet, "/api/storage/codex-logs", nil)
	case "protect":
		requestedMode := "compat"
		if modeGiven {
			requestedMode = mode
		}
		if requestedMode != "compat" && requestedMode != "quiet" {
			return observeUsageError(deps, errors.New("--mode must be compat or quiet"), true)
		}
		payload := jsonwire.ObjectValue()
		payload.Set("mode", jsonwire.StringValue(requestedMode))
		encoded, encodeErr := payload.Encode()
		if encodeErr != nil {
			return observeUsageError(deps, encodeErr, false)
		}
		body, rawText, responseStatus, fetchErr = fetchManagementJSON(deps, http.MethodPost, "/api/storage/codex-logs/protect", encoded)
	case "unprotect", "repair", "compact":
		if modeGiven {
			return observeUsageError(deps, errors.New("--mode is only valid with codex-logs protect"), true)
		}
		body, rawText, responseStatus, fetchErr = fetchManagementJSON(deps, http.MethodPost, "/api/storage/codex-logs/"+action, nil)
	default:
		return observeUsageError(deps, errors.New("unknown codex-logs action "+action), true)
	}
	if fetchErr != nil {
		return observeReportAPIError(deps, fetchErr.Error(), responseStatus)
	}
	if responseStatus < 200 || responseStatus >= 300 {
		return observeReportAPIError(deps, usageResponseMessage(body, rawText, responseStatus), responseStatus)
	}
	if wantsJSON {
		if err := observePrintPayload(deps, body, rawText); err != nil {
			fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
			return 1
		}
		return 0
	}
	for _, line := range observeSummaryLines(body) {
		fmt.Fprintln(deps.Stdout, line)
	}
	return 0
}
