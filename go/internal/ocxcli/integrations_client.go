package ocxcli

// ocx integration client — the reversible client-integration surface
// (handleClientIntegrationCommand in src/cli/integrations.ts). Every safety
// property (ownership, snapshots, journal, drift refusal) stays behind the
// management API, so this command is a thin caller that renders the payloads
// byte-identically.

import (
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

const clientUsage = `Usage:
  ocx integration client [status] [--client <id>] [--json]
  ocx integration client <enable|disable> --client <id> [--overwrite-conflict] [--json]
  ocx integration client history [--client <id>] [--json]
  ocx integration client restore --op <opId> [--confirm-drift] [--json]`

// clientScalarString mirrors String(v) for the operator-facing status lines.
func clientMessageField(value *jsonwire.Value, fallback string) string {
	if value == nil {
		return fallback
	}
	return jsScalarString(value)
}

func runClientIntegration(args []string, deps Deps) int {
	return runManagementAction(deps, func() error {
		argv := append([]string(nil), args...)
		// TypeScript shifts the first token unconditionally.
		action := "status"
		if len(argv) > 0 {
			action = strings.ToLower(argv[0])
			argv = argv[1:]
		}
		wantsJSON := takeFlag(&argv, "--json")

		switch action {
		case "status", "show", "list":
			client, clientGiven, err := takeOption(&argv, "--client")
			if err != nil {
				return err
			}
			if err := managementRejectArgs(argv, clientUsage, false); err != nil {
				return err
			}
			path := "/api/client-integrations"
			if clientGiven {
				path = "/api/client-integrations/" + encodeURIComponent(client)
			}
			result, _, requestErr := managementRequest(deps, "GET", path, nil)
			if requestErr != nil {
				return requestErr
			}
			var lines []string
			rows := jsonArrayOrNil(result.Find("clients"))
			if rows != nil {
				for _, row := range rows.Elements() {
					clientID, _ := jsonStringOrNil(row.Find("clientId"))
					state, _ := jsonStringOrNil(row.Find("state"))
					installed, installedOK := jsonBoolOrNil(row.Find("installed"))
					suffix := ""
					if installedOK && !installed {
						suffix = " (not installed)"
					}
					lines = append(lines, fmt.Sprintf("%s: %s%s", clientID, state, suffix))
				}
			} else {
				lines = managementSummaryLines(result, "", 0)
			}
			printManagementData(deps, result, wantsJSON, lines)
			return nil

		case "history", "journal":
			client, clientGiven, err := takeOption(&argv, "--client")
			if err != nil {
				return err
			}
			if err := managementRejectArgs(argv, clientUsage, false); err != nil {
				return err
			}
			path := "/api/client-integrations/journal"
			if clientGiven {
				path += "?client=" + encodeURIComponent(client)
			}
			result, _, requestErr := managementRequest(deps, "GET", path, nil)
			if requestErr != nil {
				return requestErr
			}
			operations := jsonArrayOrNil(result.Find("operations"))
			var lines []string
			if operations == nil || len(operations.Elements()) == 0 {
				lines = []string{"No integration operations recorded yet."}
			} else {
				for _, row := range operations.Elements() {
					at, _ := jsonStringOrNil(row.Find("at"))
					clientID, _ := jsonStringOrNil(row.Find("clientId"))
					kind, _ := jsonStringOrNil(row.Find("kind"))
					backup := "op " + jsScalarString(row.Find("opId"))
					if snapshot, ok := jsonStringOrNil(row.Find("snapshot")); ok && snapshot == "expired" {
						backup = "backup expired"
					}
					lines = append(lines, fmt.Sprintf("%s  %s  %s  (%s)", at, clientID, kind, backup))
				}
			}
			printManagementData(deps, result, wantsJSON, lines)
			return nil

		case "restore":
			opID, opGiven, err := takeOption(&argv, "--op")
			if err != nil {
				return err
			}
			if !opGiven {
				opID, opGiven, err = takeOption(&argv, "--op-id")
				if err != nil {
					return err
				}
			}
			confirmDrift := takeFlag(&argv, "--confirm-drift")
			if err := managementRejectArgs(argv, clientUsage, false); err != nil {
				return err
			}
			if !opGiven {
				return usageErrorWith("--op <opId> is required", clientUsage)
			}
			body := jsonwire.ObjectValue()
			body.Set("opId", jsonwire.StringValue(opID))
			body.Set("confirmDrift", jsonwire.BoolValue(confirmDrift))
			result, _, requestErr := managementRequest(deps, "POST", "/api/client-integrations/restore", body)
			if requestErr != nil {
				return requestErr
			}
			printManagementData(deps, result, wantsJSON, []string{clientMessageField(result.Find("message"), "Restored.")})
			return nil
		}

		if action != "enable" && action != "disable" {
			return usageErrorWith(fmt.Sprintf("unknown client integration command %s", action), clientUsage)
		}
		client, clientGiven, err := takeOption(&argv, "--client")
		if err != nil {
			return err
		}
		overwriteConflict := takeFlag(&argv, "--overwrite-conflict")
		if err := managementRejectArgs(argv, clientUsage, false); err != nil {
			return err
		}
		if !clientGiven {
			return usageErrorWith("--client <id> is required", clientUsage)
		}
		if overwriteConflict && action == "disable" {
			return usageErrorWith("--overwrite-conflict applies only to enable", clientUsage)
		}
		body := jsonwire.ObjectValue()
		if overwriteConflict {
			body.Set("enabled", jsonwire.BoolValue(true))
			body.Set("overwriteConflict", jsonwire.BoolValue(true))
		} else {
			body.Set("enabled", jsonwire.BoolValue(action == "enable"))
		}
		path := "/api/client-integrations/" + encodeURIComponent(client)
		result, _, requestErr := managementRequest(deps, "PUT", path, body)
		if requestErr != nil {
			return requestErr
		}
		message := fmt.Sprintf("%s %sd.", client, action)
		printManagementData(deps, result, wantsJSON, []string{clientMessageField(result.Find("message"), message)})
		return nil
	})
}
