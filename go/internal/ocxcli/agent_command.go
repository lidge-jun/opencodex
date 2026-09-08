package ocxcli

// ocx agent — headless multi-agent roster, effort, injection, fallback and
// sidecar settings (src/cli/agent.ts + the request-user-input helper it shares
// with inspect.ts). All verbs read/write the live management API and render
// byte-identical output to the TypeScript owner.

import (
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

const agentUsage = `Usage:
  ocx agent [status] [--json]
  ocx agent injection <status|set> [--model <id|->] [--effort <level|->]
      [--prompt <text|->] [--guidance <on|off>] [--json]
  ocx agent effort <status|set> [--main <level|->] [--subagent <level|->] [--json]
  ocx agent subagents <status|set|clear> [model,model...] [--json]
  ocx agent fallback <status|set|clear> [model,model...] [--poll-ms <5000-600000>] [--json]
  ocx agent sidecar <status|web|vision> [--list] [--model <id|->]
      [--backend web:<openai|anthropic|xai|gemini|exa|-> vision:<openai|anthropic|routed|->]
      [--reasoning <level>] [--max-descriptions <n>] [--json]
  ocx agent request-user-input [on|off] [--json]`

// inspectUsageBlock is the usage text the request-user-input and native
// integration handlers share with the inspect module; their usage errors carry
// this block, not the agent/grok blocks.
const inspectUsageBlock = `Usage:
  ocx inspect config [--json]
  ocx inspect catalog [--json]
  ocx inspect routing-analytics [--json]
  ocx inspect pacing [--name <provider>] [--json]
  ocx inspect key-providers [--json]
  ocx inspect codex-prompt [--text] [--json]
  ocx inspect client-config --client <id> [--json]
  ocx inspect star [--json]
  ocx inspect windows-tray [--json]
  ocx integration native [list] [--json]
  ocx integration native <claude|claude-desktop|codex|grok> <on|off> [--json]
  ocx agent request-user-input [on|off] [--json]`

// agentClearable mirrors the "-" -> null projection in agent.ts: a "-" value
// is reported via nullValue so the caller stores a JSON null for that key.
func agentClearable(args *[]string, flag string) (value string, given bool, nullValue bool, err error) {
	raw, ok, err := takeOption(args, flag)
	if err != nil || !ok {
		return "", false, false, err
	}
	if raw == "-" {
		return "", true, true, nil
	}
	return raw, true, false, nil
}

func agentStatus(deps Deps, argv []string) error {
	args := append([]string(nil), argv...)
	wantsJSON := takeFlag(&args, "--json")
	if err := managementRejectArgs(args, agentUsage, false); err != nil {
		return err
	}
	// Promise.all order defines the merged object's key order.
	merged := jsonwire.ObjectValue()
	for _, item := range []struct{ key, path string }{
		{"v2", "/api/v2"},
		{"injection", "/api/injection-model"},
		{"caps", "/api/effort-caps"},
		{"subagents", "/api/subagent-models"},
		{"fallback", "/api/subagent-model-fallback"},
		{"sidecars", "/api/sidecar-settings"},
	} {
		value, _, requestErr := familyManagementRequest(deps, "GET", item.path, nil)
		if requestErr != nil {
			return requestErr
		}
		merged.Set(item.key, value)
	}
	familyPrintManagementData(deps, merged, wantsJSON, managementSummaryLines(merged, "", 0))
	return nil
}

func agentInjection(deps Deps, argv []string) error {
	args := append([]string(nil), argv...)
	action := "status"
	if len(args) > 0 {
		action = strings.ToLower(args[0])
		args = args[1:]
	}
	wantsJSON := takeFlag(&args, "--json")
	if action == "status" {
		if err := managementRejectArgs(args, agentUsage, false); err != nil {
			return err
		}
		result, _, requestErr := familyManagementRequest(deps, "GET", "/api/injection-model", nil)
		if requestErr != nil {
			return requestErr
		}
		familyPrintManagementData(deps, result, wantsJSON, managementSummaryLines(result, "", 0))
		return nil
	}
	if action != "set" {
		return usageErrorWith(fmt.Sprintf("unknown injection action %s", action), agentUsage)
	}
	model, modelGiven, modelNull, err := agentClearable(&args, "--model")
	if err != nil {
		return err
	}
	effort, effortGiven, effortNull, err := agentClearable(&args, "--effort")
	if err != nil {
		return err
	}
	prompt, promptGiven, promptNull, err := agentClearable(&args, "--prompt")
	if err != nil {
		return err
	}
	guidance, guidanceGiven, err := takeBooleanOption(&args, "--guidance")
	if err != nil {
		return err
	}
	if err := managementRejectArgs(args, agentUsage, false); err != nil {
		return err
	}
	body := jsonwire.ObjectValue()
	if modelGiven {
		if modelNull {
			body.Set("model", jsonwire.NullValue())
		} else {
			body.Set("model", jsonwire.StringValue(model))
		}
	}
	if effortGiven {
		if effortNull {
			body.Set("effort", jsonwire.NullValue())
		} else {
			body.Set("effort", jsonwire.StringValue(effort))
		}
	}
	if promptGiven {
		if promptNull {
			body.Set("prompt", jsonwire.NullValue())
		} else {
			body.Set("prompt", jsonwire.StringValue(prompt))
		}
	}
	if guidanceGiven {
		body.Set("multiAgentGuidanceEnabled", jsonwire.BoolValue(guidance))
	}
	if len(body.Members()) == 0 {
		return usageErrorWith("at least one injection option is required", agentUsage)
	}
	result, _, requestErr := familyManagementRequest(deps, "PUT", "/api/injection-model", body)
	if requestErr != nil {
		return requestErr
	}
	familyPrintManagementData(deps, result, wantsJSON, []string{"Agent injection settings updated."})
	return nil
}

func agentEffort(deps Deps, argv []string) error {
	args := append([]string(nil), argv...)
	action := "status"
	if len(args) > 0 {
		action = strings.ToLower(args[0])
		args = args[1:]
	}
	wantsJSON := takeFlag(&args, "--json")
	if action == "status" {
		if err := managementRejectArgs(args, agentUsage, false); err != nil {
			return err
		}
		result, _, requestErr := familyManagementRequest(deps, "GET", "/api/effort-caps", nil)
		if requestErr != nil {
			return requestErr
		}
		familyPrintManagementData(deps, result, wantsJSON, managementSummaryLines(result, "", 0))
		return nil
	}
	if action != "set" {
		return usageErrorWith(fmt.Sprintf("unknown effort action %s", action), agentUsage)
	}
	mainLevel, mainGiven, mainNull, err := agentClearable(&args, "--main")
	if err != nil {
		return err
	}
	subagentLevel, subagentGiven, subagentNull, err := agentClearable(&args, "--subagent")
	if err != nil {
		return err
	}
	if err := managementRejectArgs(args, agentUsage, false); err != nil {
		return err
	}
	body := jsonwire.ObjectValue()
	if mainGiven {
		if mainNull {
			body.Set("effortCap", jsonwire.NullValue())
		} else {
			body.Set("effortCap", jsonwire.StringValue(mainLevel))
		}
	}
	if subagentGiven {
		if subagentNull {
			body.Set("subagentEffortCap", jsonwire.NullValue())
		} else {
			body.Set("subagentEffortCap", jsonwire.StringValue(subagentLevel))
		}
	}
	if len(body.Members()) == 0 {
		return usageErrorWith("--main and/or --subagent is required", agentUsage)
	}
	result, _, requestErr := familyManagementRequest(deps, "PUT", "/api/effort-caps", body)
	if requestErr != nil {
		return requestErr
	}
	familyPrintManagementData(deps, result, wantsJSON, []string{"Agent effort caps updated."})
	return nil
}
