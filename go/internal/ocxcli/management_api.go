package ocxcli

// Shared management-plane engine for the Go-owned CLI families (ADR-0008
// incremental takeover). This file ports the runtime-api.ts primitives the
// flipped families use — option/flag parsing with the exact CliUsageError
// messages, rejectArgs with credential redaction, and csv — so the Go
// implementation is byte-exact against the TypeScript owner for the same argv.
//
// Exit codes mirror runCliAction:
//   - usage errors (CliUsageError): exit 2, "Error: <msg>" and, when the error
//     carries one, the USAGE block, on stderr
//   - RuntimeApiError: exit 4 on 404, 5 on 409, otherwise 1

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// managementUsageError mirrors CliUsageError: a message plus an optional USAGE
// block. When usageText is set runCliAction prints it after the Error line.
type managementUsageError struct {
	message   string
	usageText string
}

func (e *managementUsageError) Error() string { return e.message }

// managementAPIError mirrors RuntimeApiError's observable shape: a message and
// an HTTP status that selects the exit code.
type managementAPIError struct {
	message string
	status  int
}

func (e *managementAPIError) Error() string { return e.message }

// newUsageError builds a CliUsageError without a USAGE block (the shape thrown
// by takeOption/takeIntegerOption and their siblings).
func newUsageError(message string) error {
	return &managementUsageError{message: message}
}

// usageErrorWith mirrors a CliUsageError constructed with a USAGE block.
func usageErrorWith(message, usage string) error {
	return &managementUsageError{message: message, usageText: usage}
}

func newAPIError(message string, status int) error {
	return &managementAPIError{message: message, status: status}
}

// takeOption mirrors takeOption: `--flag value`, rejecting a missing value or
// one that starts with "--" with the exact TypeScript message. takeFlag (first
// occurrence) already lives in families.go.
func takeOption(args *[]string, flag string) (string, bool, error) {
	for i, arg := range *args {
		if arg != flag {
			continue
		}
		if i+1 >= len(*args) || strings.HasPrefix((*args)[i+1], "--") {
			return "", false, newUsageError(fmt.Sprintf("%s requires a value", flag))
		}
		value := (*args)[i+1]
		*args = append((*args)[:i], (*args)[i+2:]...)
		return value, true, nil
	}
	return "", false, nil
}

// takeBooleanOption mirrors takeBooleanOption: on/true/yes/1/enabled -> true,
// off/false/no/0/disabled -> false, anything else is a usage error.
func takeBooleanOption(args *[]string, flag string) (bool, bool, error) {
	raw, ok, err := takeOption(args, flag)
	if err != nil || !ok {
		return false, false, err
	}
	switch strings.ToLower(raw) {
	case "on", "true", "yes", "1", "enabled":
		return true, true, nil
	case "off", "false", "no", "0", "disabled":
		return false, true, nil
	default:
		return false, false, newUsageError(fmt.Sprintf("%s must be on or off", flag))
	}
}

// parseJSNumber approximates Number(raw.replace(/[_,]/g, "")) for the inputs
// the integer options legitimately carry. NaN/Infinity inputs yield ok=false so
// the caller reports the same usage error TS does.
func parseJSNumber(raw string) (float64, bool) {
	stripped := strings.NewReplacer("_", "", ",", "").Replace(raw)
	trimmed := strings.TrimSpace(stripped)
	if trimmed == "" {
		return 0, true
	}
	sign := 1.0
	body := trimmed
	if body[0] == '+' || body[0] == '-' {
		if body[0] == '-' {
			sign = -1
		}
		body = body[1:]
	}
	lower := strings.ToLower(body)
	if strings.HasPrefix(lower, "0x") {
		value, err := strconv.ParseUint(lower[2:], 16, 64)
		if err != nil {
			return 0, false
		}
		return sign * float64(value), true
	}
	switch lower {
	case "infinity":
		return sign * math.Inf(1), true
	case "nan":
		return math.NaN(), true
	}
	value, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	return value, true
}

// takeIntegerOption mirrors takeIntegerOption: an integral value >= min (when
// given); the exact "--flag must be an integer[ >= min]" usage error otherwise.
func takeIntegerOption(args *[]string, flag string, min *int) (float64, bool, error) {
	raw, ok, err := takeOption(args, flag)
	if err != nil || !ok {
		return 0, false, err
	}
	value, parsed := parseJSNumber(raw)
	if !parsed || value != math.Trunc(value) || math.IsInf(value, 0) || math.IsNaN(value) {
		return 0, false, newUsageError(integerOptionMessage(flag, min))
	}
	if min != nil && value < float64(*min) {
		return 0, false, newUsageError(integerOptionMessage(flag, min))
	}
	return value, true, nil
}

func integerOptionMessage(flag string, min *int) string {
	if min == nil {
		return fmt.Sprintf("%s must be an integer", flag)
	}
	return fmt.Sprintf("%s must be an integer >= %d", flag, *min)
}

// managementCSV mirrors csv: unique, trimmed, non-empty comma items in order.
func managementCSV(value string) []string {
	seen := map[string]bool{}
	var out []string
	for _, item := range strings.Split(value, ",") {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	return out
}

// The secret-carrying options rejectArgs must never echo back (mirrors
// SECRET_OPTIONS in runtime-api.ts).
var managementSecretOptions = []string{
	"--code", "--headers", "--token", "--admin-token", "--pairing-code",
	"--credential-env", "--admin-token-env", "--pairing-code-env",
}

// managementRedactArgs replaces credential values before they are reported.
func managementRedactArgs(args []string, redactValues bool) []string {
	var out []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		inlined := false
		for _, option := range managementSecretOptions {
			if strings.HasPrefix(arg, option+"=") {
				out = append(out, option+"=<redacted>")
				inlined = true
				break
			}
		}
		if inlined {
			continue
		}
		isSecretFlag := false
		for _, option := range managementSecretOptions {
			if arg == option {
				isSecretFlag = true
				break
			}
		}
		if isSecretFlag {
			out = append(out, arg)
			valueIndex := i + 1
			if valueIndex < len(args) && args[valueIndex] == "--" {
				out = append(out, "--")
				valueIndex++
			}
			if valueIndex < len(args) {
				out = append(out, "<redacted>")
				i = valueIndex
			}
			continue
		}
		if redactValues && !strings.HasPrefix(arg, "-") {
			out = append(out, "<redacted>")
		} else {
			out = append(out, arg)
		}
	}
	return out
}

// managementRejectArgs mirrors rejectArgs: report leftover args as a usage
// error carrying the caller's USAGE block.
func managementRejectArgs(args []string, usage string, redactValues bool) error {
	if len(args) == 0 {
		return nil
	}
	shown := managementRedactArgs(args, redactValues)
	return usageErrorWith(fmt.Sprintf("Unexpected argument(s): %s", strings.Join(shown, " ")), usage)
}
