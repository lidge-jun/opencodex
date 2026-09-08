package ocxcli

// ocx grok — Grok Build model selection and apply (handleGrokCommand in
// src/cli/integrations.ts). It is reachable both as the top-level `grok`
// command and as `integration grok`; both spellings dispatch here.

import (
	"fmt"
	"sort"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

const grokUsage = `Usage:
  ocx grok [status] [--json]
  ocx grok <exclude|include|set> <model,model...> [--json]
  ocx grok clear [--json]
  ocx grok apply [--json]`

// grokStateExcluded reads the /api/grok excluded list sorted like the TS
// Set-spread; the request error is returned so the caller's wrapper reports it
// through the runCliAction taxonomy.
func grokStateExcluded(deps Deps) ([]string, error) {
	state, _, requestErr := managementRequest(deps, "GET", "/api/grok", nil)
	if requestErr != nil {
		return nil, requestErr
	}
	current := map[string]bool{}
	var ordered []string
	if excluded := state.Find("excluded"); excluded != nil && excluded.Kind() == jsonwire.Array {
		for _, element := range excluded.Elements() {
			if element.Kind() == jsonwire.String && !current[element.String()] {
				current[element.String()] = true
				ordered = append(ordered, element.String())
			}
		}
	}
	sort.Strings(ordered)
	return ordered, nil
}

// runGrok implements `ocx grok [sub]`. argv carries only this command's own
// arguments (everything after the grok/integration grok token).
func runGrok(args []string, deps Deps) int {
	return runManagementAction(deps, func() error {
		argv := append([]string(nil), args...)
		// TypeScript shifts the first token unconditionally, so a leading flag
		// (for example `grok --json`) becomes the action and is rejected.
		action := "status"
		if len(argv) > 0 {
			action = strings.ToLower(argv[0])
			argv = argv[1:]
		}
		wantsJSON := takeFlag(&argv, "--json")
		if action == "status" || action == "show" {
			if err := managementRejectArgs(argv, grokUsage, false); err != nil {
				return err
			}
			result, _, requestErr := managementRequest(deps, "GET", "/api/grok", nil)
			if requestErr != nil {
				return requestErr
			}
			printManagementData(deps, result, wantsJSON, managementSummaryLines(result, "", 0))
			return nil
		}
		if action == "apply" {
			if err := managementRejectArgs(argv, grokUsage, false); err != nil {
				return err
			}
			result, _, requestErr := managementRequest(deps, "POST", "/api/grok/apply", nil)
			if requestErr != nil {
				return requestErr
			}
			message := "Grok configuration applied."
			if value := result.Find("message"); value != nil {
				message = jsScalarString(value)
			}
			printManagementData(deps, result, wantsJSON, []string{message})
			return nil
		}
		var excluded []string
		switch action {
		case "clear":
			excluded = []string{}
		case "exclude", "include", "set":
			// TypeScript takes the next token as the model list without a dash
			// guard (only --json is consumed above), so a token such as "--x" is
			// a model, not a flag.
			if len(argv) == 0 {
				return usageErrorWith("comma-separated models are required", grokUsage)
			}
			raw := argv[0]
			argv = argv[1:]
			requested := managementCSV(raw)
			if action == "set" {
				excluded = requested
			} else {
				current := map[string]bool{}
				stateExcluded, stateErr := grokStateExcluded(deps)
				if stateErr != nil {
					return stateErr
				}
				for _, model := range stateExcluded {
					current[model] = true
				}
				for _, model := range requested {
					if action == "exclude" {
						current[model] = true
					} else {
						delete(current, model)
					}
				}
				for model := range current {
					excluded = append(excluded, model)
				}
				sort.Strings(excluded)
			}
		default:
			return usageErrorWith(fmt.Sprintf("unknown Grok command %s", action), grokUsage)
		}
		if err := managementRejectArgs(argv, grokUsage, false); err != nil {
			return err
		}
		body := jsonwire.ObjectValue()
		excludedArray := jsonwire.EmptyArray()
		for _, model := range excluded {
			excludedArray.AppendArray(jsonwire.StringValue(model))
		}
		body.Set("excluded", excludedArray)
		result, _, requestErr := managementRequest(deps, "PUT", "/api/grok/selection", body)
		if requestErr != nil {
			return requestErr
		}
		message := strings.Join(excluded, ", ")
		if message == "" {
			message = "none"
		}
		printManagementData(deps, result, wantsJSON, []string{"Grok exclusions: " + message})
		return nil
	})
}

// grokHelp mirrors the TypeScript registry entry for `ocx help grok`.
const grokHelp = "Usage: ocx grok <status|exclude|include|set|clear|apply> ...\n" +
	"\n" +
	"Manage and apply the Grok Build model fence.\n"
