package ocxcli

// ocx integration native — the native client toggles (nativeIntegration in
// src/cli/inspect.ts). Usage errors carry the inspect usage block, matching the
// TypeScript handler it was extracted from.

import (
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

var nativeClients = []string{"claude", "claude-desktop", "codex", "grok"}

// jsPadEnd mirrors String.prototype.padEnd for the native table columns.
func jsPadEnd(value string, length int) string {
	width := utf8Count(value)
	if width >= length {
		return value
	}
	return value + strings.Repeat(" ", length-width)
}

func utf8Count(value string) int {
	return len([]rune(value))
}

// nativeTableLine mirrors the per-row join in nativeLines: fixed-width cells
// joined with single spaces and trailing whitespace trimmed.
func nativeTableLine(cells []string) string {
	return strings.TrimRight(strings.Join(cells, " "), " ")
}

// runNativeIntegration mirrors handleIntegrationCommand restricted to the
// native surface; `ocx integration` only routes here for the native verb.
func runNativeIntegration(args []string, deps Deps) int {
	return runManagementAction(deps, func() error {
		argv := append([]string(nil), args...)
		action := "list"
		if len(argv) > 0 && !strings.HasPrefix(argv[0], "-") {
			action = argv[0]
			argv = argv[1:]
		}
		if action == "list" {
			wantsJSON := takeFlag(&argv, "--json")
			if err := managementRejectArgs(argv, inspectUsageBlock, false); err != nil {
				return err
			}
			result, _, requestErr := familyManagementRequest(deps, "GET", "/api/native-integrations", nil)
			if requestErr != nil {
				return requestErr
			}
			familyPrintManagementData(deps, result, wantsJSON, nativeLines(result))
			return nil
		}
		known := false
		for _, client := range nativeClients {
			if action == client {
				known = true
				break
			}
		}
		if !known {
			return usageErrorWith(fmt.Sprintf("unknown native client %s; expected one of %s", action, strings.Join(nativeClients, ", ")), inspectUsageBlock)
		}
		wantsJSON := takeFlag(&argv, "--json")
		state := ""
		if len(argv) > 0 && !strings.HasPrefix(argv[0], "-") {
			state = argv[0]
			argv = argv[1:]
		}
		if err := managementRejectArgs(argv, inspectUsageBlock, false); err != nil {
			return err
		}
		if state != "on" && state != "off" {
			return usageErrorWith(fmt.Sprintf("expected on or off after %s", action), inspectUsageBlock)
		}
		body := jsonwire.ObjectValue()
		body.Set("enabled", jsonwire.BoolValue(state == "on"))
		result, _, requestErr := familyManagementRequest(deps, "PUT", "/api/native-integrations/"+action, body)
		if requestErr != nil {
			return requestErr
		}
		familyPrintManagementData(deps, result, wantsJSON, managementSummaryLines(result, "", 0))
		return nil
	})
}

// nativeLines mirrors nativeLines in inspect.ts: the fixed-width per-client
// table, with a blocked-disable note rendered below the affected row.
func nativeLines(payload *jsonwire.Value) []string {
	clients := jsonArrayOrNil(payload.Find("clients"))
	if clients == nil || len(clients.Elements()) == 0 {
		return []string{"No native client integrations reported."}
	}
	lines := []string{nativeTableLine([]string{
		jsPadEnd("CLIENT", 16), jsPadEnd("STATE", 10), jsPadEnd("INSTALLED", 10),
		jsPadEnd("DESIRED", 8), "CONFIG",
	})}
	for _, row := range clients.Elements() {
		clientID, _ := jsonStringOrNil(row.Find("clientId"))
		if clientID == "" {
			clientID = "?"
		}
		state, _ := jsonStringOrNil(row.Find("state"))
		if state == "" {
			state = "?"
		}
		installed := "?"
		if value, ok := jsonBoolOrNil(row.Find("installed")); ok {
			if value {
				installed = "yes"
			} else {
				installed = "no"
			}
		}
		desired := "?"
		if value, ok := jsonBoolOrNil(row.Find("desiredEnabled")); ok {
			if value {
				desired = "on"
			} else {
				desired = "off"
			}
		}
		configPath, _ := jsonStringOrNil(row.Find("configPath"))
		lines = append(lines, nativeTableLine([]string{
			jsPadEnd(clientID, 16), jsPadEnd(state, 10), jsPadEnd(installed, 10),
			jsPadEnd(desired, 8), configPath,
		}))
		if blocked := row.Find("disableBlocked"); blocked != nil && blocked.Kind() != jsonwire.Null {
			text := ""
			if blocked.Kind() == jsonwire.String {
				text = blocked.String()
			} else {
				encoded, err := blocked.Encode()
				if err == nil {
					text = string(encoded)
				}
			}
			lines = append(lines, "  disable blocked: "+text)
		}
	}
	return lines
}
