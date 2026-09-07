package ocxcli

// The remaining ocx agent verbs (src/cli/agent.ts): subagents/roster, fallback,
// sidecar, and request-user-input (shared with inspect.ts).

import (
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

func agentSubagents(deps Deps, argv []string) error {
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
		result, _, requestErr := managementRequest(deps, "GET", "/api/subagent-models", nil)
		if requestErr != nil {
			return requestErr
		}
		printManagementData(deps, result, wantsJSON, managementSummaryLines(result, "", 0))
		return nil
	}
	var models []string
	if action == "clear" {
		models = []string{}
	} else if action == "set" {
		if len(args) == 0 || strings.HasPrefix(args[0], "-") {
			return usageErrorWith("comma-separated subagent models are required", agentUsage)
		}
		raw := args[0]
		args = args[1:]
		models = managementCSV(raw)
	} else {
		return usageErrorWith(fmt.Sprintf("unknown subagents action %s", action), agentUsage)
	}
	if err := managementRejectArgs(args, agentUsage, false); err != nil {
		return err
	}
	if len(models) > 5 {
		return usageErrorWith("at most 5 subagent models are allowed", agentUsage)
	}
	body := jsonwire.ObjectValue()
	modelsArray := jsonwire.EmptyArray()
	for _, model := range models {
		modelsArray.AppendArray(jsonwire.StringValue(model))
	}
	body.Set("models", modelsArray)
	result, _, requestErr := managementRequest(deps, "PUT", "/api/subagent-models", body)
	if requestErr != nil {
		return requestErr
	}
	message := strings.Join(models, ", ")
	if message == "" {
		message = "cleared"
	}
	printManagementData(deps, result, wantsJSON, []string{"Subagent roster: " + message})
	return nil
}

func agentFallback(deps Deps, argv []string) error {
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
		result, _, requestErr := managementRequest(deps, "GET", "/api/subagent-model-fallback", nil)
		if requestErr != nil {
			return requestErr
		}
		printManagementData(deps, result, wantsJSON, managementSummaryLines(result, "", 0))
		return nil
	}
	body := jsonwire.ObjectValue()
	if action == "clear" {
		body.Set("models", jsonwire.EmptyArray())
	} else if action == "set" {
		if len(args) > 0 && !strings.HasPrefix(args[0], "--") {
			raw := args[0]
			args = args[1:]
			models := managementCSV(raw)
			modelsArray := jsonwire.EmptyArray()
			for _, model := range models {
				modelsArray.AppendArray(jsonwire.StringValue(model))
			}
			body.Set("models", modelsArray)
		}
	} else {
		return usageErrorWith(fmt.Sprintf("unknown fallback action %s", action), agentUsage)
	}
	pollMs, pollGiven, err := takeIntegerOption(&args, "--poll-ms", requiredIntMin(5000))
	if err != nil {
		return err
	}
	if pollGiven {
		if pollMs > 600000 {
			return usageErrorWith("--poll-ms must be <= 600000", agentUsage)
		}
		body.Set("pollMs", jsonwire.NumberFrom(pollMs))
	}
	if err := managementRejectArgs(args, agentUsage, false); err != nil {
		return err
	}
	if len(body.Members()) == 0 {
		return usageErrorWith("models and/or --poll-ms is required", agentUsage)
	}
	result, _, requestErr := managementRequest(deps, "PUT", "/api/subagent-model-fallback", body)
	if requestErr != nil {
		return requestErr
	}
	printManagementData(deps, result, wantsJSON, []string{"Subagent fallback settings updated."})
	return nil
}

// agentReadSidecarSettings performs the GET the sidecar verbs reuse.
func agentReadSidecarSettings(deps Deps) (*jsonwire.Value, error) {
	value, _, requestErr := managementRequest(deps, "GET", "/api/sidecar-settings", nil)
	return value, requestErr
}

func agentSidecar(deps Deps, argv []string) error {
	args := append([]string(nil), argv...)
	section := "status"
	// TypeScript shifts the first token unconditionally.
	if len(args) > 0 {
		section = strings.ToLower(args[0])
		args = args[1:]
	}
	wantsJSON := takeFlag(&args, "--json")
	if section == "status" {
		if err := managementRejectArgs(args, agentUsage, false); err != nil {
			return err
		}
		result, _, requestErr := managementRequest(deps, "GET", "/api/sidecar-settings", nil)
		if requestErr != nil {
			return requestErr
		}
		printManagementData(deps, result, wantsJSON, managementSummaryLines(result, "", 0))
		return nil
	}
	if section != "web" && section != "vision" {
		return usageErrorWith("sidecar must be web, vision, or status", agentUsage)
	}
	wantsList := takeFlag(&args, "--list")
	if wantsList {
		if err := managementRejectArgs(args, agentUsage, false); err != nil {
			return err
		}
		settings, requestErr := agentReadSidecarSettings(deps)
		if requestErr != nil {
			return requestErr
		}
		if section == "web" {
			optionsValue := sidecarArrayOrEmpty(settings.Find("webSearchModels"))
			var lines []string
			if len(optionsValue.Elements()) == 0 {
				lines = []string{"no runnable web-search sidecar models (log in to ChatGPT or Anthropic)"}
			} else {
				for _, option := range optionsValue.Elements() {
					value, _ := jsonStringOrNil(option.Find("value"))
					backend, _ := jsonStringOrNil(option.Find("backend"))
					authSlot, _ := jsonBoolOrNil(option.Find("authSlot"))
					line := fmt.Sprintf("%s [%s]", value, backend)
					if authSlot {
						line += " (auth slot)"
					}
					lines = append(lines, line)
				}
			}
			printManagementData(deps, optionsValue, wantsJSON, lines)
		} else {
			optionsValue := sidecarArrayOrEmpty(settings.Find("visionModels"))
			var lines []string
			if len(optionsValue.Elements()) == 0 {
				lines = []string{"no eligible vision describers"}
			} else {
				for _, option := range optionsValue.Elements() {
					value, _ := jsonStringOrNil(option.Find("value"))
					backend, backendOK := jsonStringOrNil(option.Find("backend"))
					baseline, _ := jsonBoolOrNil(option.Find("baseline"))
					line := value
					if backendOK {
						line += fmt.Sprintf(" [%s]", backend)
					}
					if baseline {
						line += " (baseline)"
					}
					lines = append(lines, line)
				}
			}
			printManagementData(deps, optionsValue, wantsJSON, lines)
		}
		return nil
	}
	model, modelGiven, err := takeOption(&args, "--model")
	if err != nil {
		return err
	}
	backend, backendGiven, err := takeOption(&args, "--backend")
	if err != nil {
		return err
	}
	reasoning, reasoningGiven, err := takeOption(&args, "--reasoning")
	if err != nil {
		return err
	}
	maxDescriptions, maxGiven, err := takeIntegerOption(&args, "--max-descriptions", requiredIntMin(1))
	if err != nil {
		return err
	}
	if err := managementRejectArgs(args, agentUsage, false); err != nil {
		return err
	}
	settings := jsonwire.ObjectValue()
	if modelGiven {
		if model == "-" {
			settings.Set("model", jsonwire.StringValue(""))
		} else {
			settings.Set("model", jsonwire.StringValue(model))
		}
	}
	if backendGiven {
		if backend == "-" {
			settings.Set("backend", jsonwire.NullValue())
		} else {
			settings.Set("backend", jsonwire.StringValue(backend))
		}
	}
	if reasoningGiven {
		settings.Set("reasoning", jsonwire.StringValue(reasoning))
	}
	if maxGiven {
		settings.Set("maxDescriptionsPerTurn", jsonwire.NumberFrom(maxDescriptions))
	}
	if len(settings.Members()) == 0 {
		return usageErrorWith("at least one sidecar option is required", agentUsage)
	}
	// A named web model is resolved against the server's offered set so the CLI
	// stores the canonical model/backend pair, exactly like the GUI picker.
	if section == "web" && modelGiven && model != "-" {
		offered, requestErr := agentReadSidecarSettings(deps)
		if requestErr != nil {
			return requestErr
		}
		requestedBackend := backend
		if backendGiven && backend == "-" {
			requestedBackend = "openai"
		}
		var matched *jsonwire.Value
		if options := offered.Find("webSearchModels"); options != nil && options.Kind() == jsonwire.Array {
			for _, candidate := range options.Elements() {
				value, _ := jsonStringOrNil(candidate.Find("value"))
				candidateModel, candidateHasModel := jsonStringOrNil(candidate.Find("model"))
				candidateBackend, _ := jsonStringOrNil(candidate.Find("backend"))
				nameMatches := value == model || (candidateHasModel && candidateModel == model)
				backendMatches := !backendGiven || candidateBackend == requestedBackend
				if nameMatches && backendMatches {
					matched = candidate
					break
				}
			}
		}
		if matched != nil {
			if resolvedModel, ok := jsonStringOrNil(matched.Find("model")); ok {
				settings.Set("model", jsonwire.StringValue(resolvedModel))
			}
			if !backendGiven || backend != "-" {
				if resolvedBackend, ok := jsonStringOrNil(matched.Find("backend")); ok {
					settings.Set("backend", jsonwire.StringValue(resolvedBackend))
				}
			}
		}
	}
	body := jsonwire.ObjectValue()
	if section == "web" {
		body.Set("webSearch", settings)
	} else {
		body.Set("vision", settings)
	}
	result, _, requestErr := managementRequest(deps, "PUT", "/api/sidecar-settings", body)
	if requestErr != nil {
		return requestErr
	}
	printManagementData(deps, result, wantsJSON, []string{fmt.Sprintf("%s sidecar settings updated.", section)})
	return nil
}

func sidecarArrayOrEmpty(value *jsonwire.Value) *jsonwire.Value {
	if value != nil && value.Kind() == jsonwire.Array {
		return value
	}
	return jsonwire.EmptyArray()
}

// agentRequestUserInput mirrors requestUserInputAction in inspect.ts. Its
// usage errors carry the inspect usage block, not the agent block.
func agentRequestUserInput(deps Deps, argv []string) error {
	args := append([]string(nil), argv...)
	wantsJSON := takeFlag(&args, "--json")
	state := ""
	if len(args) > 0 {
		state = args[0]
		args = args[1:]
	}
	if err := managementRejectArgs(args, inspectUsageBlock, false); err != nil {
		return err
	}
	const path = "/api/codex-auth/features/default-mode-request-user-input"
	if state == "" {
		result, _, requestErr := managementRequest(deps, "GET", path, nil)
		if requestErr != nil {
			return requestErr
		}
		printManagementData(deps, result, wantsJSON, managementSummaryLines(result, "", 0))
		return nil
	}
	if state != "on" && state != "off" {
		return usageErrorWith("expected on or off", inspectUsageBlock)
	}
	body := jsonwire.ObjectValue()
	body.Set("enabled", jsonwire.BoolValue(state == "on"))
	result, _, requestErr := managementRequest(deps, "PUT", path, body)
	if requestErr != nil {
		return requestErr
	}
	printManagementData(deps, result, wantsJSON, managementSummaryLines(result, "", 0))
	return nil
}

// runAgent implements `ocx agent`. It assumes the caller validated ownership;
// argv carries only this command's own arguments.
func runAgent(args []string, deps Deps) int {
	return runManagementAction(deps, func() error {
		sub := "status"
		rest := append([]string(nil), args...)
		// TypeScript destructures argv[0] unconditionally.
		if len(rest) > 0 {
			sub = rest[0]
			rest = rest[1:]
		}
		switch sub {
		case "status":
			return agentStatus(deps, rest)
		case "injection", "guidance":
			return agentInjection(deps, rest)
		case "effort":
			return agentEffort(deps, rest)
		case "subagents", "roster":
			return agentSubagents(deps, rest)
		case "fallback":
			return agentFallback(deps, rest)
		case "sidecar":
			return agentSidecar(deps, rest)
		case "request-user-input":
			return agentRequestUserInput(deps, rest)
		default:
			return usageErrorWith(fmt.Sprintf("unknown agent command %s", sub), agentUsage)
		}
	})
}

// agentHelp mirrors the TypeScript registry entry for `ocx help agent`.
const agentHelp = "Usage: ocx agent <status|injection|effort|subagents|fallback|sidecar> ...\n" +
	"\n" +
	"Manage headless multi-agent, roster, effort, injection, and sidecar settings.\n"
