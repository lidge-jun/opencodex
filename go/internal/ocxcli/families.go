package ocxcli

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

const (
	configUsage           = "Usage:\n  ocx config [show] [--json]\n  ocx config get <dot.path> [--json]\n"
	modelsUsage           = "Usage: ocx models [--provider <name>] [--json]\n"
	providerRegistryCount = 85
)

func loadCLIConfig() (map[string]any, error) {
	loaded, err := config.Load()
	if err != nil {
		return nil, err
	}
	return loaded.Raw, nil
}

func runConfig(args []string, deps Deps) int {
	if len(args) == 0 || args[0] == "show" {
		if len(args) > 0 {
			args = args[1:]
		}
		if len(args) > 1 || (len(args) == 1 && args[0] != "--json") {
			fmt.Fprint(deps.Stderr, configUsage)
			return ExitUsage
		}
		cfg, err := loadCLIConfig()
		if err != nil {
			fmt.Fprintln(deps.Stderr, err)
			return ExitFailure
		}
		return writeIndentedJSON(deps.Stdout, redactConfig(cfg))
	}
	if args[0] != "get" || len(args) < 2 || len(args) > 3 || (len(args) == 3 && args[2] != "--json") {
		fmt.Fprint(deps.Stderr, configUsage)
		return ExitUsage
	}
	cfg, err := loadCLIConfig()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	value, ok := configPath(cfg, args[1])
	if !ok {
		fmt.Fprintf(deps.Stderr, "config path not found: %s\n", args[1])
		return ExitUsage
	}
	value = redactConfigValue(value, lastSegment(args[1]))
	if len(args) == 3 || isComposite(value) {
		return writeIndentedJSON(deps.Stdout, value)
	}
	fmt.Fprintln(deps.Stdout, scalarString(value))
	return ExitOK
}

func configPath(root map[string]any, path string) (any, bool) {
	var current any = root
	for _, segment := range strings.Split(path, ".") {
		object, ok := current.(map[string]any)
		if !ok || segment == "" {
			return nil, false
		}
		current, ok = object[segment]
		if !ok {
			return nil, false
		}
	}
	return current, true
}
func lastSegment(path string) string { return path[strings.LastIndex(path, ".")+1:] }
func isComposite(value any) bool {
	_, object := value.(map[string]any)
	_, array := value.([]any)
	return object || array
}
func scalarString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	if value == nil {
		return "null"
	}
	return fmt.Sprint(value)
}

func redactConfig(value any) any { return redactConfigValue(value, "") }
func redactConfigValue(value any, key string) any {
	if isSecretKey(key) {
		if text, ok := value.(string); ok && text != "" {
			return "********"
		}
	}
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for childKey, child := range typed {
			out[childKey] = redactConfigValue(child, childKey)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i, child := range typed {
			out[i] = redactConfigValue(child, "")
		}
		return out
	default:
		return value
	}
}
func isSecretKey(key string) bool {
	switch strings.ToLower(key) {
	case "apikey", "key", "accesstoken", "refreshtoken", "idtoken", "token", "password", "clientsecret":
		return true
	}
	return false
}

func runModels(args []string, deps Deps) int {
	jsonOutput, provider, ok := parseModelsArgs(args)
	if !ok {
		fmt.Fprint(deps.Stderr, modelsUsage)
		return ExitUsage
	}
	cfg, err := loadCLIConfig()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	providers, _ := cfg["providers"].(map[string]any)
	if provider != "" {
		if _, exists := providers[provider]; !exists {
			fmt.Fprintf(deps.Stderr, "Provider %q is not configured. See: ocx provider list\n", provider)
			return ExitFailure
		}
	}
	models := collectConfiguredModels(providers, provider)
	if jsonOutput {
		return writeIndentedJSON(deps.Stdout, modelsOutput{Models: modelOutputRows(models), Note: "Static config models only. Providers with liveModels=true may have additional models at runtime."})
	}
	if len(models) == 0 {
		fmt.Fprintln(deps.Stdout, "No models found in configured providers.")
		if provider == "" {
			fmt.Fprintln(deps.Stdout, "Providers may discover models dynamically at runtime (liveModels).")
		}
		return ExitOK
	}
	defaultProvider, _ := cfg["defaultProvider"].(string)
	for _, rawModel := range models {
		model := rawModel.(map[string]any)
		name := model["provider"].(string)
		if model["first"].(bool) {
			suffix := ""
			if name == defaultProvider {
				suffix = " (default provider)"
			}
			fmt.Fprintf(deps.Stdout, "%s%s:\n", name, suffix)
		}
		marker := ""
		if model["isDefault"].(bool) {
			marker = " *"
		}
		context := ""
		if raw, ok := model["contextWindow"].(float64); ok {
			context = fmt.Sprintf(" (%dk)", int(math.Round(raw/1000)))
		}
		fmt.Fprintf(deps.Stdout, "  %s%s%s\n", model["model"], marker, context)
		if model["last"].(bool) {
			fmt.Fprintln(deps.Stdout)
		}
	}
	fmt.Fprintln(deps.Stdout, "* = default model for provider")
	fmt.Fprintln(deps.Stdout, "Note: providers with liveModels may have additional models at runtime.")
	return ExitOK
}

func parseModelsArgs(args []string) (bool, string, bool) {
	if len(args) > 0 && args[0] == "list" {
		args = args[1:]
	}
	jsonOutput, provider := false, ""
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--json":
			jsonOutput = true
		case "--provider":
			if i+1 == len(args) {
				return false, "", false
			}
			provider = args[i+1]
			i++
		default:
			return false, "", false
		}
	}
	return jsonOutput, provider, true
}
func collectConfiguredModels(providers map[string]any, filter string) []any {
	out := []any{}
	for name, raw := range providers {
		if filter != "" && name != filter {
			continue
		}
		provider, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		seen, models := map[string]bool{}, []string{}
		defaultModel, _ := provider["defaultModel"].(string)
		if defaultModel != "" {
			models = append(models, defaultModel)
		}
		if configured, ok := provider["models"].([]any); ok {
			for _, rawModel := range configured {
				if model, ok := rawModel.(string); ok {
					models = append(models, model)
				}
			}
		}
		unique := []string{}
		for _, model := range models {
			if !seen[model] {
				seen[model] = true
				unique = append(unique, model)
			}
		}
		context, hasContext := provider["contextWindow"].(float64)
		for index, model := range unique {
			window := any(nil)
			if hasContext {
				window = context
			}
			out = append(out, map[string]any{"provider": name, "model": model, "isDefault": model == defaultModel, "contextWindow": window, "inputModalities": nil, "reasoningEfforts": nil, "first": index == 0, "last": index == len(unique)-1})
		}
	}
	return out
}

type modelOutput struct {
	Provider         string `json:"provider"`
	Model            string `json:"model"`
	IsDefault        bool   `json:"isDefault"`
	ContextWindow    any    `json:"contextWindow"`
	InputModalities  any    `json:"inputModalities"`
	ReasoningEfforts any    `json:"reasoningEfforts"`
}
type modelsOutput struct {
	Models []modelOutput `json:"models"`
	Note   string        `json:"note"`
}

func modelOutputRows(models []any) []modelOutput {
	out := make([]modelOutput, 0, len(models))
	for _, raw := range models {
		model := raw.(map[string]any)
		out = append(out, modelOutput{Provider: model["provider"].(string), Model: model["model"].(string), IsDefault: model["isDefault"].(bool), ContextWindow: model["contextWindow"]})
	}
	return out
}

func runProvider(args []string, deps Deps) int {
	if len(args) == 0 || args[0] == "help" {
		fmt.Fprintln(deps.Stdout, "Usage: ocx provider <subcommand>")
		return ExitOK
	}
	jsonOutput := len(args) > 1 && args[len(args)-1] == "--json"
	if jsonOutput {
		args = args[:len(args)-1]
	}
	cfg, err := loadCLIConfig()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	providers, _ := cfg["providers"].(map[string]any)
	switch args[0] {
	case "list":
		if len(args) != 1 {
			fmt.Fprintln(deps.Stderr, "Usage: ocx provider list [--json]")
			return ExitUsage
		}
		if jsonOutput {
			configured := []any{}
			defaultProvider, _ := cfg["defaultProvider"].(string)
			for name, raw := range providers {
				provider, _ := raw.(map[string]any)
				configured = append(configured, providerListEntry(name, provider, name == defaultProvider))
			}
			return writeIndentedJSON(deps.Stdout, map[string]any{"configured": configured, "registryCount": providerRegistryCount})
		}
		fmt.Fprint(deps.Stdout, "Configured providers:\n\n")
		return ExitOK
	case "show":
		if len(args) != 2 {
			fmt.Fprintln(deps.Stderr, "Usage: ocx provider show <name> [--json]")
			return ExitUsage
		}
		name := args[1]
		raw, exists := providers[name]
		if !exists {
			fmt.Fprintf(deps.Stderr, "Provider %q is not configured.\n", name)
			return ExitFailure
		}
		provider, _ := raw.(map[string]any)
		if jsonOutput {
			return writeIndentedJSON(deps.Stdout, providerShowEntry(name, provider, name == cfg["defaultProvider"]))
		}
		fmt.Fprintf(deps.Stdout, "Provider: %s\n", name)
		return ExitOK
	default:
		fmt.Fprintf(deps.Stderr, "Unknown provider subcommand: %s\n", args[0])
		return ExitFailure
	}
}
func providerListEntry(name string, provider map[string]any, isDefault bool) map[string]any {
	return map[string]any{"name": name, "adapter": provider["adapter"], "baseUrl": provider["baseUrl"], "authMode": valueOr(provider["authMode"], "key"), "defaultModel": provider["defaultModel"], "isDefault": isDefault, "source": "custom", "models": valueOr(provider["models"], []any{})}
}
func providerShowEntry(name string, provider map[string]any, isDefault bool) map[string]any {
	out := map[string]any{"name": name, "isDefault": isDefault}
	for key, value := range provider {
		if key == "apiKey" {
			if text, ok := value.(string); ok {
				out[key] = maskSecret(text)
				continue
			}
		}
		out[key] = value
	}
	return out
}
func valueOr(value, fallback any) any {
	if value == nil {
		return fallback
	}
	return value
}
func maskSecret(value string) string {
	if len(value) <= 8 {
		return "****"
	}
	return value[:4] + "****" + value[len(value)-4:]
}
func writeIndentedJSON(writer io.Writer, value any) int {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		fmt.Fprintln(writer, err)
		return ExitFailure
	}
	fmt.Fprintln(writer, string(raw))
	return ExitOK
}
