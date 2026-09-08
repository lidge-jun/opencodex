// ocx account login/reauth/code/cancel/reset-credits — the OAuth device-flow
// surface of the management API, Go-native port of src/cli/account-auth.ts on
// the runtime-api client (RuntimeApiError taxonomy, CliUsageError exit 2, the
// synchronous flow-block write, secret-only stdin reading). These are the
// headless login paths the ticket's "OAuth device flows" slice names; the
// top-level `ocx login` browser/key interactive flow and `ocx setup` stay with
// the TypeScript owner because neither can be byte-oracled without a live
// upstream OAuth round-trip or an interactive menu.
package ocxcli

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// accountAuthNames are the codex-family ids that share the codex-auth routes.
var accountAuthCodexNames = map[string]bool{
	"openai": true, "codex": true, "chatgpt": true,
}

// device-native providers: kimi/nous/github-copilot already run device grants,
// so --device is accepted as a no-op for them.
var accountAuthDeviceNative = map[string]bool{
	"kimi": true, "nous": true, "github-copilot": true,
}

const accountAuthArgvWarning = "warning: the authorization code was passed as a command-line argument, so it is now in your shell history and was visible in the process list while this ran. Pipe it on stdin instead, or pass `-` to read from stdin."

// authCliUsageError mirrors CliUsageError: a usage-shaped failure whose message
// is printed as "Error: <msg>" (with the usage block when set) at exit 2.
type authCliUsageError struct {
	message string
	usage   string
}

func (e authCliUsageError) Error() string { return e.message }

// authRuntimeAPIError mirrors RuntimeApiError: message already composed via
// responseMessage; the status maps to the 4/5/1 exit taxonomy.
type authRuntimeAPIError struct {
	message string
	status  int
}

func (e authRuntimeAPIError) Error() string { return e.message }

// authTrimmedString mirrors stringField.
func authTrimmedString(object *jsonwire.Value, key string) string {
	if object == nil || object.Kind() != jsonwire.Object {
		return ""
	}
	field := object.Find(key)
	if field == nil || field.Kind() != jsonwire.String {
		return ""
	}
	return strings.TrimSpace(field.String())
}

// authResponseMessage mirrors responseMessage in runtime-api.ts.
func authResponseMessage(body *jsonwire.Value, rawText string, status int) string {
	if rawText != "" {
		trimmed := strings.TrimSpace(rawText)
		if trimmed != "" {
			return authTruncate(trimmed, 400)
		}
	}
	if body == nil || body.Kind() != jsonwire.Object {
		return fmt.Sprintf("Management request failed (%d)", status)
	}
	primary := ""
	for _, key := range []string{"error", "message", "detail"} {
		if value := authTrimmedString(body, key); value != "" {
			primary = value
			break
		}
	}
	if primary == "" {
		primary = fmt.Sprintf("Management request failed (%d)", status)
	}
	parts := []string{primary}
	for _, key := range []string{"reason", "hint"} {
		if value := authTrimmedString(body, key); value != "" && value != primary {
			parts = append(parts, key+": "+value)
		}
	}
	return authTruncate(strings.Join(parts, "\n"), 1200)
}

func authTruncate(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

// authBaseURL mirrors runtimeBaseUrl: no explicit base URL means the
// identity-checked live proxy, with the runtime-api wording when absent.
func authBaseURL(acc accountDeps) (string, error) {
	if state, found := liveProxyEndpoint(acc.deps); found {
		return baseURL(state), nil
	}
	return "", authRuntimeAPIError{message: "Proxy is not running. Start it with: ocx start", status: 503}
}

// authRequest performs one management request with the runtime-api client
// contract: body JSON (nil = none), non-ok responses become RuntimeApiError
// with the responseMessage composition, transport failures name the cause.
func authRequest(acc accountDeps, baseURL, method, path string, body *jsonwire.Value) (*jsonwire.Value, error) {
	client := acc.httpClientOr()
	if client == nil {
		client = defaults(acc.deps).HTTPClient
	}
	var reader io.Reader
	if body != nil {
		encoded, err := body.Encode()
		if err != nil {
			return nil, authRuntimeAPIError{message: "Management API is unreachable: " + err.Error(), status: 503}
		}
		reader = strings.NewReader(string(encoded))
	}
	request, err := newRequestWithHeaders(method, baseURL+path, reader)
	if err != nil {
		return nil, authRuntimeAPIError{message: "Management API is unreachable: " + err.Error(), status: 503}
	}
	response, doErr := client.Do(request)
	if doErr != nil {
		return nil, authRuntimeAPIError{message: "Management API is unreachable: " + doErr.Error(), status: 503}
	}
	defer response.Body.Close()
	raw := make([]byte, 0, 4096)
	buffer := make([]byte, 32*1024)
	for {
		n, readErr := response.Body.Read(buffer)
		raw = append(raw, buffer[:n]...)
		if readErr != nil {
			break
		}
	}
	// runtimeRequest parses the text body first and only falls back to the raw
	// text when JSON parsing fails, so an object body's error/reason/hint keys
	// are read structurally rather than printed verbatim.
	rawText := string(raw)
	bodyValue, parseErr := jsonwire.Parse(raw)
	if parseErr != nil {
		bodyValue = nil
	} else {
		rawText = ""
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		message := authResponseMessage(bodyValue, rawText, response.StatusCode)
		return nil, authRuntimeAPIError{message: message, status: response.StatusCode}
	}
	return bodyValue, nil
}

// newRequestWithHeaders assembles the running-proxy request (Content-Type and
// the admin token header) exactly like runtimeRequest via runningProxyUpdateHeaders.
func newRequestWithHeaders(method, url string, reader io.Reader) (*http.Request, error) {
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token := configuredUsageAdminToken(); token != "" {
		req.Header.Set("X-OpenCodex-API-Key", token)
	}
	return req, nil
}

// authTakeOption mirrors takeOption: `${flag} requires a value` is a usage
// error without a usage block.
func authTakeOption(args *[]string, flag string) (string, bool) {
	index := -1
	for i, arg := range *args {
		if arg == flag {
			index = i
			break
		}
	}
	if index == -1 {
		return "", false
	}
	value := (*args)[index+1]
	if index+1 >= len(*args) || strings.HasPrefix(value, "--") {
		return "", true // caller reports requires-a-value
	}
	*args = append((*args)[:index], (*args)[index+2:]...)
	return value, false
}

// authTakeOptionWithSyntax mirrors takeOptionWithSyntax: both `--flag value`
// and `--flag=value`, rejecting duplicates and empty inline values.
func authTakeOptionWithSyntax(args *[]string, flag string) (value string, inline bool, ok bool, err error) {
	occurrences := 0
	for _, arg := range *args {
		if arg == flag || strings.HasPrefix(arg, flag+"=") {
			occurrences++
		}
	}
	if occurrences > 1 {
		return "", false, false, authCliUsageError{message: flag + " was given more than once"}
	}
	inlineIndex := -1
	for i, arg := range *args {
		if strings.HasPrefix(arg, flag+"=") {
			inlineIndex = i
			break
		}
	}
	if inlineIndex != -1 {
		raw := (*args)[inlineIndex]
		*args = append((*args)[:inlineIndex], (*args)[inlineIndex+1:]...)
		value = raw[len(flag)+1:]
		if value == "" {
			return "", false, false, authCliUsageError{message: flag + " requires a value"}
		}
		return value, true, true, nil
	}
	value, missing := authTakeOption(args, flag)
	if missing {
		return "", false, false, authCliUsageError{message: flag + " requires a value"}
	}
	return value, false, value != "", nil
}

// authTakeFlag mirrors takeFlag.
func authTakeFlag(args *[]string, flag string) bool {
	for i, arg := range *args {
		if arg == flag {
			*args = append((*args)[:i], (*args)[i+1:]...)
			return true
		}
	}
	return false
}

// authSecretOptions are the credential-carrying options redacted when an
// unexpected-argument error reports leftovers.
var authSecretOptions = []string{"--code", "--headers", "--token", "--admin-token", "--pairing-code", "--credential-env", "--admin-token-env", "--pairing-code-env"}

func authIsSecretOption(flag string) bool {
	for _, option := range authSecretOptions {
		if flag == option {
			return true
		}
	}
	return false
}

// authRedactSecretArgs mirrors redactSecretArgs.
func authRedactSecretArgs(args []string, redactValues bool) []string {
	var out []string
	for index := 0; index < len(args); index++ {
		arg := args[index]
		inline := ""
		for _, option := range authSecretOptions {
			if strings.HasPrefix(arg, option+"=") {
				inline = option
				break
			}
		}
		if inline != "" {
			out = append(out, inline+"=<redacted>")
			continue
		}
		if authIsSecretOption(arg) {
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
		if redactValues && !strings.HasPrefix(arg, "-") {
			out = append(out, "<redacted>")
		} else {
			out = append(out, arg)
		}
	}
	return out
}

// authRejectArgs mirrors rejectArgs: leftover args become a usage error naming
// the redacted list.
func authRejectArgs(args []string, usage string, redactValues bool) error {
	if len(args) == 0 {
		return nil
	}
	shown := authRedactSecretArgs(args, redactValues)
	return authCliUsageError{message: "Unexpected argument(s): " + strings.Join(shown, " "), usage: usage}
}

// authReadSecretLine reads one line from the process stdin, mirroring
// readSecretLine: resolve on newline or EOF, empty input is a usage error.
func authReadSecretLine(acc accountDeps, label string) (string, error) {
	var input io.Reader = os.Stdin
	if acc.stdin != nil {
		input = acc.stdin
	}
	reader := bufio.NewReader(input)
	line, err := reader.ReadString('\n')
	if err != nil && len(line) == 0 && !errors.Is(err, io.EOF) {
		return "", authCliUsageError{message: label + " input was empty"}
	}
	line = strings.TrimRight(line, "\r\n")
	if line == "" {
		return "", authCliUsageError{message: label + " input was empty"}
	}
	return strings.TrimSpace(line), nil
}

// authResolveCode mirrors resolveCode.
func authResolveCode(acc accountDeps, suppliedValue string, supplied bool, required bool) (string, error) {
	if supplied && suppliedValue != "-" {
		reportAccountStderrLine(acc, accountAuthArgvWarning)
		return suppliedValue, nil
	}
	if !supplied && !required {
		return "", nil
	}
	// A TTY gets a paste prompt on stderr; a pipe does not.
	if acc.stdinIsTTY {
		reportAccountStderrLine(acc, "Paste the redirect URL or authorization code, then press Enter:")
	}
	return authReadSecretLine(acc, "authorization code")
}

// authPrintData mirrors printData: JSON pretty when wantsJson or when no lines
// were provided, otherwise one line each.
func authPrintData(acc accountDeps, value *jsonwire.Value, wantsJSON bool, lines []string) {
	if wantsJSON || len(lines) == 0 {
		printPrettyJSON(acc.deps, value)
		return
	}
	for _, line := range lines {
		fmt.Fprintln(acc.deps.Stdout, line)
	}
}

// authWriteStdoutFully mirrors writeStdoutFully (one atomic block; partial
// writes loop, a failed write is a usage error).
func authWriteStdoutFully(acc accountDeps, text string) error {
	if acc.deps.Stdout == nil {
		acc.deps.Stdout = os.Stdout
	}
	writer := &countingWriter{w: acc.deps.Stdout}
	_, err := io.WriteString(writer, text)
	if err != nil {
		return authCliUsageError{message: "failed to write login instructions to stdout"}
	}
	return nil
}

type countingWriter struct {
	w io.Writer
}

func (c *countingWriter) Write(p []byte) (int, error) { return c.w.Write(p) }

// authRunAction mirrors runCliAction: usage errors exit 2, RuntimeApiError
// status maps 404→4, 409→5, everything else →1.
func authRunAction(acc accountDeps, action func() error) int {
	err := action()
	if err == nil {
		return 0
	}
	var usageErr authCliUsageError
	if errors.As(err, &usageErr) {
		fmt.Fprintln(acc.deps.Stderr, "Error: "+usageErr.message)
		if usageErr.usage != "" {
			fmt.Fprintln(acc.deps.Stderr, usageErr.usage)
		}
		return 2
	}
	var apiErr authRuntimeAPIError
	if errors.As(err, &apiErr) {
		fmt.Fprintln(acc.deps.Stderr, "Error: "+apiErr.message)
		switch apiErr.status {
		case 404:
			return accountExitMissing
		case 409:
			return accountExitConflict
		default:
			return 1
		}
	}
	fmt.Fprintln(acc.deps.Stderr, "Error: "+err.Error())
	return 1
}

// accountAuthLogin mirrors login() in account-auth.ts.
func accountAuthLogin(sub string, argv []string, acc accountDeps) error {
	args := make([]string, len(argv))
	copy(args, argv)
	provider := ""
	if len(args) > 0 {
		provider = strings.ToLower(strings.TrimSpace(args[0]))
		args = args[1:]
	}
	reauth := sub == "reauth" || authTakeFlag(&args, "--reauth")
	wantsJSON := authTakeFlag(&args, "--json")
	noWait := authTakeFlag(&args, "--no-wait")
	device := authTakeFlag(&args, "--device")
	id, idMissing := authTakeOption(&args, "--id")
	if idMissing {
		return authCliUsageError{message: "--id requires a value"}
	}
	codeValue, _, codeSupplied, codeErr := authTakeOptionWithSyntax(&args, "--code")
	if codeErr != nil {
		return codeErr
	}
	if provider == "" {
		return authCliUsageError{message: "provider is required", usage: accountAuthUsage}
	}
	if err := authRejectArgs(args, accountAuthUsage, false); err != nil {
		return err
	}
	if device && !accountAuthCodexNames[provider] && !accountAuthDeviceNative[provider] {
		return authCliUsageError{message: "--device is not supported for provider '" + provider + "'", usage: accountAuthUsage}
	}
	code, err := authResolveCode(acc, codeValue, codeSupplied, false)
	if err != nil {
		return err
	}

	baseURL, err := authBaseURL(acc)
	if err != nil {
		return err
	}
	if accountAuthCodexNames[provider] {
		body := jsonwire.ObjectValue()
		if id != "" {
			body.Set("id", jsonwire.StringValue(id))
		}
		if reauth {
			body.Set("reauth", jsonwire.BoolValue(true))
		}
		if device {
			body.Set("device", jsonwire.BoolValue(true))
		}
		startValue, err := authRequest(acc, baseURL, "POST", "/api/codex-auth/login", body)
		if err != nil {
			return err
		}
		start := startValue
		if !wantsJSON {
			var block []string
			if line := flowBlockURL(start); line != "" {
				block = append(block, line)
			}
			if text := authTrimmedString(start, "deviceCode"); text != "" {
				block = append(block, "Device code: "+text)
			}
			if text := authTrimmedString(start, "instructions"); text != "" {
				block = append(block, text)
			}
			if text := authTrimmedString(start, "flowId"); text != "" {
				block = append(block, "Flow: "+text)
			}
			if len(block) > 0 {
				if err := authWriteStdoutFully(acc, strings.Join(block, "\n")+"\n"); err != nil {
					return err
				}
			}
		}
		flowID := authTrimmedString(start, "flowId")
		if code != "" && flowID != "" {
			codeBody := jsonwire.ObjectValue()
			codeBody.Set("flowId", jsonwire.StringValue(flowID))
			codeBody.Set("input", jsonwire.StringValue(code))
			if _, err := authRequest(acc, baseURL, "POST", "/api/codex-auth/login/code", codeBody); err != nil {
				return err
			}
		}
		if noWait {
			if wantsJSON {
				authPrintData(acc, start, true, nil)
			}
			return nil
		}
		if flowID == "" {
			return authCliUsageError{message: "login did not return a flow id"}
		}
		return authPollCodexLogin(acc, baseURL, flowID, id, reauth, device, wantsJSON)
	}

	if id != "" && !reauth {
		return authCliUsageError{message: "--id is only valid with --reauth for provider OAuth accounts", usage: accountAuthUsage}
	}
	body := jsonwire.ObjectValue()
	body.Set("provider", jsonwire.StringValue(provider))
	if reauth {
		body.Set("addAccount", jsonwire.BoolValue(false))
		if id != "" {
			body.Set("accountId", jsonwire.StringValue(id))
			body.Set("reauth", jsonwire.BoolValue(true))
		}
	} else {
		body.Set("addAccount", jsonwire.BoolValue(true))
	}
	startValue, err := authRequest(acc, baseURL, "POST", "/api/oauth/login", body)
	if err != nil {
		return err
	}
	start := startValue
	if !wantsJSON {
		var block []string
		if line := flowBlockURL(start); line != "" {
			block = append(block, line)
		}
		if text := authTrimmedString(start, "instructions"); text != "" {
			block = append(block, text)
		}
		if text := authTrimmedString(start, "deviceCode"); text != "" {
			block = append(block, "Device code: "+text)
		}
		if len(block) > 0 {
			if err := authWriteStdoutFully(acc, strings.Join(block, "\n")+"\n"); err != nil {
				return err
			}
		}
	}
	if code != "" {
		codeBody := jsonwire.ObjectValue()
		codeBody.Set("provider", jsonwire.StringValue(provider))
		codeBody.Set("input", jsonwire.StringValue(code))
		if _, err := authRequest(acc, baseURL, "POST", "/api/oauth/login/code", codeBody); err != nil {
			return err
		}
	}
	if noWait {
		if wantsJSON {
			authPrintData(acc, start, true, nil)
		}
		return nil
	}
	return authPollOAuthLogin(acc, baseURL, provider, wantsJSON)
}

// flowBlockURL mirrors the "Open this URL to sign in:\n<url>" line.
func flowBlockURL(start *jsonwire.Value) string {
	url := authTrimmedString(start, "url")
	if url == "" {
		return ""
	}
	return "Open this URL to sign in:\n" + url
}

// authPollCodexLogin / authPollOAuthLogin mirror the 2s polling loops; the
// device-flow grants make these slow on purpose (15-minute grant), so the
// byte-diff oracle only exercises the --no-wait and error terminations.
func authPollCodexLogin(acc accountDeps, baseURL, flowID, id string, reauth, device, wantsJSON bool) error {
	maxAttempts := 150
	if device {
		maxAttempts = 480
	}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		authSleep(2)
		query := "/api/codex-auth/login-status?flowId=" + urlQueryEscape(flowID)
		if id != "" {
			query += "&accountId=" + urlQueryEscape(id)
		}
		if reauth {
			query += "&reauth=1"
		}
		state, err := authRequest(acc, baseURL, "GET", query, nil)
		if err != nil {
			return err
		}
		status := authTrimmedString(state, "status")
		if status == "done" {
			var lines []string
			line := "Logged in."
			if email := authTrimmedString(state, "email"); email != "" {
				line = "Logged in as " + email + "."
			}
			lines = append(lines, line)
			authPrintData(acc, state, wantsJSON, lines)
			if !wantsJSON {
				warnIfCodexCatalogRefreshPending(acc, state)
			}
			return nil
		}
		if status == "error" || status == "expired" {
			text := authTrimmedString(state, "error")
			if text == "" {
				text = "login " + status
			}
			return authCliUsageError{message: text}
		}
	}
	return authCliUsageError{message: "login timed out"}
}

func authPollOAuthLogin(acc accountDeps, baseURL, provider string, wantsJSON bool) error {
	for attempt := 0; attempt < 100; attempt++ {
		authSleep(2)
		state, err := authRequest(acc, baseURL, "GET", "/api/oauth/status?provider="+urlQueryEscape(provider), nil)
		if err != nil {
			return err
		}
		if text := authTrimmedString(state, "error"); text != "" {
			return authCliUsageError{message: text}
		}
		if field := state.Find("loggedIn"); field != nil && field.Kind() == jsonwire.Bool && field.Bool() {
			authPrintData(acc, state, wantsJSON, []string{"Logged in to " + provider + "."})
			return nil
		}
	}
	return authCliUsageError{message: "login timed out"}
}

func authSleep(seconds int) {
	time.Sleep(time.Duration(seconds) * time.Second)
}

// accountAuthCode mirrors code() in account-auth.ts.
func accountAuthCode(argv []string, acc accountDeps) error {
	args := make([]string, len(argv))
	copy(args, argv)
	provider := ""
	if len(args) > 0 {
		provider = strings.ToLower(strings.TrimSpace(args[0]))
		args = args[1:]
	}
	wantsJSON := authTakeFlag(&args, "--json")
	flowID, flowMissing := authTakeOption(&args, "--flow")
	if flowMissing {
		return authCliUsageError{message: "--flow requires a value"}
	}
	codeValue, _, codeSupplied, codeErr := authTakeOptionWithSyntax(&args, "--code")
	if codeErr != nil {
		return codeErr
	}
	positional := ""
	hasPositional := false
	if len(args) > 0 && !strings.HasPrefix(args[0], "--") {
		positional = args[0]
		hasPositional = true
		args = args[1:]
	}
	if provider == "" {
		return authCliUsageError{message: "provider is required", usage: accountAuthUsage}
	}
	if err := authRejectArgs(args, accountAuthUsage, true); err != nil {
		return err
	}
	if codeSupplied && hasPositional {
		return authCliUsageError{message: "pass the code either positionally or with --code, not both", usage: accountAuthUsage}
	}
	suppliedValue := ""
	supplied := codeSupplied
	if !supplied && hasPositional {
		suppliedValue = positional
		supplied = true
	} else if codeSupplied {
		suppliedValue = codeValue
	}
	input, err := authResolveCode(acc, suppliedValue, supplied, true)
	if err != nil {
		return err
	}
	if input == "" {
		return authCliUsageError{message: "provider and redirect/code are required", usage: accountAuthUsage}
	}
	codex := accountAuthCodexNames[provider]
	path := "/api/oauth/login/code"
	if codex {
		path = "/api/codex-auth/login/code"
	}
	baseURL, err := authBaseURL(acc)
	if err != nil {
		return err
	}
	if codex && flowID == "" {
		return authCliUsageError{message: "Codex login code requires --flow <flow-id>", usage: accountAuthUsage}
	}
	body := jsonwire.ObjectValue()
	if codex {
		body.Set("flowId", jsonwire.StringValue(flowID))
	} else {
		body.Set("provider", jsonwire.StringValue(provider))
	}
	body.Set("input", jsonwire.StringValue(input))
	result, err := authRequest(acc, baseURL, "POST", path, body)
	if err != nil {
		return err
	}
	authPrintData(acc, result, wantsJSON, []string{"Login code submitted."})
	return nil
}

// accountAuthCancel mirrors cancel() in account-auth.ts.
func accountAuthCancel(argv []string, acc accountDeps) error {
	args := make([]string, len(argv))
	copy(args, argv)
	provider := ""
	if len(args) > 0 {
		provider = strings.ToLower(strings.TrimSpace(args[0]))
		args = args[1:]
	}
	wantsJSON := authTakeFlag(&args, "--json")
	flowID, flowMissing := authTakeOption(&args, "--flow")
	if flowMissing {
		return authCliUsageError{message: "--flow requires a value"}
	}
	if provider == "" {
		return authCliUsageError{message: "provider is required", usage: accountAuthUsage}
	}
	if err := authRejectArgs(args, accountAuthUsage, false); err != nil {
		return err
	}
	codex := accountAuthCodexNames[provider]
	path := "/api/oauth/login/cancel"
	body := jsonwire.ObjectValue()
	if codex {
		path = "/api/codex-auth/login/cancel"
		body.Set("flowId", jsonwire.StringValue(flowID))
	} else {
		body.Set("provider", jsonwire.StringValue(provider))
	}
	baseURL, err := authBaseURL(acc)
	if err != nil {
		return err
	}
	result, err := authRequest(acc, baseURL, "POST", path, body)
	if err != nil {
		return err
	}
	authPrintData(acc, result, wantsJSON, []string{"Cancelled " + provider + " login."})
	return nil
}

// accountAuthResetCredits mirrors resetCredits().
func accountAuthResetCredits(argv []string, acc accountDeps) error {
	args := make([]string, len(argv))
	copy(args, argv)
	rawID := ""
	if len(args) > 0 {
		rawID = strings.TrimSpace(args[0])
		args = args[1:]
	}
	wantsJSON := authTakeFlag(&args, "--json")
	consume := authTakeFlag(&args, "--consume")
	yes := authTakeFlag(&args, "--yes")
	if rawID == "" {
		return authCliUsageError{message: "account id is required", usage: accountAuthUsage}
	}
	if consume && !yes {
		return authCliUsageError{message: "consuming a reset credit requires --yes", usage: accountAuthUsage}
	}
	if err := authRejectArgs(args, accountAuthUsage, false); err != nil {
		return err
	}
	accountID := rawID
	if rawID == "main" {
		accountID = mainAccountID
	}
	baseURL, err := authBaseURL(acc)
	if err != nil {
		return err
	}
	var result *jsonwire.Value
	if consume {
		body := jsonwire.ObjectValue()
		body.Set("accountId", jsonwire.StringValue(accountID))
		result, err = authRequest(acc, baseURL, "POST", "/api/codex-auth/reset-credits/consume", body)
	} else {
		result, err = authRequest(acc, baseURL, "GET", "/api/codex-auth/reset-credits?accountId="+urlQueryEscape(accountID), nil)
	}
	if err != nil {
		return err
	}
	authPrintData(acc, result, wantsJSON, nil)
	return nil
}

// runAccountAuthCommand is the runAccount-case entry for the device-flow
// subcommands; it returns the exit code from the runCliAction taxonomy.
func runAccountAuthCommand(sub string, argv []string, acc accountDeps) (int, bool) {
	var action func() error
	switch sub {
	case "login", "reauth":
		action = func() error { return accountAuthLogin(sub, argv, acc) }
	case "code":
		action = func() error { return accountAuthCode(argv, acc) }
	case "cancel":
		action = func() error { return accountAuthCancel(argv, acc) }
	case "reset-credits":
		action = func() error { return accountAuthResetCredits(argv, acc) }
	default:
		return 0, false
	}
	return authRunAction(acc, action), true
}
