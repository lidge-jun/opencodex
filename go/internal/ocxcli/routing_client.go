package ocxcli

// Shared management-plane client for the config-routing command families
// (ocx alias, ocx combo, ocx route combo|policy). Mirrors
// src/cli/runtime-api.ts: these CLIs never edit config.json directly. They
// find the live proxy (identity-checked, exactly like findLiveProxy), send the
// admin token like runningProxyUpdateHeaders, and talk to the same /api/*
// management routes the GUI uses, so validation and live-config refresh cannot
// diverge between surfaces.
//
// The error taxonomy mirrors runCliAction in runtime-api.ts:
//   - usage errors (CliUsageError): "Error: <msg>" plus the USAGE block when
//     the error carried one, exit 2
//   - management failures (RuntimeApiError): "Error: <msg>", exit 4 on 404,
//     5 on 409, otherwise 1

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// Exit codes from the runCliAction taxonomy, shared by the routing families.
const (
	routingExitUsage    = 2 // CliUsageError
	routingExitMissing  = 4 // RuntimeApiError status 404
	routingExitConflict = 5 // RuntimeApiError status 409
)

// routingAPIError mirrors RuntimeApiError's observable shape: a message and an
// HTTP status that selects the exit code.
type routingAPIError struct {
	message string
	status  int
}

func (e routingAPIError) Error() string { return e.message }

// routingEncodePathComponent mirrors encodeURIComponent: percent-encode the
// UTF-8 bytes of every character outside the JS unescaped set
// (A-Z a-z 0-9 - _ . ! ~ * ' ( )), with uppercase hex escapes. Go's
// url.QueryEscape would encode spaces as '+' and url.PathEscape leaves
// '$&+,;=:@' raw, so neither reproduces a path TypeScript builds.
func routingEncodePathComponent(value string) string {
	var b strings.Builder
	for index := 0; index < len(value); {
		character, size := utf8.DecodeRuneInString(value[index:])
		if size == 1 && character == utf8.RuneError {
			// Invalid UTF-8 byte: encode the raw byte, not the replacement rune.
			b.WriteString(fmt.Sprintf("%%%02X", value[index]))
			index++
			continue
		}
		unescaped := character >= 'a' && character <= 'z' ||
			character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' ||
			character == '-' || character == '_' || character == '.' ||
			character == '!' || character == '~' || character == '*' ||
			character == '\'' || character == '(' || character == ')'
		if unescaped {
			b.WriteRune(character)
		} else {
			for offset := 0; offset < size; offset++ {
				b.WriteString(fmt.Sprintf("%%%02X", value[index+offset]))
			}
		}
		index += size
	}
	return b.String()
}

// routingTakeOption mirrors takeOption: remove the first `flag value` pair from
// args and report whether it was present. A missing value or a value that
// starts with "--" fails with the exact TypeScript message (no USAGE block).
func routingTakeOption(args *[]string, flag string) (string, bool, error) {
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

// routingTakeIntegerOption mirrors takeIntegerOption: parse the option value
// with JS Number semantics for the separators it strips (commas/underscores),
// requiring an integer >= min with the exact TypeScript error message.
func routingTakeIntegerOption(args *[]string, flag string, min int) (int, bool, error) {
	raw, given, err := routingTakeOption(args, flag)
	if err != nil || !given {
		return 0, given, err
	}
	cleaned := strings.NewReplacer(",", "", "_", "").Replace(raw)
	value, parseErr := strconv.ParseFloat(cleaned, 64)
	if parseErr != nil || math.Trunc(value) != value || value < float64(min) {
		return 0, true, fmt.Errorf("%s must be an integer >= %d", flag, min)
	}
	return int(value), true, nil
}

// routingUnexpectedArgs mirrors rejectArgs without secret redaction: the
// config-routing families parse no credential-bearing options.
func routingUnexpectedArgs(args []string) string {
	return fmt.Sprintf("Unexpected argument(s): %s", strings.Join(args, " "))
}

func bytesReader(data []byte) io.Reader {
	if data == nil {
		return nil
	}
	return bytes.NewReader(data)
}

// routingRoundTrip performs one management request. It mirrors
// runtimeRequest/fetchUsageReport: identity-checked live-proxy discovery
// first, admin token from env or file, then the response body parsed into a
// jsonwire tree (rawText is set only when the body is not valid JSON, exactly
// like the TS parse-or-text branch). Transport and discovery failures carry
// the 503 RuntimeApiError message; a non-2xx status surfaces through the
// returned error so the status selects the exit code.
func routingRoundTrip(deps Deps, method, path string, body []byte) (*jsonwire.Value, string, int, error) {
	deps = defaults(deps)
	state, found := liveProxyEndpoint(deps)
	if !found {
		return nil, "", 503, routingAPIError{message: "Proxy is not running. Start it with: ocx start", status: 503}
	}
	request, requestErr := http.NewRequest(method, baseURL(state)+path, bytesReader(body))
	if requestErr != nil {
		return nil, "", 503, routingAPIError{message: "Management API is unreachable: " + requestErr.Error(), status: 503}
	}
	request.Header.Set("Content-Type", "application/json")
	if token := configuredUsageAdminToken(); token != "" {
		request.Header.Set("X-OpenCodex-API-Key", token)
	}
	response, doErr := deps.HTTPClient.Do(request)
	if doErr != nil {
		return nil, "", 503, routingAPIError{message: "Management API is unreachable: " + doErr.Error(), status: 503}
	}
	defer response.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024))
	if readErr != nil {
		return nil, "", 503, routingAPIError{message: "Management API is unreachable: " + readErr.Error(), status: 503}
	}
	value, parseErr := jsonwire.Parse(raw)
	if parseErr != nil {
		return nil, string(raw), response.StatusCode, nil
	}
	return value, "", response.StatusCode, nil
}

// routingResponseMessage composes the operator-facing message from a failed
// management response, mirroring responseMessage in runtime-api.ts (via the
// usage_command.go port of the same helper).
func routingResponseMessage(body *jsonwire.Value, rawText string, status int) string {
	return usageResponseMessage(body, rawText, status)
}

// routingDo runs one management request and folds a non-2xx response into the
// RuntimeApiError taxonomy, so call sites never repeat the status check that
// runtimeRequest centralizes on the TypeScript side. Discovery and transport
// failures already surface as routingAPIError from routingRoundTrip.
func routingDo(deps Deps, method, path string, body []byte) (*jsonwire.Value, string, error) {
	value, rawText, status, err := routingRoundTrip(deps, method, path, body)
	if err == nil {
		err = routingErrorFromRoundTrip(value, rawText, status)
	}
	return value, rawText, err
}

// routingReportErrorFrom reports any error a routingDo call returned through
// the taxonomy (routingReportError picks the exit code from the status). An
// unknown error kind — a future call site adding a non-taxonomy error without
// updating this helper — degrades to the generic failure instead of panicking
// on a type assertion.
func routingReportErrorFrom(deps Deps, err error) int {
	var apiErr routingAPIError
	if errors.As(err, &apiErr) {
		return routingReportError(deps, apiErr)
	}
	fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
	return ExitFailure
}

// routingReportError mirrors a RuntimeApiError reaching runCliAction: the
// Error line on stderr and the status-selected exit code.
func routingReportError(deps Deps, err routingAPIError) int {
	fmt.Fprintln(deps.Stderr, "Error: "+err.message)
	switch err.status {
	case http.StatusNotFound:
		return routingExitMissing
	case http.StatusConflict:
		return routingExitConflict
	default:
		return ExitFailure
	}
}

// routingUsageError mirrors a CliUsageError carrying the USAGE block reaching
// runCliAction: the Error line plus the block on stderr, exit 2.
func routingUsageError(deps Deps, message, usage string) int {
	fmt.Fprintln(deps.Stderr, "Error: "+message)
	if usage != "" {
		fmt.Fprintln(deps.Stderr, usage)
	}
	return routingExitUsage
}

// routingPrintData mirrors printData in runtime-api.ts:
//   - wantsJSON true, or no human lines supplied: JSON.stringify(value, null, 2)
//     plus the console.log newline (rawText quoted when the body was not JSON)
//   - otherwise one console.log line per human line
func routingPrintData(deps Deps, value *jsonwire.Value, rawText string, wantsJSON bool, lines []string) {
	if wantsJSON || lines == nil {
		if err := writeUsageJSON(deps.Stdout, value, rawText); err != nil {
			// The raw-text branch only triggers for non-JSON bodies; EncodeString
			// cannot fail for arbitrary UTF-8 input.
			fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
		}
		return
	}
	for _, line := range lines {
		fmt.Fprintln(deps.Stdout, line)
	}
}

// routingErrorFromRoundTrip inspects a routingRoundTrip outcome and, for a
// non-2xx response, converts it into the RuntimeApiError taxonomy error the
// caller reports (mirroring the runtimeRequest non-ok branch).
func routingErrorFromRoundTrip(value *jsonwire.Value, rawText string, status int) error {
	if status >= 200 && status < 300 {
		return nil
	}
	return routingAPIError{message: routingResponseMessage(value, rawText, status), status: status}
}
