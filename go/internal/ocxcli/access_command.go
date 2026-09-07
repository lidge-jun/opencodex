// ocx access + ocx api-key — the admission-key and endpoint family. This file
// ports the TypeScript owner (src/cli/access.ts, shared by both spellings:
// `api-key` dispatches as `access key`) against the same management endpoints
// (/api/keys, /api/keys/rotate[/commit], /v1/models, /v1/chat/completions,
// /v1/responses, /v1/messages) with byte-identical parsing, rendering, and
// exit-code taxonomy.
package ocxcli

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// accessUsage mirrors ACCESS_USAGE in src/cli/access.ts; the api-key alias
// reuses it verbatim because the TS owner routes `api-key` through
// handleAccessCommand(["key", ...argv]).
const accessUsage = `Usage:
  ocx access key [list] [--json]
  ocx access key create [name] [--json]
  ocx access key rotate <id> [--json]
  ocx access key rotate commit <id> <rotation-id> [--json]
  ocx access key rotate abort <id> <rotation-id> [--json]
  ocx access key remove <id> --yes [--json]
  ocx access endpoints [--json]
  ocx access models [--json]
  ocx access test <model> [--protocol <chat|responses|messages>] [--json]`

// takeMgmtFlag mirrors takeFlag: remove `flag` from args anywhere and report
// whether it was present.
func takeMgmtFlag(args *[]string, flag string) bool {
	for i, arg := range *args {
		if arg == flag {
			*args = append((*args)[:i], (*args)[i+1:]...)
			return true
		}
	}
	return false
}

// takeMgmtOption mirrors takeOption: `--flag value`, rejecting a missing value
// with the exact TypeScript message.
func takeMgmtOption(args *[]string, flag string) (string, bool, error) {
	for i, arg := range *args {
		if arg != flag {
			continue
		}
		if i+1 >= len(*args) || strings.HasPrefix((*args)[i+1], "--") {
			return "", false, managementCliUsage(fmt.Sprintf("%s requires a value", flag), "")
		}
		value := (*args)[i+1]
		*args = append((*args)[:i], (*args)[i+2:]...)
		return value, true, nil
	}
	return "", false, nil
}

// rejectMgmtArgs mirrors rejectArgs: a leftover positional is a usage error
// carrying the command's USAGE block.
func rejectMgmtArgs(args []string, usage string) error {
	if len(args) == 0 {
		return nil
	}
	return managementCliUsage("Unexpected argument(s): "+strings.Join(args, " "), usage)
}

// runAccess implements `ocx access` (and, through runApiKey, `ocx api-key`).
// argv carries only this command's own arguments.
func runAccess(args []string, deps Deps) int {
	err := handleMgmtAccess(args, deps)
	if err != nil {
		return reportManagementFailure(deps, err)
	}
	return ExitOK
}

// runApiKey mirrors the TypeScript dispatch alias: `api-key <args...>` is
// exactly `access key <args...>`.
func runApiKey(args []string, deps Deps) int {
	return runAccess(append([]string{"key"}, args...), deps)
}

func handleMgmtAccess(argv []string, deps Deps) error {
	sub := "key"
	rest := argv
	if len(argv) > 0 {
		sub = argv[0]
		rest = argv[1:]
	}
	switch sub {
	case "key", "keys":
		return mgmtAccessKey(rest, deps)
	case "endpoints":
		return mgmtAccessEndpoints(rest, deps)
	case "models":
		return mgmtAccessModels(rest, deps)
	case "test":
		return mgmtAccessTest(rest, deps)
	default:
		return managementCliUsage("unknown access command "+sub, accessUsage)
	}
}

func mgmtAccessKey(argv []string, deps Deps) error {
	args := append([]string(nil), argv...)
	action := "list"
	if len(args) > 0 {
		action = strings.ToLower(args[0])
		args = args[1:]
	}
	wantsJSON := takeMgmtFlag(&args, "--json")
	switch action {
	case "list":
		if err := rejectMgmtArgs(args, accessUsage); err != nil {
			return err
		}
		body, rawText, _, err := managementRequest(deps, "GET", "/api/keys", "")
		if err != nil {
			return err
		}
		lines := []string{"No API access keys configured."}
		keys := mgmtKeyRows(body)
		if len(keys) > 0 {
			lines = mgmtFormatKeyRows(body, keys)
		}
		printManagementData(deps, body, rawText, wantsJSON, lines)
		return nil
	case "create":
		name := "default"
		if len(args) > 0 {
			name = args[0]
			args = args[1:]
		}
		if err := rejectMgmtArgs(args, accessUsage); err != nil {
			return err
		}
		result, _, _, err := managementRequest(deps, "POST", "/api/keys", `{"name":`+quoteJSONString(name)+`}`)
		if err != nil {
			return err
		}
		resultName := fieldString(result, "name")
		if resultName == "" {
			resultName = name
		}
		printManagementData(deps, result, "", wantsJSON, []string{
			fmt.Sprintf("Created API key %s (%s).", resultName, fieldString(result, "id")),
			fmt.Sprintf("Key (shown once): %s", fieldString(result, "key")),
		})
		return nil
	case "rotate":
		return mgmtAccessKeyRotate(args, wantsJSON, deps)
	case "remove", "delete":
		id := ""
		if len(args) > 0 {
			id = args[0]
			args = args[1:]
		}
		yes := takeMgmtFlag(&args, "--yes")
		if id == "" {
			return managementCliUsage("key id is required", accessUsage)
		}
		if !yes {
			return managementCliUsage("remove requires --yes", accessUsage)
		}
		if err := rejectMgmtArgs(args, accessUsage); err != nil {
			return err
		}
		result, _, _, err := managementRequest(deps, "DELETE", "/api/keys", `{"id":`+quoteJSONString(id)+`}`)
		if err != nil {
			return err
		}
		printManagementData(deps, result, "", wantsJSON, []string{fmt.Sprintf("Removed API key %s.", id)})
		return nil
	default:
		return managementCliUsage("unknown key command "+action, accessUsage)
	}
}

func mgmtAccessKeyRotate(args []string, wantsJSON bool, deps Deps) error {
	operation := "start"
	if len(args) > 0 && (args[0] == "commit" || args[0] == "abort") {
		operation = args[0]
		args = args[1:]
	}
	id := ""
	if len(args) > 0 {
		id = args[0]
		args = args[1:]
	}
	if id == "" {
		return managementCliUsage("key id is required", accessUsage)
	}
	if operation == "start" {
		if err := rejectMgmtArgs(args, accessUsage); err != nil {
			return err
		}
		result, _, _, err := managementRequest(deps, "POST", "/api/keys/rotate", `{"id":`+quoteJSONString(id)+`}`)
		if err != nil {
			return err
		}
		printManagementData(deps, result, "", wantsJSON, []string{
			fmt.Sprintf("Started rotation for API key %s.", id),
			fmt.Sprintf("New key (shown once): %s", fieldString(result, "key")),
			fmt.Sprintf("After the client accepts it, commit with rotation id %s.", fieldString(result, "rotationId")),
		})
		return nil
	}
	rotationID := ""
	if len(args) > 0 {
		rotationID = args[0]
		args = args[1:]
	}
	if rotationID == "" {
		return managementCliUsage("rotation id is required", accessUsage)
	}
	if err := rejectMgmtArgs(args, accessUsage); err != nil {
		return err
	}
	body := `{"id":` + quoteJSONString(id) + `,"rotationId":` + quoteJSONString(rotationID) + `}`
	method, path := "POST", "/api/keys/rotate/commit"
	if operation == "abort" {
		method, path = "DELETE", "/api/keys/rotate"
	}
	result, _, _, err := managementRequest(deps, method, path, body)
	if err != nil {
		return err
	}
	verb := "Committed"
	if operation == "abort" {
		verb = "Aborted"
	}
	printManagementData(deps, result, "", wantsJSON, []string{fmt.Sprintf("%s rotation for API key %s.", verb, id)})
	return nil
}

func mgmtAccessEndpoints(argv []string, deps Deps) error {
	args := append([]string(nil), argv...)
	wantsJSON := takeMgmtFlag(&args, "--json")
	if err := rejectMgmtArgs(args, accessUsage); err != nil {
		return err
	}
	result, _, _, err := managementRequest(deps, "GET", "/api/keys", "")
	if err != nil {
		return err
	}
	filtered := jsonwire.ObjectValue()
	if result != nil && result.Kind() == jsonwire.Object {
		for _, member := range result.Members() {
			if strings.HasSuffix(member.Key, "Endpoint") || member.Key == "baseUrl" || member.Key == "endpoint" {
				filtered.Set(member.Key, member.Value)
			}
		}
	}
	lines := []string{}
	for _, member := range filtered.Members() {
		lines = append(lines, fmt.Sprintf("%s: %s", member.Key, jsString(member.Value)))
	}
	printManagementData(deps, filtered, "", wantsJSON, lines)
	return nil
}

func mgmtAccessModels(argv []string, deps Deps) error {
	args := append([]string(nil), argv...)
	wantsJSON := takeMgmtFlag(&args, "--json")
	if err := rejectMgmtArgs(args, accessUsage); err != nil {
		return err
	}
	result, _, _, err := managementRequest(deps, "GET", "/v1/models", "")
	if err != nil {
		return err
	}
	lines := []string{}
	if data := fieldArray(result, "data"); data != nil {
		for _, row := range data.Elements() {
			if row == nil || row.Kind() != jsonwire.Object {
				continue
			}
			id := fieldString(row, "id")
			ownedBy := ""
			if field := row.Find("owned_by"); field != nil {
				if field.Kind() == jsonwire.String {
					ownedBy = field.String()
				} else if field.Kind() == jsonwire.Null {
					ownedBy = ""
				}
			}
			line := id + "  " + ownedBy
			lines = append(lines, strings.TrimRight(line, " "))
		}
	}
	printManagementData(deps, result, "", wantsJSON, lines)
	return nil
}

func mgmtAccessTest(argv []string, deps Deps) error {
	args := append([]string(nil), argv...)
	model := ""
	if len(args) > 0 {
		model = args[0]
		args = args[1:]
	}
	wantsJSON := takeMgmtFlag(&args, "--json")
	protocol, _, err := takeMgmtOption(&args, "--protocol")
	if err != nil {
		return err
	}
	if protocol == "" {
		protocol = "chat"
	}
	if model == "" {
		return managementCliUsage("model is required", accessUsage)
	}
	if protocol != "chat" && protocol != "responses" && protocol != "messages" {
		return managementCliUsage("--protocol must be chat, responses, or messages", accessUsage)
	}
	if err := rejectMgmtArgs(args, accessUsage); err != nil {
		return err
	}
	path := "/v1/chat/completions"
	requestBody := `{"model":` + quoteJSONString(model) + `,"messages":[{"role":"user","content":"Reply with OK."}],"max_tokens":16,"stream":false}`
	if protocol == "responses" {
		path = "/v1/responses"
		requestBody = `{"model":` + quoteJSONString(model) + `,"input":"Reply with OK.","max_output_tokens":16}`
	} else if protocol == "messages" {
		path = "/v1/messages"
		requestBody = `{"model":` + quoteJSONString(model) + `,"messages":[{"role":"user","content":"Reply with OK."}],"max_tokens":16}`
	}
	result, _, _, reqErr := managementRequest(deps, "POST", path, requestBody)
	if reqErr != nil {
		return reqErr
	}
	printManagementData(deps, result, "", wantsJSON, []string{fmt.Sprintf("%s: %s request succeeded.", model, protocol)})
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// key-table rendering — port of formatKeyRows in src/cli/access.ts.

func mgmtKeyRows(body *jsonwire.Value) []*jsonwire.Value {
	if body == nil || body.Kind() != jsonwire.Object {
		return nil
	}
	array := fieldArray(body, "keys")
	if array == nil {
		return nil
	}
	var rows []*jsonwire.Value
	for _, element := range array.Elements() {
		if element != nil && element.Kind() == jsonwire.Object {
			rows = append(rows, element)
		}
	}
	return rows
}

// mgmtFormatKeyRows renders the key table with usage-column semantics: an
// ambiguous key prints one marker spanning both numeric columns; numeric cells
// use toLocaleString("en-US"); the data-set footer prints once below a blank
// line.
func mgmtFormatKeyRows(body *jsonwire.Value, keys []*jsonwire.Value) []string {
	cells := [][]string{{"ID", "NAME", "PREFIX", "REQ 7D", "TOTAL", "LAST USED"}}
	for _, entry := range keys {
		usage := entry.Find("usage")
		if usage == nil || usage.Kind() != jsonwire.Object {
			usage = jsonwire.ObjectValue()
		}
		ambiguous := false
		if field := usage.Find("ambiguous"); field != nil && field.Kind() == jsonwire.Bool {
			ambiguous = field.Bool()
		}
		requests7d := usage.Find("requests7d")
		totalRequests := usage.Find("totalRequests")
		lastUsedAt := usage.Find("lastUsedAt")
		cells = append(cells, []string{
			fieldString(entry, "id"),
			fieldString(entry, "name"),
			fieldString(entry, "prefix"),
			ambiguousOrNumber(ambiguous, requests7d),
			ambiguousOrEmptyNumber(ambiguous, totalRequests),
			ambiguousOrLastUsed(ambiguous, lastUsedAt),
		})
	}
	widths := make([]int, len(cells[0]))
	for _, row := range cells {
		for i, cell := range row {
			if len(cell) > widths[i] {
				widths[i] = len(cell)
			}
		}
	}
	lines := []string{}
	for _, row := range cells {
		parts := make([]string, 0, len(row))
		for i, cell := range row {
			parts = append(parts, cell+strings.Repeat(" ", widths[i]-len(cell)))
		}
		lines = append(lines, strings.TrimRight(strings.Join(parts, "  "), " "))
	}
	footer := []string{}
	if attribution := fieldString(body, "attributionSince"); attribution != "" {
		footer = append(footer, "attribution since "+attribution)
	}
	if field := body.Find("historyTruncated"); field != nil && field.Kind() == jsonwire.Bool && field.Bool() {
		footer = append(footer, "older history truncated")
	}
	for _, entry := range keys {
		usage := entry.Find("usage")
		if usage == nil || usage.Kind() != jsonwire.Object {
			continue
		}
		if field := usage.Find("ambiguous"); field != nil && field.Kind() == jsonwire.Bool && field.Bool() {
			footer = append(footer, "ambiguous: two configured keys share an id, so per-key totals do not exist")
			break
		}
	}
	if len(footer) > 0 {
		lines = append(lines, "")
		lines = append(lines, footer...)
	}
	return lines
}

func ambiguousOrNumber(ambiguous bool, value *jsonwire.Value) string {
	if ambiguous {
		return "ambiguous"
	}
	return usageNumberCell(value)
}

func ambiguousOrEmptyNumber(ambiguous bool, value *jsonwire.Value) string {
	if ambiguous {
		return ""
	}
	return usageNumberCell(value)
}

func ambiguousOrLastUsed(ambiguous bool, value *jsonwire.Value) string {
	if ambiguous {
		return ""
	}
	if value != nil && value.Kind() == jsonwire.String {
		return value.String()
	}
	return "never"
}

func usageNumberCell(value *jsonwire.Value) string {
	if value != nil && value.Kind() == jsonwire.Number {
		number, err := strconv.ParseFloat(value.NumberRaw(), 64)
		if err == nil {
			return formatENUSNumber(number)
		}
	}
	return "-"
}

// quoteJSONString encodes one string as a JSON literal via the V8 rules.
func quoteJSONString(value string) string {
	raw, err := jsonwire.EncodeString(value)
	if err != nil {
		return `""`
	}
	return string(raw)
}

// fieldString returns an object member's string payload, or "" when absent or
// not a string.
func fieldString(object *jsonwire.Value, key string) string {
	if object == nil || object.Kind() != jsonwire.Object {
		return ""
	}
	field := object.Find(key)
	if field == nil || field.Kind() != jsonwire.String {
		return ""
	}
	return field.String()
}

// fieldArray returns an object member's array, or nil when absent/not an array.
func fieldArray(object *jsonwire.Value, key string) *jsonwire.Value {
	if object == nil || object.Kind() != jsonwire.Object {
		return nil
	}
	field := object.Find(key)
	if field == nil || field.Kind() != jsonwire.Array {
		return nil
	}
	return field
}
