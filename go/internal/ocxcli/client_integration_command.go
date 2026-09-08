package ocxcli

// ocx zcode — connect ZCode (Z.ai's desktop client) to the proxy via the
// client-integration management surface (issue #54 launcher slice). This file
// ports the TypeScript owner (src/cli/integrations.ts handleZcodeCommand and
// the shared handleClientIntegrationCommand it forwards into, plus the
// runCliAction/runtimeRequest taxonomy of src/cli/runtime-api.ts) so the
// ownership flip keeps the byte contract identical: the same usage rejections,
// the same /api/client-integrations routes, and the same restart reminder after
// a successful enable/disable.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

const clientIntegrationUsage = `Usage:
  ocx integration client [status] [--client <id>] [--json]
  ocx integration client <enable|disable> --client <id> [--overwrite-conflict] [--json]
  ocx integration client history [--client <id>] [--json]
  ocx integration client restore --op <opId> [--confirm-drift] [--json]`

const zcodeUsage = `Usage:
  ocx zcode [status] [--json]
  ocx zcode <enable|disable> [--json]
  ocx zcode history [--json]
  ocx zcode restore --op <opId> [--confirm-drift] [--json]`

// zcodeHelp mirrors the registry-derived help the TypeScript CLI prints for
// `ocx help zcode` / `ocx zcode --help` (printSubcommandUsage).
const zcodeHelp = "Usage: ocx zcode [status|enable|disable|history|restore] [--json]\n\nConnect ZCode (Z.ai desktop client) to the proxy via its managed provider.\n\nAlias of ocx integration client <sub> --client zcode.\nenable writes the managed provider.opencodex block into ~/.zcode/v2/config.json; disable removes only that block.\nZCode reads its config at startup — restart ZCode after enable/disable.\nSelect OpenCodex Proxy/<provider>/<model> from ZCode's model picker.\n"

// clientIntegrationUsageFailure mirrors runCliAction's CliUsageError lane (exit 2 with the
// usage block when one is attached).
type clientIntegrationUsageFailure struct {
	message string
	usage   string
}

func (f *clientIntegrationUsageFailure) Error() string { return f.message }

// cliAPIError mirrors runCliAction's RuntimeApiError lane: the operator-facing
// message plus the HTTP status that picks the exit code (404 → 4, 409 → 5).
type cliAPIError struct {
	message string
	status  int
}

func (f *cliAPIError) Error() string { return f.message }

// runCliActionResult mirrors runCliAction's exit-code mapping.
func runCliActionResult(err error) int {
	if err == nil {
		return ExitOK
	}
	var usage *clientIntegrationUsageFailure
	if errors.As(err, &usage) {
		fmt.Fprintf(actionWriter(true), "Error: %s\n", usage.message)
		if usage.usage != "" {
			fmt.Fprintln(actionWriter(true), usage.usage)
		}
		return 2
	}
	var api *cliAPIError
	if errors.As(err, &api) {
		fmt.Fprintf(actionWriter(true), "Error: %s\n", api.message)
		if api.status == 404 {
			return 4
		}
		if api.status == 409 {
			return 5
		}
		return 1
	}
	fmt.Fprintf(actionWriter(true), "Error: %s\n", err.Error())
	return 1
}

// action writer seams: production commands print through deps.Stderr/Stdout,
// but the shared action runner above needs a writer at error time. defaultOut
// and defaultErr are set once by the command entry points from deps before any
// error can surface, so a bare Run with defaults falls back to os.Stdout/Stderr.
var actionOut io.Writer
var actionErr io.Writer

var defaultOutWriter io.Writer = os.Stdout
var defaultErrWriter io.Writer = os.Stderr

// setActionWriters binds the shared runner writers to this invocation's Deps
// and returns the restore function for the caller to defer.
func setActionWriters(deps Deps) func() {
	previousOut, previousErr := actionOut, actionErr
	resolved := defaults(deps)
	actionOut, actionErr = resolved.Stdout, resolved.Stderr
	return func() {
		actionOut, actionErr = previousOut, previousErr
	}
}

func actionWriter(isErr bool) io.Writer {
	if isErr {
		if actionErr != nil {
			return actionErr
		}
		return defaultErrWriter
	}
	if actionOut != nil {
		return actionOut
	}
	return defaultOutWriter
}

// runtimeApiRequest mirrors runtimeRequest/runtimeBaseUrl: locate the live proxy
// and issue the management request with the same admin-token headers. The body
// is returned as a jsonwire tree (document order and V8 number literals kept)
// plus the raw text for the non-JSON lane. Like fetchUsageReport, rawText is
// set only when the body was not valid JSON (runtimeRequest keeps the text in
// that case), so runtimeResponseMessage's raw lane never sees a parsed body.
func runtimeApiRequest(deps Deps, path string, method string, requestBody []byte) (*jsonwire.Value, string, int, error) {
	deps = defaults(deps)
	state, found := liveProxyEndpoint(deps)
	if !found {
		return nil, "", 503, &cliAPIError{message: "Proxy is not running. Start it with: ocx start", status: 503}
	}
	endpoint := path
	if !strings.HasPrefix(endpoint, "/") {
		endpoint = "/" + endpoint
	}
	var reader io.Reader
	if requestBody != nil {
		reader = bytes.NewReader(requestBody)
	}
	request, requestErr := http.NewRequest(method, baseURL(state)+endpoint, reader)
	if requestErr != nil {
		return nil, "", 503, &cliAPIError{message: "Management API is unreachable: " + requestErr.Error(), status: 503}
	}
	request.Header.Set("Content-Type", "application/json")
	if token := configuredUsageAdminToken(); token != "" {
		request.Header.Set("X-OpenCodex-API-Key", token)
	}
	response, doErr := deps.HTTPClient.Do(request)
	if doErr != nil {
		return nil, "", 503, &cliAPIError{message: "Management API is unreachable: " + doErr.Error(), status: 503}
	}
	defer response.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024))
	if readErr != nil {
		return nil, "", 503, &cliAPIError{message: "Management API is unreachable: " + readErr.Error(), status: 503}
	}
	value, parseErr := jsonwire.Parse(raw)
	if parseErr != nil {
		// Non-JSON body: runtimeRequest keeps the text and responseMessage's
		// raw lane prints it; a non-2xx status still fails the request.
		if response.StatusCode < 200 || response.StatusCode > 299 {
			return nil, "", response.StatusCode, &cliAPIError{message: runtimeResponseMessage(nil, string(raw), response.StatusCode), status: response.StatusCode}
		}
		return nil, string(raw), response.StatusCode, nil
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, "", response.StatusCode, &cliAPIError{message: runtimeResponseMessage(value, "", response.StatusCode), status: response.StatusCode}
	}
	return value, "", response.StatusCode, nil
}

// runtimeResponseMessage mirrors responseMessage in src/cli/runtime-api.ts.
// It shares the implementation with usageResponseMessage (the same TS function
// backs both owners), so a responseMessage edit upstream lands in one Go spot.
func runtimeResponseMessage(body *jsonwire.Value, rawText string, status int) string {
	return usageResponseMessage(body, rawText, status)
}

// takeRuntimeOption mirrors takeOption: `--flag value`, rejecting a missing or
// flag-shaped value with the exact TypeScript message.
func takeRuntimeOption(args *[]string, flag string) (string, error) {
	for index, arg := range *args {
		if arg != flag {
			continue
		}
		if index+1 >= len(*args) || strings.HasPrefix((*args)[index+1], "--") {
			return "", &clientIntegrationUsageFailure{message: flag + " requires a value"}
		}
		value := (*args)[index+1]
		*args = append((*args)[:index], (*args)[index+2:]...)
		return value, nil
	}
	return "", nil
}

// rejectRuntimeArgs mirrors rejectArgs: a leftover argument is an unexpected
// argument error carrying the caller's usage block.
func rejectRuntimeArgs(args []string, usage string) error {
	if len(args) > 0 {
		return &clientIntegrationUsageFailure{message: "Unexpected argument(s): " + strings.Join(args, " "), usage: usage}
	}
	return nil
}

// printRuntimeData mirrors printData: JSON.stringify(value, null, 2) on stdout
// when JSON was requested or no summary lines exist, otherwise the lines.
func printRuntimeData(deps Deps, value *jsonwire.Value, rawText string, wantsJSON bool, lines []string) {
	if wantsJSON || lines == nil {
		_ = writeUsageJSON(deps.Stdout, value, rawText)
		return
	}
	for _, line := range lines {
		fmt.Fprintln(deps.Stdout, line)
	}
}

// runtimeObjectField returns the member value for key when the value is an object.
func runtimeObjectField(value *jsonwire.Value, key string) *jsonwire.Value {
	if value == nil || value.Kind() != jsonwire.Object {
		return nil
	}
	return value.Find(key)
}

// stringifyTSValue mirrors String(value) as TypeScript renders it in
// summaryLines: null becomes "null", booleans and strings render plainly, and
// a nested object renders as its toString marker (objects are never expanded
// past depth 1, matching the TS depth gate).
func stringifyTSValue(value *jsonwire.Value) string {
	if value == nil || value.Kind() == jsonwire.Null {
		return "null"
	}
	switch value.Kind() {
	case jsonwire.String:
		return value.String()
	case jsonwire.Bool:
		return strconv.FormatBool(value.Bool())
	case jsonwire.Number:
		return value.NumberRaw()
	default:
		// Object and array values hit the depth gate before this lane in the
		// summary walker; this mirrors String(object) => "[object Object]".
		return "[object Object]"
	}
}

// runtimeSummaryLines ports summaryLines: a compact human view of a management
// DTO (depth-bounded) so the non-JSON status line reads identically. Arrays of
// scalars join with ", " ("none" when empty), arrays of objects report their
// length, and nested objects expand one level with dotted labels.
func runtimeSummaryLines(value *jsonwire.Value, prefix string, depth int) []string {
	if value == nil || value.Kind() == jsonwire.Null || value.Kind() != jsonwire.Object || depth > 1 {
		label := prefix
		if label == "" {
			label = "value"
		}
		return []string{fmt.Sprintf("%s: %s", label, stringifyTSValue(value))}
	}
	lines := []string{}
	for _, member := range value.Members() {
		label := member.Key
		if prefix != "" {
			label = prefix + "." + member.Key
		}
		child := member.Value
		if child.Kind() == jsonwire.Array {
			elements := child.Elements()
			scalar := true
			for _, element := range elements {
				if kind := element.Kind(); kind != jsonwire.Null && kind != jsonwire.String && kind != jsonwire.Number && kind != jsonwire.Bool {
					scalar = false
					break
				}
			}
			if scalar {
				joined := []string{}
				for _, element := range elements {
					joined = append(joined, stringifyTSValue(element))
				}
				text := strings.Join(joined, ", ")
				if text == "" {
					text = "none"
				}
				lines = append(lines, fmt.Sprintf("%s: %s", label, text))
			} else {
				lines = append(lines, fmt.Sprintf("%s: %d item(s)", label, len(elements)))
			}
			continue
		}
		if child.Kind() == jsonwire.Object && depth < 1 {
			lines = append(lines, runtimeSummaryLines(child, label, depth+1)...)
			continue
		}
		if child.Kind() == jsonwire.String && child.String() == "" {
			lines = append(lines, fmt.Sprintf("%s: -", label))
			continue
		}
		if child.Kind() == jsonwire.Null {
			lines = append(lines, fmt.Sprintf("%s: -", label))
			continue
		}
		lines = append(lines, fmt.Sprintf("%s: %s", label, stringifyTSValue(child)))
	}
	return lines
}

// runtimeMessageField mirrors `(result as …).message ?? fallback`: an absent
// or null "message" member falls back; an empty-string message is kept (TS
// prints String("")).
func runtimeMessageField(value *jsonwire.Value, fallback string) string {
	if value == nil || value.Kind() != jsonwire.Object {
		return fallback
	}
	field := value.Find("message")
	if field == nil || field.Kind() == jsonwire.Null {
		return fallback
	}
	return field.String()
}

// clientIntegrationRows extracts the client rows of a status response.
func clientIntegrationRows(value *jsonwire.Value) []string {
	member := runtimeObjectField(value, "clients")
	if member == nil || member.Kind() != jsonwire.Array {
		return nil
	}
	out := []string{}
	for _, row := range member.Elements() {
		if row.Kind() != jsonwire.Object {
			continue
		}
		idText := clientIntegrationFieldString(row, "clientId")
		stateText := clientIntegrationFieldString(row, "state")
		line := fmt.Sprintf("%s: %s", idText, stateText)
		installed := row.Find("installed")
		if installed == nil || installed.Kind() != jsonwire.Bool || !installed.Bool() {
			line += " (not installed)"
		}
		out = append(out, line)
	}
	return out
}

func clientIntegrationOperations(value *jsonwire.Value) []string {
	member := runtimeObjectField(value, "operations")
	if member == nil || member.Kind() != jsonwire.Array {
		return nil
	}
	elements := member.Elements()
	if len(elements) == 0 {
		return []string{"No integration operations recorded yet."}
	}
	out := []string{}
	for _, row := range elements {
		if row.Kind() != jsonwire.Object {
			continue
		}
		at := clientIntegrationFieldString(row, "at")
		clientID := clientIntegrationFieldString(row, "clientId")
		kind := clientIntegrationFieldString(row, "kind")
		backup := "op " + clientIntegrationFieldString(row, "opId")
		if snapshot := row.Find("snapshot"); snapshot != nil && snapshot.Kind() == jsonwire.String && snapshot.String() == "expired" {
			backup = "backup expired"
		}
		out = append(out, fmt.Sprintf("%s  %s  %s  (%s)", at, clientID, kind, backup))
	}
	return out
}

func clientIntegrationFieldString(object *jsonwire.Value, key string) string {
	field := object.Find(key)
	if field == nil || field.Kind() != jsonwire.String {
		return ""
	}
	return field.String()
}

// runClientIntegrationCommand ports handleClientIntegrationCommand (the shared
// client-integration headless surface that `ocx zcode` forwards into).
func runClientIntegrationCommand(argv []string, deps Deps) int {
	args := append([]string(nil), argv...)
	action := "status"
	if len(args) > 0 {
		action = strings.ToLower(args[0])
		args = args[1:]
	}
	wantsJSON := takeFlag(&args, "--json")

	switch action {
	case "status", "show", "list":
		client, err := takeRuntimeOption(&args, "--client")
		if err != nil {
			return runCliActionResult(err)
		}
		if err := rejectRuntimeArgs(args, clientIntegrationUsage); err != nil {
			return runCliActionResult(err)
		}
		path := "/api/client-integrations"
		if client != "" {
			path = "/api/client-integrations/" + url.PathEscape(client)
		}
		value, rawText, _, err := runtimeApiRequest(deps, path, http.MethodGet, nil)
		if err != nil {
			return runCliActionResult(err)
		}
		rows := clientIntegrationRows(value)
		if rows == nil {
			rows = runtimeSummaryLines(value, "", 0)
		}
		printRuntimeData(deps, value, rawText, wantsJSON, rows)
		return ExitOK
	case "history", "journal":
		client, err := takeRuntimeOption(&args, "--client")
		if err != nil {
			return runCliActionResult(err)
		}
		if err := rejectRuntimeArgs(args, clientIntegrationUsage); err != nil {
			return runCliActionResult(err)
		}
		path := "/api/client-integrations/journal"
		if client != "" {
			path += "?client=" + url.QueryEscape(client)
		}
		value, rawText, _, err := runtimeApiRequest(deps, path, http.MethodGet, nil)
		if err != nil {
			return runCliActionResult(err)
		}
		printRuntimeData(deps, value, rawText, wantsJSON, clientIntegrationOperations(value))
		return ExitOK
	case "restore":
		opID, err := takeRuntimeOption(&args, "--op")
		if err != nil {
			return runCliActionResult(err)
		}
		if opID == "" {
			if opID, err = takeRuntimeOption(&args, "--op-id"); err != nil {
				return runCliActionResult(err)
			}
		}
		confirmDrift := takeFlag(&args, "--confirm-drift")
		if err := rejectRuntimeArgs(args, clientIntegrationUsage); err != nil {
			return runCliActionResult(err)
		}
		if opID == "" {
			return runCliActionResult(&clientIntegrationUsageFailure{message: "--op <opId> is required", usage: clientIntegrationUsage})
		}
		body, _ := json.Marshal(struct {
			OpID         string `json:"opId"`
			ConfirmDrift bool   `json:"confirmDrift"`
		}{opID, confirmDrift})
		value, rawText, _, err := runtimeApiRequest(deps, "/api/client-integrations/restore", http.MethodPost, body)
		if err != nil {
			return runCliActionResult(err)
		}
		message := runtimeMessageField(value, "Restored.")
		printRuntimeData(deps, value, rawText, wantsJSON, []string{message})
		return ExitOK
	case "enable", "disable":
		client, err := takeRuntimeOption(&args, "--client")
		if err != nil {
			return runCliActionResult(err)
		}
		overwriteConflict := takeFlag(&args, "--overwrite-conflict")
		if err := rejectRuntimeArgs(args, clientIntegrationUsage); err != nil {
			return runCliActionResult(err)
		}
		if client == "" {
			return runCliActionResult(&clientIntegrationUsageFailure{message: "--client <id> is required", usage: clientIntegrationUsage})
		}
		if overwriteConflict && action == "disable" {
			return runCliActionResult(&clientIntegrationUsageFailure{message: "--overwrite-conflict applies only to enable", usage: clientIntegrationUsage})
		}
		var body []byte
		if overwriteConflict {
			body, _ = json.Marshal(struct {
				Enabled           bool `json:"enabled"`
				OverwriteConflict bool `json:"overwriteConflict"`
			}{true, true})
		} else {
			body, _ = json.Marshal(struct {
				Enabled bool `json:"enabled"`
			}{action == "enable"})
		}
		path := "/api/client-integrations/" + url.PathEscape(client)
		value, rawText, _, err := runtimeApiRequest(deps, path, http.MethodPut, body)
		if err != nil {
			return runCliActionResult(err)
		}
		message := runtimeMessageField(value, fmt.Sprintf("%s %sd.", client, action))
		printRuntimeData(deps, value, rawText, wantsJSON, []string{message})
		return ExitOK
	default:
		return runCliActionResult(&clientIntegrationUsageFailure{
			message: "unknown client integration command " + action,
			usage:   clientIntegrationUsage,
		})
	}
}

// runZcodeCommand ports handleZcodeCommand: `ocx zcode` is a thin alias that
// injects `--client zcode` into the shared client-integration surface.
func runZcodeCommand(args []string, deps Deps) int {
	reset := setActionWriters(deps)
	defer reset()
	verbIndex := -1
	for index, arg := range args {
		if !strings.HasPrefix(arg, "-") {
			verbIndex = index
			break
		}
	}
	action := "status"
	if verbIndex != -1 {
		action = strings.ToLower(args[verbIndex])
	}
	switch action {
	case "status", "show", "list", "enable", "disable", "history", "journal", "restore":
	default:
		fmt.Fprintf(actionWriter(true), "unknown zcode command %s\n", action)
		fmt.Fprintln(actionWriter(true), zcodeUsage)
		return 2
	}
	rest := []string{}
	if verbIndex == -1 {
		rest = append(rest, args...)
	} else {
		rest = append(rest, args[:verbIndex]...)
		rest = append(rest, args[verbIndex+1:]...)
	}
	forwarded := []string{action}
	if action == "restore" {
		forwarded = append(forwarded, rest...)
	} else {
		forwarded = append(forwarded, rest...)
		forwarded = append(forwarded, "--client", "zcode")
	}
	code := runClientIntegrationCommand(forwarded, deps)
	if code == 0 && (action == "enable" || action == "disable") {
		fmt.Fprintln(actionWriter(true), "Restart ZCode to pick up the provider change.")
	}
	return code
}
