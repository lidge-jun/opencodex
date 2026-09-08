// Shared management-plane client for the Go-owned headless command families
// (access/api-key, system). This file ports the exact wire and error semantics
// of src/cli/runtime-api.ts so a flipped command keeps the same requests,
// messages, and exit codes as the TypeScript owner:
//
//   - live-proxy discovery reuses liveProxyEndpoint (runtime-port first, then
//     the configured listen port), so writes never bypass the management API
//     into config files unless the TS owner did (none of these families do).
//   - A request failure surfaces as a typed failure: apiFailure mirrors
//     RuntimeApiError (message + HTTP status -> exit 4 on 404, 5 on 409,
//     otherwise 1) and cliUsageFailure mirrors CliUsageError (message plus an
//     optional USAGE block on stderr, exit 2).
//   - Bodies are re-printed exactly like console.log(JSON.stringify(value,
//     null, 2)): jsonwire preserves document key order and V8 number/string
//     rules, with a trailing newline from the console.log.
//
// The debug family intentionally does NOT use managementRequest: src/cli/debug.ts
// talks to the proxy with raw fetch and its own error wording ("Failed to read
// debug settings (N)", no Error: prefix, exit 1), so debug_command.go keeps its
// own discovery + fetch port to stay byte-identical.
//
// The differential harness diffs every Go-owned row against the real TS CLI
// for the same argv and fixture server, so a drift here fails loudly.
package ocxcli

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// Exit codes from the runCliAction taxonomy (src/cli/runtime-api.ts), shared by
// every management-plane family.
const (
	mgmtExitUsage    = 2 // CliUsageError
	mgmtExitMissing  = 4 // RuntimeApiError status 404
	mgmtExitConflict = 5 // RuntimeApiError status 409
)

// cliUsageFailure mirrors CliUsageError: a message and an optional USAGE block
// printed to stderr before exit 2.
type cliUsageFailure struct {
	message string
	usage   string
}

func (e cliUsageFailure) Error() string { return e.message }

// apiFailure mirrors RuntimeApiError: a message and the HTTP status that
// selects the exit code.
type apiFailure struct {
	message string
	status  int
}

func (e apiFailure) Error() string { return e.message }

// reportManagementFailure prints the operator-facing line and USAGE block the
// way runCliAction does, and returns the matching exit code.
func reportManagementFailure(deps Deps, err error) int {
	fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
	var usageErr cliUsageFailure
	if errors.As(err, &usageErr) {
		if usageErr.usage != "" {
			fmt.Fprint(deps.Stderr, usageErr.usage)
			if !strings.HasSuffix(usageErr.usage, "\n") {
				fmt.Fprintln(deps.Stderr)
			}
		}
		return mgmtExitUsage
	}
	var api apiFailure
	if errors.As(err, &api) {
		switch api.status {
		case 404:
			return mgmtExitMissing
		case 409:
			return mgmtExitConflict
		default:
			return 1
		}
	}
	return 1
}

// managementCliUsage builds the CliUsageError-equivalent failure.
// managementCliUsage builds a CliUsageError-equivalent failure (message plus
// optional USAGE block on stderr, exit 2).
func managementCliUsage(message, usage string) error {
	return cliUsageFailure{message: message, usage: usage}
}

// managementAPIError builds the RuntimeApiError-equivalent failure from the
// response body and status, composing responseMessage exactly like runtime-api.
func managementAPIError(body *jsonwire.Value, rawText string, status int) error {
	return apiFailure{message: managementResponseMessage(body, rawText, status), status: status}
}

// managementResponseMessage mirrors responseMessage in runtime-api.ts: compose
// the operator-facing message from a management error body. The primary string
// comes from error|message|detail; reason and hint append as separate lines.
func managementResponseMessage(body *jsonwire.Value, rawText string, status int) string {
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

// managementRequest mirrors runtimeRequest: resolve the live proxy, send one
// authenticated management request, and classify the response. A nil body with
// a non-empty rawText means the response was not valid JSON (runtimeRequest
// keeps the text verbatim in that case). Non-2xx responses surface as an
// apiFailure whose message is composed from the body.
// managementRequest performs an authenticated management-plane request and
// classifies the response exactly like runtimeRequest in src/cli/runtime-api.ts.
// It returns the parsed body (nil when the body is empty or not JSON), the raw
// body text, the HTTP status, and an error only for transport/parse failures;
// a non-2xx status comes back as an error via managementAPIError.
func managementRequest(deps Deps, method, path, body string) (*jsonwire.Value, string, int, error) {
	deps = defaults(deps)
	state, found := liveProxyEndpoint(deps)
	if !found {
		return nil, "", 503, apiFailure{message: "Proxy is not running. Start it with: ocx start", status: 503}
	}
	request, requestErr := http.NewRequest(method, baseURL(state)+path, nil)
	if requestErr != nil {
		return nil, "", 503, apiFailure{message: fmt.Sprintf("Management API is unreachable: %s", requestErr), status: 503}
	}
	request.Header.Set("Content-Type", "application/json")
	if body != "" {
		request.Body = io.NopCloser(strings.NewReader(body))
		request.ContentLength = int64(len(body))
	}
	if token := configuredUsageAdminToken(); token != "" {
		request.Header.Set("X-OpenCodex-API-Key", token)
	}
	response, doErr := deps.HTTPClient.Do(request)
	if doErr != nil {
		return nil, "", 503, apiFailure{message: fmt.Sprintf("Management API is unreachable: %s", doErr), status: 503}
	}
	defer response.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024))
	if readErr != nil {
		return nil, "", 503, apiFailure{message: fmt.Sprintf("Management API is unreachable: %s", readErr), status: 503}
	}
	value, parseErr := jsonwire.Parse(raw)
	if parseErr != nil {
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, string(raw), response.StatusCode, managementAPIError(nil, string(raw), response.StatusCode)
		}
		return nil, string(raw), response.StatusCode, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return value, "", response.StatusCode, managementAPIError(value, "", response.StatusCode)
	}
	return value, "", response.StatusCode, nil
}

// takeMgmtFlag mirrors takeFlag in src/cli/root.ts: remove `flag` from args
// anywhere and report whether it was present.
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

// quoteJSONString encodes one string as a JSON literal via the V8 rules
// (jsonwire.EncodeString), shared by every family that builds request bodies.
func quoteJSONString(value string) string {
	raw, err := jsonwire.EncodeString(value)
	if err != nil {
		return `""`
	}
	return string(raw)
}
