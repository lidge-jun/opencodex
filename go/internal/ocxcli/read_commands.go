package ocxcli

// `ocx logs`, `ocx memory`, and `ocx inspect` — the top-level management-read
// aliases flipped to Go ownership (issue #45). This file ports the TypeScript
// owner (src/cli/observe.ts logs/simple/explain + src/cli/inspect.ts) on top
// of the same management API and the runtime-api error taxonomy the usage
// command already shares; the differential harness diffs TS CLI output against
// this implementation for the same argv and mocked API payload.
//
// Exit codes mirror runCliAction (runtime-api.ts):
//   - usage errors: exit 2, "Error: <msg>" + the command's USAGE block on stderr
//   - RuntimeApiError: exit 4 on 404, 5 on 409, otherwise 1

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// inspectUsage mirrors inspect.ts's USAGE constant verbatim. logs/memory share
// observeUsageUsage (observe.ts's USAGE constant).
const inspectUsage = `Usage:
  ocx inspect config [--json]
  ocx inspect catalog [--json]
  ocx inspect routing-analytics [--json]
  ocx inspect pacing [--name <provider>] [--json]
  ocx inspect key-providers [--json]
  ocx inspect codex-prompt [--text] [--json]
  ocx inspect client-config --client <id> [--json]
  ocx inspect star [--json]
  ocx inspect windows-tray [--json]
  ocx integration native [list] [--json]
  ocx integration native <claude|claude-desktop|codex|grok> <on|off> [--json]
  ocx agent request-user-input [on|off] [--json]`

// Exit codes from the runCliAction taxonomy, named for this command file.
const (
	readExitUsage    = 2 // CliUsageError
	readExitNotFound = 4 // RuntimeApiError status 404
	readExitConflict = 5 // RuntimeApiError status 409
)

type readAPIError struct {
	message string
	status  int
}

// reportReadAPIError mirrors the RuntimeApiError branch of runCliAction.
func reportReadAPIError(deps Deps, apiErr readAPIError) int {
	fmt.Fprintln(deps.Stderr, "Error: "+apiErr.message)
	switch apiErr.status {
	case 404:
		return readExitNotFound
	case 409:
		return readExitConflict
	default:
		return 1
	}
}

// reportReadUsageError mirrors a CliUsageError reaching runCliAction: the
// Error line always prints; the USAGE block prints only when the caller passed
// one (takeOption's `--flag requires a value` errors carry none).
func reportReadUsageError(deps Deps, message, usageBlock string) int {
	fmt.Fprintln(deps.Stderr, "Error: "+message)
	if usageBlock != "" {
		fmt.Fprintln(deps.Stderr, usageBlock)
	}
	return readExitUsage
}

// secretOptions mirrors runtime-api.ts's SECRET_OPTIONS: options whose VALUE is
// a credential (or can carry one), so a parse error must never echo it back.
var secretOptions = map[string]bool{
	"--code": true, "--headers": true, "--token": true, "--admin-token": true,
	"--pairing-code": true, "--credential-env": true, "--admin-token-env": true,
	"--pairing-code-env": true,
}

// readRedactArgs mirrors redactSecretArgs(args, false): replace credential
// values before they are reported by rejectArgs.
func readRedactArgs(args []string) []string {
	out := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		arg := args[index]
		inline := ""
		for option := range secretOptions {
			if strings.HasPrefix(arg, option+"=") {
				inline = option
				break
			}
		}
		if inline != "" {
			out = append(out, inline+"=<redacted>")
			continue
		}
		if secretOptions[arg] {
			out = append(out, arg)
			valueIndex := index + 1
			if valueIndex < len(args) && args[valueIndex] == "--" {
				out = append(out, "--")
				valueIndex++
			}
			if valueIndex < len(args) {
				out = append(out, "<redacted>")
				index = valueIndex
			}
			continue
		}
		out = append(out, arg)
	}
	return out
}

// readUnexpectedArgs mirrors rejectArgs: "Unexpected argument(s): <joined>".
func readUnexpectedArgs(args []string) string {
	return "Unexpected argument(s): " + strings.Join(readRedactArgs(args), " ")
}

// takeReadIntegerOption mirrors takeIntegerOption with a minimum: `--flag
// value`, `--flag=value` not understood (falls through to rejectArgs), and a
// missing/NaN/non-integer/sub-minimum value rejected with the exact message.
func takeReadIntegerOption(args *[]string, flag string, min int) (int, bool, error) {
	raw, found, err := takeUsageOption(args, flag)
	if err != nil {
		return 0, false, err
	}
	if !found {
		return 0, false, nil
	}
	cleaned := strings.ReplaceAll(raw, ",", "")
	cleaned = strings.ReplaceAll(cleaned, "_", "")
	value, parseErr := strconv.ParseFloat(cleaned, 64)
	if parseErr != nil || value != float64(int64(value)) || value < float64(min) {
		return 0, false, fmt.Errorf("%s must be an integer >= %d", flag, min)
	}
	return int(value), true, nil
}

// readQueryEscape mirrors encodeURIComponent (what URLSearchParams.set uses on
// encode), NOT url.QueryEscape (which encodes spaces as '+' and keeps more
// bytes); usageQuery in usage_command.go predates this helper for the same
// observed payloads and keeps url.QueryEscape.
func readQueryEscape(value string) string {
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
		case strings.ContainsRune("-_.!~*'()", r):
			b.WriteRune(r)
		case r <= 0x7f:
			fmt.Fprintf(&b, "%%%02X", r)
		default:
			for _, c := range []byte(string(r)) {
				fmt.Fprintf(&b, "%%%02X", c)
			}
		}
	}
	return b.String()
}

// readLogsQuery builds the /api/logs query exactly like observe.ts's query
// helper: URLSearchParams.set for each provided parameter in declaration order
// (provider, model, status, conversationId, limit — limit defaults to 200 and
// is always sent). A nil entry means "not provided".
func readLogsQuery(provider, model, status, conversationID *string, limit int) string {
	var b strings.Builder
	write := func(key string, value *string) {
		if value == nil {
			return
		}
		if b.Len() == 0 {
			b.WriteByte('?')
		} else {
			b.WriteByte('&')
		}
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(readQueryEscape(*value))
	}
	write("provider", provider)
	write("model", model)
	write("status", status)
	write("conversationId", conversationID)
	limitText := strconv.Itoa(limit)
	write("limit", &limitText)
	return b.String()
}

// fetchRead performs one management GET with the exact error messages of
// runtimeRequest/runtimeBaseUrl. rawText is set only when the body was not
// valid JSON (runtimeRequest keeps the text in that case); a JSON "null" body
// parses to a Null-kind value with rawText empty.
func fetchRead(deps Deps, path string) (body *jsonwire.Value, rawText string, status int, err error) {
	deps = defaults(deps)
	state, found := liveProxyEndpoint(deps)
	if !found {
		return nil, "", 503, errors.New("Proxy is not running. Start it with: ocx start")
	}
	request, requestErr := http.NewRequest(http.MethodGet, baseURL(state)+path, nil)
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

// readReadJSON renders a management response exactly like the TS printData
// --json path: the parsed payload is re-stringified with two-space indent plus
// a trailing newline, and a non-JSON body is a quoted string.
func readReadJSON(deps Deps, body *jsonwire.Value, rawText string) int {
	if err := writeUsageJSON(deps.Stdout, body, rawText); err != nil {
		fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
		return 1
	}
	return 0
}

// ─────────────────────────────────────────────────────────────────────────────
// Human rendering — port of summaryLines in runtime-api.ts (used by memory and
// every inspect read) and formatLog/logRows in observe.ts.

// readSummaryLines mirrors summaryLines(value) over a parsed payload: a
// depth-1 projection where objects/arrays recurse once and anything deeper is
// "[object Object]" / "N item(s)". Returns nil when the payload needs the
// raw-text fallback instead.
func readSummaryLines(body *jsonwire.Value) []string {
	if body == nil {
		return nil
	}
	var lines []string
	readAppendSummary(&lines, body, "", 0)
	return lines
}

// readSummaryLine mirrors the depth > 1 / non-object guard: one
// "<prefix or value>: <String(value)>" line.
func readSummaryLine(value *jsonwire.Value, prefix string) string {
	label := prefix
	if label == "" {
		label = "value"
	}
	return label + ": " + readJSString(value)
}

func readAppendSummary(lines *[]string, value *jsonwire.Value, prefix string, depth int) {
	if value == nil || (value.Kind() != jsonwire.Object && value.Kind() != jsonwire.Array) || depth > 1 {
		*lines = append(*lines, readSummaryLine(value, prefix))
		return
	}
	appendEntry := func(key string, child *jsonwire.Value) {
		label := key
		if prefix != "" {
			label = prefix + "." + key
		}
		if child != nil && child.Kind() == jsonwire.Array {
			*lines = append(*lines, readSummaryArrayLine(label, child))
			return
		}
		if child != nil && (child.Kind() == jsonwire.Object || child.Kind() == jsonwire.Array) && depth < 1 {
			readAppendSummary(lines, child, label, depth+1)
			return
		}
		*lines = append(*lines, readSummaryScalarLine(label, child))
	}
	if value.Kind() == jsonwire.Object {
		for _, member := range value.Members() {
			appendEntry(member.Key, member.Value)
		}
		return
	}
	// Object.entries over an array enumerates the index keys; recurse each
	// element with that prefix (arrays only reach here as the summary root).
	for index, element := range value.Elements() {
		appendEntry(strconv.Itoa(index), element)
	}
}

func readSummaryArrayLine(label string, array *jsonwire.Value) string {
	elements := array.Elements()
	scalar := true
	for _, element := range elements {
		switch element.Kind() {
		case jsonwire.String, jsonwire.Number, jsonwire.Bool, jsonwire.Null:
		default:
			scalar = false
		}
	}
	if scalar {
		parts := make([]string, 0, len(elements))
		for _, element := range elements {
			parts = append(parts, readJSString(element))
		}
		joined := strings.Join(parts, ", ")
		if joined == "" {
			joined = "none"
		}
		return label + ": " + joined
	}
	return fmt.Sprintf("%s: %d item(s)", label, len(elements))
}

func readSummaryScalarLine(label string, child *jsonwire.Value) string {
	if child == nil || child.Kind() == jsonwire.Null || (child.Kind() == jsonwire.String && child.String() == "") {
		return label + ": -"
	}
	return label + ": " + readJSString(child)
}

// readJSString mirrors String(value) for the jsonwire kinds these projections
// render: V8 number formatting, "[object Object]" for a nested object.
func readJSString(value *jsonwire.Value) string {
	switch value.Kind() {
	case jsonwire.String:
		return value.String()
	case jsonwire.Number:
		number, err := strconv.ParseFloat(value.NumberRaw(), 64)
		if err != nil {
			return value.NumberRaw()
		}
		return jsonwire.FormatV8Number(number)
	case jsonwire.Bool:
		return strconv.FormatBool(value.Bool())
	case jsonwire.Null:
		return "null"
	default:
		return "[object Object]"
	}
}

// readSummaryTextValue mirrors summaryLines called on a non-JSON body (the TS
// renderer sees the raw response text as a string and prints one "value: …"
// line; an empty body parses to null and prints "value: null").
func readSummaryTextValue(text string) []string {
	if text == "" {
		return []string{"value: null"}
	}
	return []string{"value: " + text}
}

// readPrintHuman prints either the parsed-payload summary lines or the raw-text
// fallback line, one per stdout line (console.log).
func readPrintHuman(deps Deps, body *jsonwire.Value, rawText string) {
	var lines []string
	if body == nil {
		lines = readSummaryTextValue(rawText)
	} else {
		lines = readSummaryLines(body)
	}
	for _, line := range lines {
		fmt.Fprintln(deps.Stdout, line)
	}
}

// readLogRows mirrors logRows: the first array-valued member among
// logs/entries/requests of an object payload, or the payload itself when it is
// an array; anything else is an empty row list.
func readLogRows(body *jsonwire.Value) []*jsonwire.Value {
	if body == nil {
		return nil
	}
	if body.Kind() == jsonwire.Array {
		return body.Elements()
	}
	if body.Kind() == jsonwire.Object {
		for _, key := range []string{"logs", "entries", "requests"} {
			if member := body.Find(key); member != nil && member.Kind() == jsonwire.Array {
				return member.Elements()
			}
		}
	}
	return nil
}

func readLogField(row *jsonwire.Value, key string) *jsonwire.Value {
	if row == nil || row.Kind() != jsonwire.Object {
		return nil
	}
	return row.Find(key)
}

// readNullishField mirrors `row.field ?? undefined` for nullish-coalescing
// chains: absent or JSON-null fields both read as undefined.
func readNullishField(row *jsonwire.Value, key string) *jsonwire.Value {
	value := readLogField(row, key)
	if value == nil || value.Kind() == jsonwire.Null {
		return nil
	}
	return value
}

// readTruthyText mirrors filter(Boolean) over a route component: only
// truthy, non-empty scalar values survive.
func readTruthyText(value *jsonwire.Value) (string, bool) {
	if value == nil || value.Kind() == jsonwire.Null {
		return "", false
	}
	switch value.Kind() {
	case jsonwire.String:
		text := value.String()
		return text, text != ""
	case jsonwire.Bool:
		return strconv.FormatBool(value.Bool()), value.Bool()
	case jsonwire.Number:
		raw := value.NumberRaw()
		return readJSString(value), raw != "0" && raw != "-0"
	default:
		return readJSString(value), true
	}
}

// formatReadLogRow mirrors formatLog in observe.ts: [time, status, route,
// duration, conversation] with empty parts filtered, joined by two spaces.
func formatReadLogRow(row *jsonwire.Value) string {
	timeValue := readNullishField(row, "timestamp")
	if timeValue == nil {
		timeValue = readNullishField(row, "createdAt")
	}
	timeText := ""
	if timeValue != nil {
		timeText = readJSString(timeValue)
	}
	routeParts := []string{}
	if text, ok := readTruthyText(readLogField(row, "provider")); ok {
		routeParts = append(routeParts, text)
	}
	if text, ok := readTruthyText(readLogField(row, "model")); ok {
		routeParts = append(routeParts, text)
	}
	route := strings.Join(routeParts, "/")
	statusValue := readNullishField(row, "status")
	if statusValue == nil {
		statusValue = readNullishField(row, "statusCode")
	}
	status := "?"
	if statusValue != nil {
		status = readJSString(statusValue)
	}
	duration := ""
	if value := readLogField(row, "durationMs"); value != nil {
		// TS: `row.durationMs !== undefined` — null is defined, String(null)="null".
		if value.Kind() == jsonwire.Null {
			duration = "nullms"
		} else {
			duration = readJSString(value) + "ms"
		}
	}
	conversation := ""
	if value := readLogField(row, "conversationId"); value != nil && value.Kind() == jsonwire.String && value.String() != "" {
		conversation = "conv=" + value.String()
	}
	parts := []string{timeText, status, route, duration, conversation}
	kept := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, "  ")
}

// readRowKey mirrors the follow-mode dedupe key in observe.ts logs():
// String(row.id ?? `${row.timestamp}:${row.provider}:${row.model}:${row.status}`).
func readRowKey(row *jsonwire.Value) string {
	if id := readNullishField(row, "id"); id != nil {
		return readJSString(id)
	}
	return readTemplateLiteral(row, "timestamp") + ":" +
		readTemplateLiteral(row, "provider") + ":" +
		readTemplateLiteral(row, "model") + ":" +
		readTemplateLiteral(row, "status")
}

// readTemplateLiteral mirrors `${row.field}`: absent/null fields read as the
// string "undefined".
func readTemplateLiteral(row *jsonwire.Value, key string) string {
	value := readNullishField(row, key)
	if value == nil {
		return "undefined"
	}
	return readJSString(value)
}

// ─────────────────────────────────────────────────────────────────────────────
// Command entry — ports of observe.ts logs()/simple()/explain().

// runLogs implements `ocx logs` (the top-level alias of `ocx observe logs`).
// OwnershipFor routes rebuild-index/index-status to the TypeScript owner, so
// only the read listing and explain can reach this dispatch; a defensive
// delegation mirrors the models family for direct callers.
func runLogs(args []string, deps Deps) int {
	rest := append([]string(nil), args...)
	if len(rest) > 0 && rest[0] == "explain" {
		return runLogsExplain(rest[1:], deps)
	}
	if len(rest) > 0 && (rest[0] == "rebuild-index" || rest[0] == "index-status") {
		return runDelegated(append([]string{"logs"}, rest...), deps)
	}
	jsonOutput := takeUsageFlag(&rest, "--json")
	jsonl := takeUsageFlag(&rest, "--jsonl")
	follow := takeUsageFlag(&rest, "--follow") || takeUsageFlag(&rest, "-f")
	provider, providerGiven, err := takeUsageOption(&rest, "--provider")
	if err != nil {
		return reportReadUsageError(deps, err.Error(), "")
	}
	model, modelGiven, err := takeUsageOption(&rest, "--model")
	if err != nil {
		return reportReadUsageError(deps, err.Error(), "")
	}
	status, statusGiven, err := takeUsageOption(&rest, "--status")
	if err != nil {
		return reportReadUsageError(deps, err.Error(), "")
	}
	conversationID, conversationGiven, err := takeUsageOption(&rest, "--conversation")
	if err != nil {
		return reportReadUsageError(deps, err.Error(), "")
	}
	if !conversationGiven {
		conversationID, conversationGiven, err = takeUsageOption(&rest, "--conversationId")
		if err != nil {
			return reportReadUsageError(deps, err.Error(), "")
		}
	}
	limit := 200
	if value, given, err := takeReadIntegerOption(&rest, "--limit", 1); err != nil {
		return reportReadUsageError(deps, err.Error(), "")
	} else if given {
		limit = value
	}
	if len(rest) > 0 {
		return reportReadUsageError(deps, readUnexpectedArgs(rest), observeUsageUsage)
	}
	if jsonOutput && jsonl {
		return reportReadUsageError(deps, "--json and --jsonl cannot be combined", observeUsageUsage)
	}
	if follow && jsonOutput {
		return reportReadUsageError(deps, "--follow cannot be combined with --json; use --jsonl for streaming JSONL", observeUsageUsage)
	}
	var providerParam, modelParam, statusParam, conversationParam *string
	if providerGiven {
		value := provider
		providerParam = &value
	}
	if modelGiven {
		value := model
		modelParam = &value
	}
	if statusGiven {
		value := status
		statusParam = &value
	}
	if conversationGiven {
		value := conversationID
		conversationParam = &value
	}
	queryString := readLogsQuery(providerParam, modelParam, statusParam, conversationParam, limit)
	seen := map[string]bool{}
	for {
		body, rawText, statusCode, fetchErr := fetchRead(deps, "/api/logs"+queryString)
		if fetchErr != nil {
			return reportReadAPIError(deps, readAPIError{message: fetchErr.Error(), status: statusCode})
		}
		if statusCode < 200 || statusCode >= 300 {
			return reportReadAPIError(deps, readAPIError{message: usageResponseMessage(body, rawText, statusCode), status: statusCode})
		}
		if !follow && jsonOutput {
			return readReadJSON(deps, body, rawText)
		}
		for _, row := range readLogRows(body) {
			if follow {
				key := readRowKey(row)
				if seen[key] {
					continue
				}
				seen[key] = true
			}
			if jsonl {
				encoded, encodeErr := row.Encode()
				if encodeErr != nil {
					fmt.Fprintln(deps.Stderr, "Error: "+encodeErr.Error())
					return 1
				}
				fmt.Fprintln(deps.Stdout, string(encoded))
			} else {
				fmt.Fprintln(deps.Stdout, formatReadLogRow(row))
			}
		}
		if !follow {
			return 0
		}
		if len(seen) > 5000 {
			next := map[string]bool{}
			keys := make([]string, 0, len(seen))
			for key := range seen {
				keys = append(keys, key)
			}
			start := len(keys) - 2500
			if start < 0 {
				start = 0
			}
			for _, key := range keys[start:] {
				next[key] = true
			}
			seen = next
		}
		time.Sleep(1 * time.Second)
	}
}

// runLogsExplain implements `ocx logs explain <request-id>`: it prints the
// whole route-decision payload re-stringified (JSON.stringify(v, null, 2)) in
// both human and --json modes, exactly like printData's default.
func runLogsExplain(args []string, deps Deps) int {
	rest := append([]string(nil), args...)
	requestID := ""
	if len(rest) > 0 {
		requestID, rest = rest[0], rest[1:]
	}
	_ = takeUsageFlag(&rest, "--json")
	if requestID == "" {
		return reportReadUsageError(deps, "request id is required", observeUsageUsage)
	}
	if len(rest) > 0 {
		return reportReadUsageError(deps, readUnexpectedArgs(rest), observeUsageUsage)
	}
	path := "/api/request-history/" + readQueryEscape(requestID) + "/route-decision"
	body, rawText, status, err := fetchRead(deps, path)
	if err != nil {
		return reportReadAPIError(deps, readAPIError{message: err.Error(), status: status})
	}
	if status < 200 || status >= 300 {
		return reportReadAPIError(deps, readAPIError{message: usageResponseMessage(body, rawText, status), status: status})
	}
	return readReadJSON(deps, body, rawText)
}

// runMemory implements `ocx memory` (the top-level alias of `ocx observe
// memory`): the /api/system/memory summary projection, with summaryLines for
// human output and the re-stringified payload for --json.
func runMemory(args []string, deps Deps) int {
	rest := append([]string(nil), args...)
	jsonOutput := takeUsageFlag(&rest, "--json")
	limit, limitGiven, err := takeReadIntegerOption(&rest, "--limit", 1)
	if err != nil {
		return reportReadUsageError(deps, err.Error(), "")
	}
	if len(rest) > 0 {
		return reportReadUsageError(deps, readUnexpectedArgs(rest), observeUsageUsage)
	}
	query := ""
	if limitGiven {
		query = "?limit=" + strconv.Itoa(limit)
	}
	body, rawText, status, err := fetchRead(deps, "/api/system/memory"+query)
	if err != nil {
		return reportReadAPIError(deps, readAPIError{message: err.Error(), status: status})
	}
	if status < 200 || status >= 300 {
		return reportReadAPIError(deps, readAPIError{message: usageResponseMessage(body, rawText, status), status: status})
	}
	if jsonOutput {
		return readReadJSON(deps, body, rawText)
	}
	readPrintHuman(deps, body, rawText)
	return 0
}

// ─────────────────────────────────────────────────────────────────────────────
// `ocx inspect` — port of src/cli/inspect.ts handleInspectCommand.

// runInspect implements `ocx inspect`; the default subcommand is config when
// argv starts with a flag or is empty, exactly like handleInspectCommand.
func runInspect(args []string, deps Deps) int {
	hasSub := len(args) > 0 && !strings.HasPrefix(args[0], "-")
	sub, rest := "config", args
	if hasSub {
		sub, rest = args[0], args[1:]
	}
	switch sub {
	case "config":
		return runReadInspect("/api/config", rest, deps)
	case "catalog":
		return runReadInspect("/api/catalog", rest, deps)
	case "routing-analytics":
		return runReadInspect("/api/routing-analytics", rest, deps)
	case "key-providers":
		return runReadInspect("/api/key-providers", rest, deps)
	case "windows-tray":
		return runReadInspect("/api/windows-tray", rest, deps)
	case "pacing":
		return runInspectPacing(rest, deps)
	case "client-config":
		return runInspectClientConfig(rest, deps)
	case "codex-prompt":
		return runInspectCodexPrompt(rest, deps)
	case "star":
		return runInspectStar(rest, deps)
	default:
		return reportReadUsageError(deps, "unknown inspect command "+sub, inspectUsage)
	}
}

// runReadInspect mirrors inspect.ts's read(): a read that takes no arguments
// beyond --json, rendered with summaryLines for human output.
func runReadInspect(path string, args []string, deps Deps) int {
	rest := append([]string(nil), args...)
	jsonOutput := takeUsageFlag(&rest, "--json")
	if len(rest) > 0 {
		return reportReadUsageError(deps, readUnexpectedArgs(rest), inspectUsage)
	}
	body, rawText, status, err := fetchRead(deps, path)
	if err != nil {
		return reportReadAPIError(deps, readAPIError{message: err.Error(), status: status})
	}
	if status < 200 || status >= 300 {
		return reportReadAPIError(deps, readAPIError{message: usageResponseMessage(body, rawText, status), status: status})
	}
	if jsonOutput {
		return readReadJSON(deps, body, rawText)
	}
	readPrintHuman(deps, body, rawText)
	return 0
}

// runInspectPacing mirrors inspect.ts pacing(): optional --name filter.
func runInspectPacing(args []string, deps Deps) int {
	rest := append([]string(nil), args...)
	jsonOutput := takeUsageFlag(&rest, "--json")
	name, nameGiven, err := takeUsageOption(&rest, "--name")
	if err != nil {
		return reportReadUsageError(deps, err.Error(), "")
	}
	if len(rest) > 0 {
		return reportReadUsageError(deps, readUnexpectedArgs(rest), inspectUsage)
	}
	suffix := ""
	if nameGiven && name != "" {
		suffix = "?name=" + readQueryEscape(name)
	}
	body, rawText, status, err := fetchRead(deps, "/api/provider-request-pacing"+suffix)
	if err != nil {
		return reportReadAPIError(deps, readAPIError{message: err.Error(), status: status})
	}
	if status < 200 || status >= 300 {
		return reportReadAPIError(deps, readAPIError{message: usageResponseMessage(body, rawText, status), status: status})
	}
	if jsonOutput {
		return readReadJSON(deps, body, rawText)
	}
	readPrintHuman(deps, body, rawText)
	return 0
}

// runInspectClientConfig mirrors inspect.ts clientConfig(): --client is
// required and passed as a query parameter.
func runInspectClientConfig(args []string, deps Deps) int {
	rest := append([]string(nil), args...)
	jsonOutput := takeUsageFlag(&rest, "--json")
	client, _, err := takeUsageOption(&rest, "--client")
	if err != nil {
		return reportReadUsageError(deps, err.Error(), "")
	}
	if len(rest) > 0 {
		return reportReadUsageError(deps, readUnexpectedArgs(rest), inspectUsage)
	}
	if client == "" {
		return reportReadUsageError(deps, "--client is required", inspectUsage)
	}
	body, rawText, status, err := fetchRead(deps, "/api/client-config?client="+readQueryEscape(client))
	if err != nil {
		return reportReadAPIError(deps, readAPIError{message: err.Error(), status: status})
	}
	if status < 200 || status >= 300 {
		return reportReadAPIError(deps, readAPIError{message: usageResponseMessage(body, rawText, status), status: status})
	}
	if jsonOutput {
		return readReadJSON(deps, body, rawText)
	}
	readPrintHuman(deps, body, rawText)
	return 0
}

// runInspectCodexPrompt mirrors inspect.ts codexPrompt(): the report with
// summaryLines, or the prompt body printed verbatim under --text (the /text
// variant answers the prompt itself, so it is never flattened).
func runInspectCodexPrompt(args []string, deps Deps) int {
	rest := append([]string(nil), args...)
	jsonOutput := takeUsageFlag(&rest, "--json")
	asText := takeUsageFlag(&rest, "--text")
	if len(rest) > 0 {
		return reportReadUsageError(deps, readUnexpectedArgs(rest), inspectUsage)
	}
	if asText && jsonOutput {
		return reportReadUsageError(deps, "--text and --json cannot be combined", inspectUsage)
	}
	if asText {
		body, rawText, status, err := fetchRead(deps, "/api/codex-prompt/text")
		if err != nil {
			return reportReadAPIError(deps, readAPIError{message: err.Error(), status: status})
		}
		if status < 200 || status >= 300 {
			return reportReadAPIError(deps, readAPIError{message: usageResponseMessage(body, rawText, status), status: status})
		}
		// console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2)).
		if body != nil && body.Kind() == jsonwire.String {
			fmt.Fprintln(deps.Stdout, body.String())
			return 0
		}
		if body == nil && rawText != "" {
			fmt.Fprintln(deps.Stdout, rawText)
			return 0
		}
		return readReadJSON(deps, body, rawText)
	}
	body, rawText, status, err := fetchRead(deps, "/api/codex-prompt")
	if err != nil {
		return reportReadAPIError(deps, readAPIError{message: err.Error(), status: status})
	}
	if status < 200 || status >= 300 {
		return reportReadAPIError(deps, readAPIError{message: usageResponseMessage(body, rawText, status), status: status})
	}
	if jsonOutput {
		return readReadJSON(deps, body, rawText)
	}
	readPrintHuman(deps, body, rawText)
	return 0
}

// runInspectStar mirrors inspect.ts star(): the repository star status read,
// with the read-only consent note appended in human mode only.
func runInspectStar(args []string, deps Deps) int {
	rest := append([]string(nil), args...)
	jsonOutput := takeUsageFlag(&rest, "--json")
	if len(rest) > 0 {
		return reportReadUsageError(deps, readUnexpectedArgs(rest), inspectUsage)
	}
	body, rawText, status, err := fetchRead(deps, "/api/github/star")
	if err != nil {
		return reportReadAPIError(deps, readAPIError{message: err.Error(), status: status})
	}
	if status < 200 || status >= 300 {
		return reportReadAPIError(deps, readAPIError{message: usageResponseMessage(body, rawText, status), status: status})
	}
	if jsonOutput {
		return readReadJSON(deps, body, rawText)
	}
	readPrintHuman(deps, body, rawText)
	fmt.Fprintln(deps.Stdout, "Starring is not available from the CLI: it uses your GitHub identity, so only you can do it from the dashboard.")
	return 0
}
