// ocx system — the headless runtime-settings family (status/settings/startup/
// diagnostics/sync/codex-app-server/codex-restart/update). This file ports the
// TypeScript owner (src/cli/system-command.ts) against the same management
// routes (/api/settings, /api/startup-health, /api/system/memory,
// /api/startup-action, /api/diagnostics/project-config, /api/sync,
// /api/system/codex-app-server, /api/system/codex-restart,
// /api/update/check|run|status) with byte-identical rendering (summaryLines
// for the compact views, JSON.stringify re-emission for the envelopes) and
// the runCliAction exit-code taxonomy.
//
// `system codex-cli-update` stays TypeScript-owned behind a subcommand-level
// seam: it is a read-only local Codex install inspection that never touches
// the management plane, unlike every other subcommand here (see OwnershipFor).
package ocxcli

import (
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// systemUsage mirrors SYSTEM_USAGE in src/cli/system-command.ts.
const systemUsage = `Usage:
  ocx system [status] [--json]
  ocx system settings [--auto-start <on|off>] [--stream-mode <auto|legacy-tee|eager-relay>]
      [--desktop-authless <on|off>] [--json]
  ocx system startup <health|install-service|install-shim> [--json]
  ocx system diagnostics [--json]
  ocx system sync [--json]
  ocx system codex-app-server [--json]
  ocx system codex-restart --yes [--json]
  ocx system codex-cli-update check [--json]
  ocx system update check [--channel <latest|preview>] [--json]
  ocx system update run [--channel <latest|preview>] [--restart <on|off>] --yes [--json]
  ocx system update status <job-id> [--json]`

// runSystem implements `ocx system`. argv carries only this command's own
// arguments; codex-cli-update never reaches here (OwnershipFor delegates it).
func runSystem(args []string, deps Deps) int {
	sub := "status"
	rest := args
	if len(args) > 0 {
		sub = args[0]
		rest = args[1:]
	}
	var err error
	switch sub {
	case "status":
		err = systemStatus(rest, deps)
	case "settings":
		err = systemSettings(rest, deps)
	case "startup":
		err = systemStartup(rest, deps)
	case "diagnostics":
		err = systemDiagnostics(rest, deps)
	case "sync":
		err = systemSync(rest, deps)
	case "codex-app-server":
		err = systemCodexAppServer(rest, deps)
	case "codex-restart":
		err = systemCodexRestart(rest, deps)
	case "update":
		err = systemUpdate(rest, deps)
	default:
		err = managementCliUsage("unknown system command "+sub, systemUsage)
	}
	if err != nil {
		return reportManagementFailure(deps, err)
	}
	return ExitOK
}

// takeBoolean mirrors takeBooleanOption: --flag value must read as an on/off
// word, else the exact CliUsageError (no USAGE block).
func takeBoolean(args *[]string, flag string) (value string, present bool, err error) {
	raw, found, takeErr := takeMgmtOption(args, flag)
	if takeErr != nil {
		return "", false, takeErr
	}
	if !found {
		return "", false, nil
	}
	lower := strings.ToLower(raw)
	switch lower {
	case "on", "true", "yes", "1", "enabled":
		return raw, true, nil
	case "off", "false", "no", "0", "disabled":
		return raw, true, nil
	}
	return "", false, managementCliUsage(fmt.Sprintf("%s must be on or off", flag), "")
}

func systemStatus(argv []string, deps Deps) error {
	args := append([]string(nil), argv...)
	wantsJSON := takeMgmtFlag(&args, "--json")
	if err := rejectMgmtArgs(args, systemUsage); err != nil {
		return err
	}
	settings, rawSettings, _, err := managementRequest(deps, "GET", "/api/settings", "")
	if err != nil {
		return err
	}
	startup, rawStartup, _, err := managementRequest(deps, "GET", "/api/startup-health", "")
	if err != nil {
		return err
	}
	memory, rawMemory, _, err := managementRequest(deps, "GET", "/api/system/memory", "")
	if err != nil {
		return err
	}
	result := jsonwire.ObjectValue()
	result.Set("settings", mgmtBodyValue(settings, rawSettings))
	result.Set("startup", mgmtBodyValue(startup, rawStartup))
	result.Set("memory", mgmtBodyValue(memory, rawMemory))
	if wantsJSON {
		printManagementData(deps, result, "", true, nil)
		return nil
	}
	_ = rawSettings
	_ = rawStartup
	_ = rawMemory
	lines := summaryLines(result)
	printManagementData(deps, nil, "", false, lines)
	return nil
}

func systemSettings(argv []string, deps Deps) error {
	args := append([]string(nil), argv...)
	wantsJSON := takeMgmtFlag(&args, "--json")
	autoStart, autoStartSet, err := takeBoolean(&args, "--auto-start")
	if err != nil {
		return err
	}
	streamMode, streamModeSet, err := takeMgmtOption(&args, "--stream-mode")
	if err != nil {
		return err
	}
	desktopAuthless, desktopAuthlessSet, err := takeBoolean(&args, "--desktop-authless")
	if err != nil {
		return err
	}
	if err := rejectMgmtArgs(args, systemUsage); err != nil {
		return err
	}
	if !autoStartSet && !streamModeSet && !desktopAuthlessSet {
		result, rawText, _, readErr := managementRequest(deps, "GET", "/api/settings", "")
		if readErr != nil {
			return readErr
		}
		printManagementData(deps, result, rawText, wantsJSON, summaryLinesFor(result, rawText))
		return nil
	}
	var body strings.Builder
	body.WriteByte('{')
	first := true
	if autoStartSet {
		body.WriteString(`"codexAutoStart":`)
		body.WriteString(onOffJSON(autoStart))
		first = false
	}
	if streamModeSet {
		if !first {
			body.WriteByte(',')
		}
		body.WriteString(`"streamMode":`)
		body.WriteString(quoteJSONString(streamMode))
		first = false
	}
	if desktopAuthlessSet {
		if !first {
			body.WriteByte(',')
		}
		body.WriteString(`"codexDesktopAuthless":`)
		body.WriteString(onOffJSON(desktopAuthless))
	}
	body.WriteByte('}')
	result, _, _, writeErr := managementRequest(deps, "PUT", "/api/settings", body.String())
	if writeErr != nil {
		return writeErr
	}
	printManagementData(deps, result, "", wantsJSON, []string{"System settings updated."})
	return nil
}

// onOffJSON mirrors the TS boolean conversion of an on/off option value.
func onOffJSON(value string) string {
	lower := strings.ToLower(value)
	switch lower {
	case "true", "yes", "1", "enabled":
		return "true"
	}
	return "false"
}

func systemStartup(argv []string, deps Deps) error {
	args := append([]string(nil), argv...)
	action := "health"
	if len(args) > 0 {
		action = strings.ToLower(args[0])
		args = args[1:]
	}
	wantsJSON := takeMgmtFlag(&args, "--json")
	if err := rejectMgmtArgs(args, systemUsage); err != nil {
		return err
	}
	if action == "health" || action == "status" {
		result, rawText, _, err := managementRequest(deps, "GET", "/api/startup-health", "")
		if err != nil {
			return err
		}
		printManagementData(deps, result, rawText, wantsJSON, summaryLinesFor(result, rawText))
		return nil
	}
	if action != "install-service" && action != "install-shim" {
		return managementCliUsage("startup action must be health, install-service, or install-shim", systemUsage)
	}
	body := `{"action":` + quoteJSONString(action) + `}`
	result, _, _, err := managementRequest(deps, "POST", "/api/startup-action", body)
	if err != nil {
		return err
	}
	message := action + " complete."
	if member := result.Find("message"); member != nil && member.Kind() != jsonwire.Null {
		message = jsString(member)
	}
	printManagementData(deps, result, "", wantsJSON, []string{message})
	return nil
}

func systemDiagnostics(argv []string, deps Deps) error {
	args := append([]string(nil), argv...)
	wantsJSON := takeMgmtFlag(&args, "--json")
	if err := rejectMgmtArgs(args, systemUsage); err != nil {
		return err
	}
	result, rawText, _, err := managementRequest(deps, "GET", "/api/diagnostics/project-config", "")
	if err != nil {
		return err
	}
	printManagementData(deps, result, rawText, wantsJSON, nil)
	return nil
}

func systemSync(argv []string, deps Deps) error {
	args := append([]string(nil), argv...)
	wantsJSON := takeMgmtFlag(&args, "--json")
	if err := rejectMgmtArgs(args, systemUsage); err != nil {
		return err
	}
	result, rawText, _, err := managementRequest(deps, "POST", "/api/sync", "")
	if err != nil {
		return err
	}
	printManagementData(deps, result, rawText, wantsJSON, nil)
	return nil
}

func systemCodexAppServer(argv []string, deps Deps) error {
	args := append([]string(nil), argv...)
	wantsJSON := takeMgmtFlag(&args, "--json")
	if err := rejectMgmtArgs(args, systemUsage); err != nil {
		return err
	}
	result, rawText, _, err := managementRequest(deps, "GET", "/api/system/codex-app-server", "")
	if err != nil {
		return err
	}
	printManagementData(deps, result, rawText, wantsJSON, nil)
	return nil
}

func systemCodexRestart(argv []string, deps Deps) error {
	args := append([]string(nil), argv...)
	wantsJSON := takeMgmtFlag(&args, "--json")
	yes := takeMgmtFlag(&args, "--yes")
	if !yes {
		return managementCliUsage("system codex-restart requires --yes", systemUsage)
	}
	if err := rejectMgmtArgs(args, systemUsage); err != nil {
		return err
	}
	result, _, _, err := managementRequest(deps, "POST", "/api/system/codex-restart", "")
	if err != nil {
		return err
	}
	printManagementData(deps, result, "", wantsJSON, []string{"Codex app-server restart requested."})
	return nil
}

func systemUpdate(argv []string, deps Deps) error {
	args := append([]string(nil), argv...)
	action := "check"
	if len(args) > 0 {
		action = strings.ToLower(args[0])
		args = args[1:]
	}
	wantsJSON := takeMgmtFlag(&args, "--json")
	if action == "status" {
		jobID := ""
		if len(args) > 0 {
			jobID = args[0]
			args = args[1:]
		}
		if jobID == "" {
			return managementCliUsage("update job id is required", systemUsage)
		}
		if err := rejectMgmtArgs(args, systemUsage); err != nil {
			return err
		}
		result, rawText, _, err := managementRequest(deps, "GET", "/api/update/status?jobId="+encodeURIComponent(jobID), "")
		if err != nil {
			return err
		}
		printManagementData(deps, result, rawText, wantsJSON, nil)
		return nil
	}
	channel, channelSet, err := takeMgmtOption(&args, "--channel")
	if err != nil {
		return err
	}
	if !channelSet {
		channel = "latest"
	}
	if channel != "latest" && channel != "preview" {
		return managementCliUsage("--channel must be latest or preview", systemUsage)
	}
	if action == "check" {
		if err := rejectMgmtArgs(args, systemUsage); err != nil {
			return err
		}
		result, rawText, _, err := managementRequest(deps, "GET", "/api/update/check?tag="+channel, "")
		if err != nil {
			return err
		}
		printManagementData(deps, result, rawText, wantsJSON, nil)
		return nil
	}
	if action != "run" {
		return managementCliUsage("unknown update action "+action, systemUsage)
	}
	restartValue, restartSet, err := takeBoolean(&args, "--restart")
	if err != nil {
		return err
	}
	restart := "true"
	if restartSet {
		restart = onOffJSON(restartValue)
	}
	yes := takeMgmtFlag(&args, "--yes")
	if !yes {
		return managementCliUsage("update run requires --yes", systemUsage)
	}
	if err := rejectMgmtArgs(args, systemUsage); err != nil {
		return err
	}
	body := `{"tag":` + quoteJSONString(channel) + `,"restart":` + restart + `}`
	result, _, _, err := managementRequest(deps, "POST", "/api/update/run", body)
	if err != nil {
		return err
	}
	printManagementData(deps, result, "", wantsJSON, []string{fmt.Sprintf("Update started (%s).", channel)})
	return nil
}

// mgmtBodyValue projects a request result the way the TS runtimeRequest type
// does: a parsed JSON body stays as-is, a non-JSON body is the raw text as a
// JS string, and an empty body is null.
func mgmtBodyValue(body *jsonwire.Value, rawText string) *jsonwire.Value {
	if body != nil {
		return body
	}
	if rawText == "" {
		return jsonwire.NullValue()
	}
	return jsonwire.StringValue(rawText)
}

// encodeURIComponent mirrors the JavaScript helper for the one value the
// system family interpolates into a query string (update job ids).
func encodeURIComponent(value string) string {
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		char := value[i]
		if char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' ||
			char == '-' || char == '_' || char == '.' || char == '!' || char == '~' || char == '*' ||
			char == '\'' || char == '(' || char == ')' {
			b.WriteByte(char)
			continue
		}
		const hex = "0123456789ABCDEF"
		b.WriteByte('%')
		b.WriteByte(hex[char>>4])
		b.WriteByte(hex[char&0xf])
	}
	return b.String()
}
