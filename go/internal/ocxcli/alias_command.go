package ocxcli

// ocx alias — the short-name surface for providers and models. This file ports
// the TypeScript owner (src/cli/alias.ts + the runtime-api error taxonomy) so
// the ownership flip keeps the documented surface identical. Both runtimes
// talk to the same management routes (/api/aliases reads, /api/default-aliases
// and /api/providers/:name/alias + /model-aliases writes), so a live proxy
// validates and persists exactly what the GUI writes.

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

const aliasUsage = `Usage:
  ocx alias list [--json]
  ocx alias set <provider> <alias>
  ocx alias set <provider>/<native-model-id> <alias>
  ocx alias rm <provider>[/<native-model-id>]
  ocx alias defaults <on|off> [--provider <name>]`

// aliasSelector mirrors the alias.ts selector(): the provider is everything
// before the first slash; a model is only present when a slash exists. ok is
// false when the parsed target cannot name a provider/model (empty provider or
// an empty model from a trailing slash).
func aliasSelector(value string) (provider string, model string, hasModel bool, ok bool) {
	slash := strings.Index(value, "/")
	if slash < 0 {
		return value, "", false, value != ""
	}
	return value[:slash], value[slash+1:], true, value[:slash] != "" && value[slash+1:] != ""
}

// runAlias implements `ocx alias`. It assumes the caller validated ownership;
// argv carries only this command's own arguments.
func runAlias(args []string, deps Deps) int {
	rest := append([]string(nil), args...)
	action := "list"
	if len(rest) > 0 {
		action = strings.ToLower(rest[0])
		rest = rest[1:]
	}
	jsonOutput := takeFlag(&rest, "--json")
	if action == "list" {
		return runAliasList(rest, jsonOutput, deps)
	}
	if action == "defaults" {
		return runAliasDefaults(rest, jsonOutput, deps)
	}
	target := ""
	if len(rest) > 0 {
		target = strings.TrimSpace(rest[0])
		rest = rest[1:]
	}
	if target == "" {
		return routingUsageError(deps, "alias target is required", aliasUsage)
	}
	provider, model, hasModel, ok := aliasSelector(target)
	if !ok {
		return routingUsageError(deps, "target must be provider or provider/native-model-id", aliasUsage)
	}
	if action == "set" {
		return runAliasSet(rest, jsonOutput, target, provider, model, hasModel, deps)
	}
	if action == "rm" {
		return runAliasRemove(rest, jsonOutput, target, provider, model, hasModel, deps)
	}
	return routingUsageError(deps, "unknown alias action '"+action+"'", aliasUsage)
}

func runAliasList(args []string, jsonOutput bool, deps Deps) int {
	rest := append([]string(nil), args...)
	if len(rest) != 0 {
		return routingUsageError(deps, routingUnexpectedArgs(rest), aliasUsage)
	}
	value, rawText, status, err := routingRoundTrip(deps, http.MethodGet, "/api/aliases", nil)
	if err == nil {
		err = routingErrorFromRoundTrip(value, rawText, status)
	}
	if err != nil {
		return routingReportError(deps, err.(routingAPIError))
	}
	lines := aliasLines(value)
	if len(lines) == 0 {
		lines = []string{"No aliases configured."}
	}
	routingPrintData(deps, value, rawText, jsonOutput, lines)
	return ExitOK
}

// aliasLines builds the human table rows in document order: one `provider`
// row per provider alias, then one `model` row per effective model alias.
func aliasLines(value *jsonwire.Value) []string {
	var lines []string
	if value == nil || value.Kind() != jsonwire.Object {
		return lines
	}
	if providers := value.Find("providers"); providers != nil && providers.Kind() == jsonwire.Object {
		for _, member := range providers.Members() {
			if member.Value == nil || member.Value.Kind() != jsonwire.String {
				continue
			}
			lines = append(lines, fmt.Sprintf("provider  %s  %s  user", member.Key, member.Value.String()))
		}
	}
	if models := value.Find("models"); models != nil && models.Kind() == jsonwire.Object {
		for _, providerRow := range models.Members() {
			if providerRow.Value == nil || providerRow.Value.Kind() != jsonwire.Object {
				continue
			}
			for _, modelRow := range providerRow.Value.Members() {
				alias, ok := stringField(modelRow.Value, "alias")
				if !ok {
					continue
				}
				source, _ := stringField(modelRow.Value, "source")
				lines = append(lines, fmt.Sprintf("model     %s/%s  %s  %s", providerRow.Key, modelRow.Key, alias, source))
			}
		}
	}
	return lines
}

func runAliasDefaults(args []string, jsonOutput bool, deps Deps) int {
	rest := append([]string(nil), args...)
	state := ""
	if len(rest) > 0 {
		state = strings.ToLower(rest[0])
		rest = rest[1:]
	}
	provider, providerGiven, err := routingTakeOption(&rest, "--provider")
	if err != nil {
		return routingUsageError(deps, err.Error(), "")
	}
	if len(rest) != 0 {
		return routingUsageError(deps, routingUnexpectedArgs(rest), aliasUsage)
	}
	if state != "on" && state != "off" {
		return routingUsageError(deps, "defaults requires on or off", aliasUsage)
	}
	body := jsonwire.ObjectValue()
	body.Set("enabled", jsonwire.BoolValue(state == "on"))
	if providerGiven {
		body.Set("provider", jsonwire.StringValue(provider))
	}
	encoded, encodeErr := body.Encode()
	if encodeErr != nil {
		fmt.Fprintln(deps.Stderr, "Error: "+encodeErr.Error())
		return ExitFailure
	}
	value, rawText, status, roundErr := routingRoundTrip(deps, http.MethodPut, "/api/default-aliases", encoded)
	if roundErr == nil {
		roundErr = routingErrorFromRoundTrip(value, rawText, status)
	}
	if roundErr != nil {
		return routingReportError(deps, roundErr.(routingAPIError))
	}
	scope := " globally"
	if providerGiven {
		scope = " for " + provider
	}
	routingPrintData(deps, value, rawText, jsonOutput, []string{fmt.Sprintf("Default aliases %s%s.", state, scope)})
	return ExitOK
}

func runAliasSet(args []string, jsonOutput bool, target, provider, model string, hasModel bool, deps Deps) int {
	rest := append([]string(nil), args...)
	alias := ""
	if len(rest) > 0 {
		alias = strings.TrimSpace(rest[0])
		rest = rest[1:]
	}
	if len(rest) != 0 {
		return routingUsageError(deps, routingUnexpectedArgs(rest), aliasUsage)
	}
	if alias == "" {
		return routingUsageError(deps, "alias value is required", aliasUsage)
	}
	body := jsonwire.ObjectValue()
	if hasModel {
		set := jsonwire.ObjectValue()
		set.Set(model, jsonwire.StringValue(alias))
		body.Set("set", set)
	} else {
		body.Set("alias", jsonwire.StringValue(alias))
	}
	path := aliasWritePath(provider, hasModel)
	return routingAliasWrite(deps, path, body, jsonOutput, target+" → "+alias)
}

func runAliasRemove(args []string, jsonOutput bool, target, provider, model string, hasModel bool, deps Deps) int {
	rest := append([]string(nil), args...)
	if len(rest) != 0 {
		return routingUsageError(deps, routingUnexpectedArgs(rest), aliasUsage)
	}
	body := jsonwire.ObjectValue()
	if hasModel {
		remove := jsonwire.EmptyArray()
		remove.AppendArray(jsonwire.StringValue(model))
		body.Set("remove", remove)
	} else {
		body.Set("alias", jsonwire.NullValue())
	}
	path := aliasWritePath(provider, hasModel)
	return routingAliasWrite(deps, path, body, jsonOutput, "Removed alias for "+target+".")
}

func aliasWritePath(provider string, hasModel bool) string {
	encoded := routingEncodePathComponent(provider)
	if hasModel {
		return "/api/providers/" + encoded + "/model-aliases"
	}
	return "/api/providers/" + encoded + "/alias"
}

func routingAliasWrite(deps Deps, path string, body *jsonwire.Value, jsonOutput bool, line string) int {
	encoded, encodeErr := body.Encode()
	if encodeErr != nil {
		fmt.Fprintln(deps.Stderr, "Error: "+encodeErr.Error())
		return ExitFailure
	}
	value, rawText, status, err := routingRoundTrip(deps, http.MethodPut, path, encoded)
	if err == nil {
		err = routingErrorFromRoundTrip(value, rawText, status)
	}
	if err != nil {
		return routingReportError(deps, err.(routingAPIError))
	}
	routingPrintData(deps, value, rawText, jsonOutput, []string{line})
	return ExitOK
}
