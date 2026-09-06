package ocxcli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

const (
	configUsage           = "Usage:\n  ocx config [show] [--json]\n  ocx config get <dot.path> [--json]\n  ocx config set <dot.path> <json-or-string> [--json]\n  ocx config unset <dot.path> [--json]\n  ocx config validate [path|-] [--json]\n  ocx config export <path|->\n  ocx config import <path|-> --yes [--json]\n"
	modelsUsage           = "Usage: ocx models [--provider <name>] [--json]\n"
	modelAddUsage         = "Usage: ocx models add <provider> <modelId> [--display-name <name>] [--context-window <tokens>] [--modalities text,image,audio] [--reasoning-efforts <none,minimal,low,medium,high,xhigh,max,ultra>] [--default-reasoning-effort <level>]"
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
	action := args[0]
	jsonOutput := takeFlag(&args, "--json")
	switch action {
	case "get":
		if len(args) != 2 {
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
		if jsonOutput || isComposite(value) {
			return writeIndentedJSON(deps.Stdout, value)
		}
		fmt.Fprintln(deps.Stdout, scalarString(value))
		return ExitOK
	case "set", "unset":
		if (action == "set" && len(args) != 3) || (action == "unset" && len(args) != 2) {
			fmt.Fprint(deps.Stderr, configUsage)
			return ExitUsage
		}
		path := args[1]
		cfg, err := loadCLIConfig()
		if err != nil {
			fmt.Fprintln(deps.Stderr, err)
			return ExitFailure
		}
		var value any
		if action == "set" {
			value = parseConfigValue(args[2])
		}
		if err := setConfigPath(cfg, path, value, action == "unset"); err != nil {
			fmt.Fprintln(deps.Stderr, err)
			return ExitUsage
		}
		if err := validateCLIConfig(cfg); err != nil {
			fmt.Fprintln(deps.Stderr, err)
			return ExitUsage
		}
		if err := config.SaveRaw(cfg); err != nil {
			fmt.Fprintln(deps.Stderr, err)
			return ExitFailure
		}
		if action == "unset" {
			value = nil
		} else {
			value, _ = configPath(cfg, path)
		}
		result := map[string]any{"ok": true, "path": path, "value": redactConfigValue(value, lastSegment(path))}
		if jsonOutput {
			return writeIndentedJSON(deps.Stdout, result)
		}
		fmt.Fprintf(deps.Stdout, "%s %s.\n", strings.Title(action), path)
		return ExitOK
	case "validate":
		if len(args) > 2 || len(args) == 2 && args[1] != "-" {
			fmt.Fprint(deps.Stderr, configUsage)
			return ExitUsage
		}
		var cfg map[string]any
		var err error
		if len(args) == 2 {
			cfg, err = readConfigInput(args[1])
		} else {
			cfg, err = loadCLIConfig()
		}
		if err == nil {
			err = validateCLIConfig(cfg)
		}
		if err != nil {
			if jsonOutput {
				writeIndentedJSON(deps.Stdout, map[string]any{"ok": false, "error": err.Error()})
			} else {
				fmt.Fprintf(deps.Stdout, "Config is invalid: %s\n", err)
			}
			return ExitFailure
		}
		if jsonOutput {
			return writeIndentedJSON(deps.Stdout, map[string]any{"ok": true})
		}
		fmt.Fprintln(deps.Stdout, "Config is valid.")
		return ExitOK
	case "export":
		if len(args) != 2 {
			fmt.Fprint(deps.Stderr, configUsage)
			return ExitUsage
		}
		cfg, err := loadCLIConfig()
		if err != nil {
			fmt.Fprintln(deps.Stderr, err)
			return ExitFailure
		}
		content, _ := json.MarshalIndent(cfg, "", "  ")
		content = append(content, '\n')
		if args[1] == "-" {
			_, _ = deps.Stdout.Write(content)
			return ExitOK
		}
		if err := os.WriteFile(args[1], content, 0o600); err != nil {
			fmt.Fprintln(deps.Stderr, err)
			return ExitFailure
		}
		fmt.Fprintf(deps.Stdout, "Exported config to %s.\n", args[1])
		return ExitOK
	case "import":
		if len(args) != 3 || args[2] != "--yes" {
			fmt.Fprint(deps.Stderr, configUsage)
			return ExitUsage
		}
		cfg, err := readConfigInput(args[1])
		if err == nil {
			err = validateCLIConfig(cfg)
		}
		if err != nil {
			fmt.Fprintln(deps.Stderr, err)
			return ExitUsage
		}
		if err := config.SaveRaw(cfg); err != nil {
			fmt.Fprintln(deps.Stderr, err)
			return ExitFailure
		}
		if jsonOutput {
			return writeIndentedJSON(deps.Stdout, map[string]any{"ok": true, "source": args[1]})
		}
		fmt.Fprintf(deps.Stdout, "Imported config from %s. Restart or run ocx sync if needed.\n", args[1])
		return ExitOK
	default:
		fmt.Fprint(deps.Stderr, configUsage)
		return ExitUsage
	}
}

func takeFlag(args *[]string, flag string) bool {
	for i, value := range *args {
		if value == flag {
			*args = append((*args)[:i], (*args)[i+1:]...)
			return true
		}
	}
	return false
}

var blockedConfigSegment = map[string]bool{"__proto__": true, "prototype": true, "constructor": true}

func configSegments(path string) ([]string, error) {
	segments := []string{}
	for _, segment := range strings.Split(path, ".") {
		segment = strings.TrimSpace(segment)
		if segment != "" {
			if blockedConfigSegment[segment] {
				return nil, errors.New("invalid config path")
			}
			segments = append(segments, segment)
		}
	}
	if len(segments) == 0 {
		return nil, errors.New("invalid config path")
	}
	return segments, nil
}
func setConfigPath(root map[string]any, path string, value any, remove bool) error {
	segments, err := configSegments(path)
	if err != nil {
		return err
	}
	current := root
	for _, segment := range segments[:len(segments)-1] {
		next, ok := current[segment].(map[string]any)
		if !ok {
			return fmt.Errorf("config parent path not found: %s", segment)
		}
		current = next
	}
	leaf := segments[len(segments)-1]
	if remove {
		if _, ok := current[leaf]; !ok {
			return fmt.Errorf("config path not found: %s", path)
		}
		delete(current, leaf)
	} else {
		current[leaf] = value
	}
	return nil
}
func parseConfigValue(raw string) any {
	var value any
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&value) == nil {
		return value
	}
	return raw
}
func readConfigInput(path string) (map[string]any, error) {
	var data []byte
	var err error
	if path == "-" {
		data, err = io.ReadAll(os.Stdin)
	} else {
		data, err = os.ReadFile(path)
	}
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	result := map[string]any{}
	if err := decoder.Decode(&result); err != nil {
		return nil, fmt.Errorf("invalid JSON in %s", path)
	}
	return result, nil
}
func validateCLIConfig(cfg map[string]any) error {
	providers, ok := cfg["providers"].(map[string]any)
	if !ok || len(providers) == 0 {
		return errors.New("schema_invalid: providers must be a non-empty object")
	}
	defaultProvider, ok := cfg["defaultProvider"].(string)
	if !ok || defaultProvider == "" {
		return errors.New("schema_invalid: defaultProvider is required")
	}
	if _, ok := providers[defaultProvider]; !ok {
		return fmt.Errorf("schema_invalid: defaultProvider %q does not exist in providers", defaultProvider)
	}
	return nil
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
	if len(args) > 0 {
		switch args[0] {
		case "add":
			return runCustomModelAdd(args[1:], deps)
		case "remove":
			return runCustomModelRemove(args[1:], deps)
		case "list-custom":
			return runCustomModelList(args[1:], deps)
		}
	}
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
		context, hasContext := provider["contextWindow"].(json.Number)
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
	// Mutating subcommands own their flags. Read-only commands retain the
	// original trailing --json parser below.
	if args[0] == "add" || args[0] == "remove" || args[0] == "set-default" {
		switch args[0] {
		case "add":
			return runProviderAdd(args[1:], deps)
		case "remove":
			return runProviderRemove(args[1:], deps)
		default:
			return runProviderSetDefault(args[1:], deps)
		}
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
			configured := []providerListRow{}
			defaultProvider, _ := cfg["defaultProvider"].(string)
			for name, raw := range providers {
				provider, _ := raw.(map[string]any)
				configured = append(configured, providerListEntry(name, provider, name == defaultProvider))
			}
			return writeIndentedJSON(deps.Stdout, providerListOutput{Configured: configured, RegistryCount: providerRegistryCount})
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

type providerListRow struct {
	Name         string `json:"name"`
	Adapter      any    `json:"adapter"`
	BaseURL      any    `json:"baseUrl"`
	AuthMode     any    `json:"authMode"`
	DefaultModel any    `json:"defaultModel"`
	IsDefault    bool   `json:"isDefault"`
	Source       string `json:"source"`
	Models       any    `json:"models"`
}
type providerListOutput struct {
	Configured    []providerListRow `json:"configured"`
	RegistryCount int               `json:"registryCount"`
}

func providerListEntry(name string, provider map[string]any, isDefault bool) providerListRow {
	return providerListRow{Name: name, Adapter: provider["adapter"], BaseURL: provider["baseUrl"], AuthMode: valueOr(provider["authMode"], "key"), DefaultModel: provider["defaultModel"], IsDefault: isDefault, Source: "custom", Models: valueOr(provider["models"], []any{})}
}

type providerShowRow struct {
	Name          string `json:"name"`
	IsDefault     bool   `json:"isDefault"`
	Adapter       any    `json:"adapter"`
	BaseURL       any    `json:"baseUrl"`
	APIKey        any    `json:"apiKey"`
	DefaultModel  any    `json:"defaultModel"`
	Models        any    `json:"models"`
	ContextWindow any    `json:"contextWindow"`
}

func providerShowEntry(name string, provider map[string]any, isDefault bool) providerShowRow {
	apiKey := provider["apiKey"]
	if text, ok := apiKey.(string); ok {
		apiKey = maskSecret(text)
	}
	return providerShowRow{Name: name, IsDefault: isDefault, Adapter: provider["adapter"], BaseURL: provider["baseUrl"], APIKey: apiKey, DefaultModel: provider["defaultModel"], Models: provider["models"], ContextWindow: provider["contextWindow"]}
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

func runProviderAdd(args []string, deps Deps) int {
	if len(args) == 0 {
		fmt.Fprintln(deps.Stderr, "Usage: ocx provider add <name> --adapter <adapter> --base-url <url> [--api-key <key>]")
		return ExitFailure
	}
	name, flags := args[0], args[1:]
	if strings.TrimSpace(name) != name || name == "" {
		fmt.Fprintf(deps.Stderr, "Invalid provider name: %q. Use letters, numbers, dots, underscores, or hyphens.\n", name)
		return ExitFailure
	}
	jsonOutput, force, setDefault := takeFlag(&flags, "--json"), takeFlag(&flags, "--force"), takeFlag(&flags, "--set-default")
	adapter, baseURL, apiKey, defaultModel := "", "", "", ""
	for len(flags) > 0 {
		if len(flags) < 2 {
			fmt.Fprintf(deps.Stderr, "Unknown flag(s): %s\n", flags[0])
			return ExitFailure
		}
		flag, value := flags[0], flags[1]
		flags = flags[2:]
		switch flag {
		case "--adapter":
			adapter = value
		case "--base-url":
			baseURL = value
		case "--api-key":
			apiKey = value
		case "--default-model":
			defaultModel = value
		default:
			fmt.Fprintf(deps.Stderr, "Unknown flag(s): %s\n", flag)
			return ExitFailure
		}
	}
	if adapter == "" || baseURL == "" {
		fmt.Fprintf(deps.Stderr, "Provider %q is not in the registry. --adapter and --base-url are required.\nUsage: ocx provider add <name> --adapter <adapter> --base-url <url> [--api-key <key>]\n", name)
		return ExitFailure
	}
	cfg, err := loadCLIConfig()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	providers, _ := cfg["providers"].(map[string]any)
	if providers == nil {
		providers = map[string]any{}
		cfg["providers"] = providers
	}
	if _, exists := providers[name]; exists && !force {
		fmt.Fprintf(deps.Stderr, "Provider %q already exists. Use --force to overwrite.\n", name)
		return ExitFailure
	}
	provider := map[string]any{"adapter": adapter, "baseUrl": baseURL}
	if apiKey != "" {
		provider["apiKey"] = apiKey
	}
	if defaultModel != "" {
		provider["defaultModel"] = defaultModel
	}
	if old, ok := providers[name].(map[string]any); ok && old["modelCosts"] != nil {
		provider["modelCosts"] = old["modelCosts"]
	}
	providers[name] = provider
	if setDefault {
		cfg["defaultProvider"] = name
	}
	if err := validateCLIConfig(cfg); err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	if err := config.SaveRaw(cfg); err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	if jsonOutput {
		return writeIndentedJSON(deps.Stdout, map[string]any{"action": "added", "provider": name, "adapter": adapter, "baseUrl": baseURL, "defaultModel": provider["defaultModel"], "isDefault": cfg["defaultProvider"] == name, "source": "custom", "needsSync": true})
	}
	fmt.Fprintf(deps.Stdout, "✅ Provider %q added.\n", name)
	if setDefault {
		fmt.Fprintln(deps.Stdout, "   Set as default provider.")
	}
	fmt.Fprintln(deps.Stdout, "   Apply to Codex: ocx sync")
	return ExitOK
}

func runProviderRemove(args []string, deps Deps) int {
	jsonOutput := takeFlag(&args, "--json")
	if len(args) != 1 {
		fmt.Fprintln(deps.Stderr, "Usage: ocx provider remove <name> [--json]")
		return ExitFailure
	}
	name := args[0]
	cfg, err := loadCLIConfig()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	providers, _ := cfg["providers"].(map[string]any)
	if _, ok := providers[name]; !ok {
		fmt.Fprintf(deps.Stderr, "Provider %q is not configured.\n", name)
		return ExitFailure
	}
	if cfg["defaultProvider"] == name {
		fmt.Fprintf(deps.Stderr, "Cannot remove %q — it is the default provider. Change the default first: ocx provider set-default <other>\n", name)
		return ExitFailure
	}
	if len(providers) <= 1 {
		fmt.Fprintln(deps.Stderr, "Cannot remove the last provider.")
		return ExitFailure
	}
	delete(providers, name)
	dropped := 0
	if models, ok := cfg["customModels"].([]any); ok {
		next := []any{}
		for _, raw := range models {
			if model, ok := raw.(map[string]any); ok && model["provider"] == name {
				dropped++
				continue
			}
			next = append(next, raw)
		}
		if len(next) == 0 {
			delete(cfg, "customModels")
		} else {
			cfg["customModels"] = next
		}
	}
	if err := config.SaveRaw(cfg); err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	if jsonOutput {
		names := []string{}
		for provider := range providers {
			names = append(names, provider)
		}
		out := map[string]any{"action": "removed", "provider": name, "remainingProviders": names, "defaultProvider": cfg["defaultProvider"], "needsSync": true}
		if dropped > 0 {
			out["droppedCustomModels"] = dropped
		}
		return writeIndentedJSON(deps.Stdout, out)
	}
	fmt.Fprintf(deps.Stdout, "✅ Provider %q removed.\n", name)
	return ExitOK
}

func runProviderSetDefault(args []string, deps Deps) int {
	jsonOutput := takeFlag(&args, "--json")
	if len(args) != 1 {
		fmt.Fprintln(deps.Stderr, "Usage: ocx provider set-default <name> [--json]")
		return ExitFailure
	}
	name := args[0]
	cfg, err := loadCLIConfig()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	providers, _ := cfg["providers"].(map[string]any)
	if _, ok := providers[name]; !ok {
		fmt.Fprintf(deps.Stderr, "Provider %q is not configured. Add it first: ocx provider add %s\n", name, name)
		return ExitFailure
	}
	if cfg["defaultProvider"] == name {
		if jsonOutput {
			return writeIndentedJSON(deps.Stdout, map[string]any{"action": "noop", "provider": name, "defaultProvider": name, "needsSync": false})
		}
		fmt.Fprintf(deps.Stdout, "%q is already the default provider.\n", name)
		return ExitOK
	}
	cfg["defaultProvider"] = name
	if err := config.SaveRaw(cfg); err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	if jsonOutput {
		return writeIndentedJSON(deps.Stdout, map[string]any{"action": "set-default", "provider": name, "defaultProvider": name, "needsSync": true})
	}
	fmt.Fprintf(deps.Stdout, "✅ Default provider set to %q.\n", name)
	return ExitOK
}

func runCustomModelAdd(args []string, deps Deps) int {
	if len(args) < 2 {
		fmt.Fprintln(deps.Stderr, "Error: provider and modelId are required")
		fmt.Fprintln(deps.Stderr, modelAddUsage)
		return ExitFailure
	}
	provider, modelID, flags := args[0], args[1], args[2:]
	if provider == "" || modelID == "" {
		fmt.Fprintln(deps.Stderr, "Error: provider and modelId are required")
		return ExitFailure
	}
	if len(flags) != 0 {
		fmt.Fprintln(deps.Stderr, "Error: Unknown flag(s): "+strings.Join(flags, ", "))
		return ExitFailure
	}
	cfg, err := loadCLIConfig()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	providers, _ := cfg["providers"].(map[string]any)
	if _, ok := providers[provider]; !ok {
		fmt.Fprintf(deps.Stderr, "Error: provider %q is not configured. See: ocx provider list\n", provider)
		return ExitFailure
	}
	models, _ := cfg["customModels"].([]any)
	slug := provider + "/" + strings.ReplaceAll(modelID, "/", "-")
	for _, raw := range models {
		if model, ok := raw.(map[string]any); ok && fmt.Sprint(model["provider"])+"/"+strings.ReplaceAll(fmt.Sprint(model["modelId"]), "/", "-") == slug {
			fmt.Fprintf(deps.Stderr, "Error: custom model %q already exists\n", slug)
			return ExitFailure
		}
	}
	id := fmt.Sprintf("go-%d", time.Now().UnixNano())
	entry := map[string]any{"id": id, "provider": provider, "modelId": modelID, "addedAt": time.Now().UTC().Format(time.RFC3339Nano)}
	cfg["customModels"] = append(models, entry)
	if err := config.SaveRaw(cfg); err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	fmt.Fprintf(deps.Stdout, "Added custom model %s (%s).\n", slug, id)
	return ExitOK
}
func runCustomModelList(args []string, deps Deps) int {
	jsonOutput := takeFlag(&args, "--json")
	if len(args) != 0 {
		fmt.Fprintln(deps.Stderr, "Error: Unknown flag(s): "+strings.Join(args, ", "))
		return ExitFailure
	}
	cfg, err := loadCLIConfig()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	models, _ := cfg["customModels"].([]any)
	if jsonOutput {
		return writeIndentedJSON(deps.Stdout, models)
	}
	if len(models) == 0 {
		fmt.Fprintln(deps.Stdout, "No custom models registered.")
		return ExitOK
	}
	for _, raw := range models {
		model := raw.(map[string]any)
		fmt.Fprintf(deps.Stdout, "%s: %s\n", model["provider"], model["modelId"])
	}
	return ExitOK
}
func runCustomModelRemove(args []string, deps Deps) int {
	confirmed := takeFlag(&args, "--yes")
	if len(args) != 1 {
		fmt.Fprintln(deps.Stderr, "Error: custom model id or provider/modelId is required")
		return ExitFailure
	}
	if !confirmed {
		fmt.Fprintln(deps.Stderr, "Error: remove requires --yes in non-interactive mode")
		return ExitFailure
	}
	target := args[0]
	cfg, err := loadCLIConfig()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	models, _ := cfg["customModels"].([]any)
	matched := -1
	for i, raw := range models {
		model, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		slug := fmt.Sprint(model["provider"]) + "/" + strings.ReplaceAll(fmt.Sprint(model["modelId"]), "/", "-")
		if fmt.Sprint(model["id"]) == target || slug == target {
			if matched >= 0 {
				fmt.Fprintf(deps.Stderr, "Error: custom model selector %q is ambiguous; use the custom model id\n", target)
				return ExitFailure
			}
			matched = i
		}
	}
	if matched < 0 {
		fmt.Fprintf(deps.Stderr, "Error: custom model %q not found\n", target)
		return ExitFailure
	}
	model := models[matched].(map[string]any)
	next := append([]any{}, models[:matched]...)
	next = append(next, models[matched+1:]...)
	if len(next) == 0 {
		delete(cfg, "customModels")
	} else {
		cfg["customModels"] = next
	}
	if err := config.SaveRaw(cfg); err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	fmt.Fprintf(deps.Stdout, "Removed custom model %s.\n", fmt.Sprint(model["provider"])+"/"+strings.ReplaceAll(fmt.Sprint(model["modelId"]), "/", "-"))
	return ExitOK
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
