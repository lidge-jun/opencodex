package ocxcli

// Management request client + output renderers — the Go mirror of
// runtimeBaseUrl/runtimeRequest and printData/summaryLines in runtime-api.ts.
//
// The body model is a parsed jsonwire tree; a non-JSON response body is wrapped
// as a jsonwire String so downstream rendering (JSON.stringify of a string, the
// responseMessage string branch) stays V8-exact without a second shape.

import (
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// managementAdminToken mirrors configuredAdminToken in src/lib/admin-secrets.ts:
// env first, then the validated admin-api-token file.
func managementAdminToken() string {
	return configuredUsageAdminToken()
}

// encodeURIComponent mirrors encodeURIComponent: every byte except the
// unreserved set is percent-encoded with uppercase hex.
func encodeURIComponent(value string) string {
	const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		c := value[i]
		if strings.IndexByte(unreserved, c) >= 0 {
			b.WriteByte(c)
		} else {
			b.WriteString(fmt.Sprintf("%%%02X", c))
		}
	}
	return b.String()
}

// managementRequest performs one management-plane request exactly like
// runtimeRequest: live-proxy discovery, admin token header, JSON body, and the
// RuntimeApiError taxonomy for unreachable and non-2xx responses. body is nil
// for requests without a payload; when set it is sent as compact JSON
// (JSON.stringify). The returned value is the parsed JSON tree (a String
// wrapping when the response body was not JSON, nil for an empty body).
func managementRequest(deps Deps, method, path string, body *jsonwire.Value) (*jsonwire.Value, int, error) {
	deps = defaults(deps)
	state, found := liveProxyEndpoint(deps)
	if !found {
		return nil, 503, newAPIError("Proxy is not running. Start it with: ocx start", 503)
	}
	var requestBody io.Reader
	if body != nil {
		encoded, err := body.Encode()
		if err != nil {
			return nil, 503, newAPIError("Management API is unreachable: "+err.Error(), 503)
		}
		requestBody = strings.NewReader(string(encoded))
	}
	request, err := http.NewRequest(method, baseURL(state)+path, requestBody)
	if err != nil {
		return nil, 503, newAPIError("Management API is unreachable: "+err.Error(), 503)
	}
	request.Header.Set("Content-Type", "application/json")
	if token := managementAdminToken(); token != "" {
		request.Header.Set("X-OpenCodex-API-Key", token)
	}
	response, err := deps.HTTPClient.Do(request)
	if err != nil {
		return nil, 503, newAPIError("Management API is unreachable: "+err.Error(), 503)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024))
	if err != nil {
		return nil, 503, newAPIError("Management API is unreachable: "+err.Error(), 503)
	}
	var value *jsonwire.Value
	if len(raw) > 0 {
		parsed, parseErr := jsonwire.Parse(raw)
		if parseErr != nil {
			value = jsonwire.StringValue(string(raw))
		} else {
			value = parsed
		}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, response.StatusCode, newAPIError(managementResponseMessage(value, response.StatusCode), response.StatusCode)
	}
	return value, response.StatusCode, nil
}

// managementResponseMessage mirrors responseMessage: a non-empty string body
// wins (truncated to 400), otherwise the error/message/detail field with
// reason/hint appended; the generic line is the fallback.
func managementResponseMessage(body *jsonwire.Value, status int) string {
	if body != nil && body.Kind() == jsonwire.String {
		if trimmed := strings.TrimSpace(body.String()); trimmed != "" {
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

// runManagementAction mirrors runCliAction: run one action, mapping usage
// errors to exit 2 (with the USAGE block) and RuntimeApiError to 4/5/1.
func runManagementAction(deps Deps, action func() error) int {
	if err := action(); err != nil {
		var usageErr *managementUsageError
		var apiErr *managementAPIError
		switch {
		case errorsAs(err, &usageErr):
			fmt.Fprintln(deps.Stderr, "Error: "+usageErr.message)
			if usageErr.usageText != "" {
				fmt.Fprintln(deps.Stderr, usageErr.usageText)
			}
			return 2
		case errorsAs(err, &apiErr):
			fmt.Fprintln(deps.Stderr, "Error: "+apiErr.message)
			switch apiErr.status {
			case 404:
				return 4
			case 409:
				return 5
			default:
				return 1
			}
		default:
			fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
			return 1
		}
	}
	return 0
}

func errorsAs(err error, target any) bool {
	switch typed := target.(type) {
	case **managementUsageError:
		if e, ok := err.(*managementUsageError); ok {
			*typed = e
			return true
		}
	case **managementAPIError:
		if e, ok := err.(*managementAPIError); ok {
			*typed = e
			return true
		}
	}
	return false
}

// ─────────────────────────────────────────────────────────────────────────────
// Output — printData and summaryLines.

// printDataIndentedJSON emits JSON.stringify(value, null, 2) bytes for one
// value. The existing writeIndentedJSON (families.go) serialises Go values with
// encoding/json; management rendering needs the V8-exact jsonwire encoder.
func printDataIndentedJSON(w io.Writer, value *jsonwire.Value) error {
	if value == nil {
		_, err := io.WriteString(w, "null")
		return err
	}
	var out strings.Builder
	if err := encodeIndentedJSON(&out, value, 0); err != nil {
		return err
	}
	_, err := io.WriteString(w, out.String())
	return err
}

// printManagementData mirrors printData: JSON.stringify(v, null, 2) when JSON
// output was requested (or no human lines exist), otherwise one console.log
// per line.
func printManagementData(deps Deps, value *jsonwire.Value, wantsJSON bool, lines []string) {
	if wantsJSON || lines == nil {
		_ = printDataIndentedJSON(deps.Stdout, value)
		fmt.Fprintln(deps.Stdout)
		return
	}
	for _, line := range lines {
		fmt.Fprintln(deps.Stdout, line)
	}
}

// jsScalarString renders a scalar the way String(value) does in TypeScript:
// numbers use V8's shortest-decimal toString (jsonwire.FormatV8Number), null
// renders "null" (reachable only for array elements / null literals), booleans
// their keyword, strings verbatim.
func jsScalarString(value *jsonwire.Value) string {
	switch value.Kind() {
	case jsonwire.Null:
		return "null"
	case jsonwire.Bool:
		if value.Bool() {
			return "true"
		}
		return "false"
	case jsonwire.Number:
		f, ok := parseJSONNumber(value.NumberRaw())
		if !ok {
			return value.NumberRaw()
		}
		return formatENUSOf(f)
	case jsonwire.Object, jsonwire.Array:
		return summaryObjectString(value)
	default:
		return value.String()
	}
}

func formatENUSOf(f float64) string {
	return jsonwire.FormatV8Number(f)
}

// jsonNumberOrNil returns the float for a Number member, else nil (mirrors the
// TS `typeof x === "number"` guards on decoded payload fields).
func jsonNumberOrNil(value *jsonwire.Value) (float64, bool) {
	if value == nil || value.Kind() != jsonwire.Number {
		return 0, false
	}
	f, ok := parseJSONNumber(value.NumberRaw())
	if !ok {
		return 0, false
	}
	return f, true
}

func jsonBoolOrNil(value *jsonwire.Value) (bool, bool) {
	if value == nil || value.Kind() != jsonwire.Bool {
		return false, false
	}
	return value.Bool(), true
}

func jsonStringOrNil(value *jsonwire.Value) (string, bool) {
	if value == nil || value.Kind() != jsonwire.String {
		return "", false
	}
	return value.String(), true
}

// isScalar reports whether a decoded value is a JSON scalar (null included),
// the `item === null || ["string","number","boolean"].includes(typeof item)`
// test summaryLines applies to array elements.
func isScalar(value *jsonwire.Value) bool {
	switch value.Kind() {
	case jsonwire.Null, jsonwire.Bool, jsonwire.Number, jsonwire.String:
		return true
	default:
		return false
	}
}

// managementSummaryLines mirrors summaryLines. Iteration order is the decoded
// document order; arrays recurse through their index keys exactly like
// Object.entries does in TypeScript.
func managementSummaryLines(value *jsonwire.Value, prefix string, depth int) []string {
	if value == nil || value.Kind() == jsonwire.Null {
		return []string{labelOrDefault(prefix) + ": null"}
	}
	switch value.Kind() {
	case jsonwire.String, jsonwire.Number, jsonwire.Bool:
		return []string{labelOrDefault(prefix) + ": " + jsScalarString(value)}
	}
	if depth > 1 {
		return []string{labelOrDefault(prefix) + ": " + summaryObjectString(value)}
	}
	var lines []string
	if value.Kind() == jsonwire.Array {
		elements := value.Elements()
		for i, element := range elements {
			label := keyedLabel(prefix, fmt.Sprintf("%d", i))
			lines = append(lines, summaryChildLines(element, label, depth)...)
		}
		return lines
	}
	for _, member := range value.Members() {
		label := keyedLabel(prefix, member.Key)
		lines = append(lines, summaryChildLines(member.Value, label, depth)...)
	}
	return lines
}

func summaryChildLines(child *jsonwire.Value, label string, depth int) []string {
	if child.Kind() == jsonwire.Array {
		scalar := true
		for _, element := range child.Elements() {
			if !isScalar(element) {
				scalar = false
				break
			}
		}
		if scalar {
			joined := make([]string, 0, len(child.Elements()))
			for _, element := range child.Elements() {
				joined = append(joined, jsScalarString(element))
			}
			text := strings.Join(joined, ", ")
			if text == "" {
				text = "none"
			}
			return []string{label + ": " + text}
		}
		return []string{fmt.Sprintf("%s: %d item(s)", label, len(child.Elements()))}
	}
	if (child.Kind() == jsonwire.Object || child.Kind() == jsonwire.Array) && depth < 1 {
		return managementSummaryLines(child, label, depth+1)
	}
	return []string{label + ": " + summaryScalarDisplay(child)}
}

func summaryScalarDisplay(child *jsonwire.Value) string {
	switch child.Kind() {
	case jsonwire.Null:
		return "-"
	case jsonwire.String:
		if child.String() == "" {
			return "-"
		}
		return child.String()
	case jsonwire.Bool:
		return jsScalarString(child)
	case jsonwire.Number:
		return jsScalarString(child)
	default:
		return summaryObjectString(child)
	}
}

// summaryObjectString renders a nested value the way String(value) does in
// TypeScript: objects become "[object Object]" and arrays join their element
// strings with commas. Reachable only for values summaryLines does not flatten.
func summaryObjectString(value *jsonwire.Value) string {
	if value.Kind() == jsonwire.Array {
		parts := make([]string, 0, len(value.Elements()))
		for _, element := range value.Elements() {
			if element.Kind() == jsonwire.Object || element.Kind() == jsonwire.Array {
				parts = append(parts, summaryObjectString(element))
			} else {
				parts = append(parts, jsScalarString(element))
			}
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

func labelOrDefault(label string) string {
	if label != "" {
		return label
	}
	return "value"
}

func keyedLabel(prefix, key string) string {
	if prefix != "" {
		return prefix + "." + key
	}
	return key
}

// requiredIntMin is a tiny helper for the common "min" closures over options.
func requiredIntMin(min int) *int { return &min }

// jsonArrayOrNil returns an Array value, or nil when the member is missing or
// not an array (the `?? []` / Array.isArray fallbacks in the client handlers).
func jsonArrayOrNil(value *jsonwire.Value) *jsonwire.Value {
	if value != nil && value.Kind() == jsonwire.Array {
		return value
	}
	return nil
}
