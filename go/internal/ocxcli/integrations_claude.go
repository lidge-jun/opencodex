package ocxcli

// ocx integration claude — the Claude Code settings surface
// (handleClaudeConfigCommand in src/cli/integrations.ts). Only the `integration
// claude` spelling reaches Go in this slice; the `claude config` spelling
// belongs to the launcher families and stays with the TypeScript owner.

import (
	"fmt"
	"math"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

const claudeUsage = `Usage:
  ocx claude config [status] [--json]
  ocx claude config set [--enabled <on|off>] [--auth-mode <auto|proxy|subscription>]
      [--system-env <on|off>] [--fast-mode <on|off>] [--auto-context <on|off>]
      [--compact-window <tokens|default>] [--inject-agents <on|off>]
      [--small-fast-model <id|->] [--model-map <from=to,from=to|->]
      [--blocked-skills <name,name|->] [--web-model <id|->] [--web-backend <openai|anthropic|xai|gemini|exa|->]
      [--vision-model <id|->] [--vision-backend <openai|anthropic|->] [--json]`

// parseClaudeModelMap mirrors parseMap: "-" is the empty map; each pair must
// contain "=" with non-empty sides; values keep document order with the last
// duplicate winning in place (V8 property semantics).
func parseClaudeModelMap(raw string) (*jsonwire.Value, error) {
	mapValue := jsonwire.ObjectValue()
	if raw == "-" {
		return mapValue, nil
	}
	for _, pair := range strings.Split(raw, ",") {
		index := strings.Index(pair, "=")
		if index <= 0 || index == len(pair)-1 {
			return nil, usageErrorWith(fmt.Sprintf("invalid model map entry %q; use from=to", pair), claudeUsage)
		}
		mapValue.Set(strings.TrimSpace(pair[:index]), jsonwire.StringValue(strings.TrimSpace(pair[index+1:])))
	}
	return mapValue, nil
}

// claudeSidecar mirrors the local sidecar() helper: web/vision sub-objects with
// a model ("-" clears to "") and a backend ("-" clears to null).
func claudeSidecar(model string, modelGiven bool, backend string, backendGiven bool) (*jsonwire.Value, bool) {
	if !modelGiven && !backendGiven {
		return nil, false
	}
	object := jsonwire.ObjectValue()
	if modelGiven {
		if model == "-" {
			object.Set("model", jsonwire.StringValue(""))
		} else {
			object.Set("model", jsonwire.StringValue(model))
		}
	}
	if backendGiven {
		if backend == "-" {
			object.Set("backend", jsonwire.NullValue())
		} else {
			object.Set("backend", jsonwire.StringValue(backend))
		}
	}
	return object, true
}

func runClaudeConfig(args []string, deps Deps) int {
	return runManagementAction(deps, func() error {
		argv := append([]string(nil), args...)
		// TypeScript shifts the first token unconditionally.
		action := "status"
		if len(argv) > 0 {
			action = strings.ToLower(argv[0])
			argv = argv[1:]
		}
		wantsJSON := takeFlag(&argv, "--json")
		if action == "status" || action == "show" {
			if err := managementRejectArgs(argv, claudeUsage, false); err != nil {
				return err
			}
			result, _, requestErr := familyManagementRequest(deps, "GET", "/api/claude-code", nil)
			if requestErr != nil {
				return requestErr
			}
			familyPrintManagementData(deps, result, wantsJSON, managementSummaryLines(result, "", 0))
			return nil
		}
		if action != "set" {
			return usageErrorWith(fmt.Sprintf("unknown Claude config command %s", action), claudeUsage)
		}
		enabled, enabledGiven, err := takeBooleanOption(&argv, "--enabled")
		if err != nil {
			return err
		}
		authMode, authModeGiven, err := takeOption(&argv, "--auth-mode")
		if err != nil {
			return err
		}
		systemEnv, systemEnvGiven, err := takeBooleanOption(&argv, "--system-env")
		if err != nil {
			return err
		}
		fastMode, fastModeGiven, err := takeBooleanOption(&argv, "--fast-mode")
		if err != nil {
			return err
		}
		autoContext, autoContextGiven, err := takeBooleanOption(&argv, "--auto-context")
		if err != nil {
			return err
		}
		compact, compactGiven, err := takeOption(&argv, "--compact-window")
		if err != nil {
			return err
		}
		injectAgents, injectAgentsGiven, err := takeBooleanOption(&argv, "--inject-agents")
		if err != nil {
			return err
		}
		smallFastModel, smallFastGiven, err := takeOption(&argv, "--small-fast-model")
		if err != nil {
			return err
		}
		modelMap, modelMapGiven, err := takeOption(&argv, "--model-map")
		if err != nil {
			return err
		}
		blockedSkills, blockedGiven, err := takeOption(&argv, "--blocked-skills")
		if err != nil {
			return err
		}
		webModel, webModelGiven, err := takeOption(&argv, "--web-model")
		if err != nil {
			return err
		}
		webBackend, webBackendGiven, err := takeOption(&argv, "--web-backend")
		if err != nil {
			return err
		}
		visionModel, visionModelGiven, err := takeOption(&argv, "--vision-model")
		if err != nil {
			return err
		}
		visionBackend, visionBackendGiven, err := takeOption(&argv, "--vision-backend")
		if err != nil {
			return err
		}
		if err := managementRejectArgs(argv, claudeUsage, false); err != nil {
			return err
		}
		body := jsonwire.ObjectValue()
		if enabledGiven {
			body.Set("enabled", jsonwire.BoolValue(enabled))
		}
		if authModeGiven {
			body.Set("authMode", jsonwire.StringValue(authMode))
		}
		if systemEnvGiven {
			body.Set("systemEnv", jsonwire.BoolValue(systemEnv))
		}
		if fastModeGiven {
			body.Set("fastMode", jsonwire.BoolValue(fastMode))
		}
		if autoContextGiven {
			body.Set("autoContext", jsonwire.BoolValue(autoContext))
		}
		if compactGiven {
			if compact == "default" || compact == "-" {
				body.Set("autoCompactWindow", jsonwire.NullValue())
			} else {
				value, parsed := parseJSNumber(compact)
				if !parsed || value != math.Trunc(value) || value <= 0 || math.IsInf(value, 0) || math.IsNaN(value) {
					return usageErrorWith("--compact-window must be a positive integer or default", claudeUsage)
				}
				body.Set("autoCompactWindow", jsonwire.NumberFrom(value))
			}
		}
		if injectAgentsGiven {
			body.Set("injectAgents", jsonwire.BoolValue(injectAgents))
		}
		if smallFastGiven {
			if smallFastModel == "-" {
				body.Set("smallFastModel", jsonwire.StringValue(""))
			} else {
				body.Set("smallFastModel", jsonwire.StringValue(smallFastModel))
			}
		}
		if modelMapGiven {
			parsed, err := parseClaudeModelMap(modelMap)
			if err != nil {
				return err
			}
			body.Set("modelMap", parsed)
		}
		if blockedGiven {
			if blockedSkills == "-" {
				body.Set("blockedSkills", jsonwire.NullValue())
			} else {
				skills := jsonwire.EmptyArray()
				for _, skill := range managementCSV(blockedSkills) {
					skills.AppendArray(jsonwire.StringValue(skill))
				}
				body.Set("blockedSkills", skills)
			}
		}
		if web, ok := claudeSidecar(webModel, webModelGiven, webBackend, webBackendGiven); ok {
			body.Set("webSearchSidecar", web)
		}
		if vision, ok := claudeSidecar(visionModel, visionModelGiven, visionBackend, visionBackendGiven); ok {
			body.Set("visionSidecar", vision)
		}
		if len(body.Members()) == 0 {
			return usageErrorWith("at least one Claude setting is required", claudeUsage)
		}
		result, _, requestErr := familyManagementRequest(deps, "PUT", "/api/claude-code", body)
		if requestErr != nil {
			return requestErr
		}
		familyPrintManagementData(deps, result, wantsJSON, []string{"Claude Code settings updated."})
		return nil
	})
}
