package ocxcli

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/configschema"
)

const (
	configUsage           = "Usage:\n  ocx config [show] [--json] [--source]\n  ocx config get <dot.path> [--json]\n  ocx config set <dot.path> <json-or-string> [--json]\n  ocx config unset <dot.path> [--json]\n  ocx config validate [path|-] [--json]\n  ocx config export <path|->\n  ocx config import <path|-> --yes [--json]\n"
	configHelp            = "Usage: ocx config <show|get|set|unset|validate|export|import> ...\n\nInspect and safely modify validated OpenCodex configuration.\n\nSecrets are masked by show/get. Import requires --yes and validates before writing.\n"
	modelsUsage           = "Usage: ocx models [--provider <name>] [--json]\n"
	modelAddUsage         = "Usage: ocx models add <provider> <modelId> [--display-name <name>] [--context-window <tokens>] [--modalities text,image,audio] [--reasoning-efforts <none,minimal,low,medium,high,xhigh,max,ultra>] [--default-reasoning-effort <level>]"
	modelRemoveUsage      = "Usage: ocx models remove <customId|provider/modelId> [--yes]"
	providerRegistryCount = 85
)

var modelRuntimeSubcommands = map[string]Ownership{
	"live": TypeScriptOwned, "edit": TypeScriptOwned, "enable": TypeScriptOwned, "disable": TypeScriptOwned, "provider": TypeScriptOwned,
	"selected": TypeScriptOwned, "preset": TypeScriptOwned, "new-policy": TypeScriptOwned, "new-arrivals": TypeScriptOwned,
	"context": TypeScriptOwned, "shadow": TypeScriptOwned,
}

// Writes retain the TypeScript owner until Go participates in the shared
// config-mutation.sqlite generation transaction.
var configRuntimeSubcommands = map[string]Ownership{
	"show": GoOwned, "validate": GoOwned, "export": GoOwned,
	"set": GoOwned, "unset": GoOwned, "import": GoOwned,
}

func loadCLIConfig() (map[string]any, error) {
	loaded, err := config.Load()
	if err != nil {
		return nil, err
	}
	return loaded.Raw, nil
}

func runConfig(args []string, deps Deps) int {
	action := "show"
	if len(args) > 0 && args[0] != "--json" && args[0] != "--source" {
		action, args = strings.ToLower(args[0]), args[1:]
	}
	switch action {
	case "show":
		return runNativeConfigShow(args, deps)
	case "validate":
		return runNativeConfigValidate(args, deps)
	case "export":
		return runNativeConfigExport(args, deps)
	case "set", "unset":
		return runNativeConfigSet(args, action == "unset", deps)
	case "import":
		return runNativeConfigImport(args, deps)
	default:
		return configWriteUsageError(deps, "unknown config command "+action)
	}
}

func configWriteError(deps Deps, message string, usage bool) int {
	fmt.Fprintf(deps.Stderr, "Error: %s\n", message)
	if usage {
		fmt.Fprint(deps.Stderr, configUsage)
		return configWriteUsageExit
	}
	return ExitFailure
}

func configWriteUsageError(deps Deps, message string) int {
	return configWriteError(deps, message, true)
}

func configWriteValidationError(deps Deps, message string) int {
	fmt.Fprintf(deps.Stderr, "Error: %s\n", message)
	return configWriteUsageExit
}

func runNativeConfigSet(args []string, remove bool, deps Deps) int {
	jsonOutput := takeFlag(&args, "--json")
	if len(args) == 0 || (!remove && len(args) == 1) {
		return configWriteUsageError(deps, "config path and value are required")
	}
	path := args[0]
	args = args[1:]
	rawValue := ""
	if !remove {
		rawValue = args[0]
		args = args[1:]
	}
	if len(args) != 0 {
		return configWriteUsageError(deps, "Unexpected argument(s): "+strings.Join(args, " "))
	}
	configPath, err := config.Path()
	if err != nil {
		return configWriteError(deps, err.Error(), false)
	}
	if _, err := os.Stat(configPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return configWriteError(deps, "config is missing", false)
		}
		return configWriteError(deps, err.Error(), false)
	}
	var saved *configschema.Normalized
	_, err = configschema.WithRevalidatedConfigMutation(context.Background(), configPath, nil, func(raw []byte, _ int64) ([]byte, bool, error) {
		updated, value, changed, mutationErr := configschema.ApplyConfigPathMutation(raw, path, rawValue, remove)
		if mutationErr != nil {
			return nil, false, mutationErr
		}
		if !remove {
			_ = value // ApplyConfigPathMutation verifies the saved path; display must redact it.
			display, displayErr := updated.ConfigPathValue(path)
			if displayErr != nil {
				return nil, false, displayErr
			}
			saved = display
		}
		data, encodeErr := updated.IndentedJSON()
		if encodeErr != nil {
			return nil, false, encodeErr
		}
		return append(data, '\n'), changed, nil
	})
	if err != nil {
		return reportNativeConfigWriteError(deps, err)
	}
	value := json.RawMessage("null")
	if !remove && saved != nil {
		data, encodeErr := saved.CompactJSON()
		if encodeErr != nil {
			return configWriteError(deps, encodeErr.Error(), false)
		}
		value = data
	}
	if jsonOutput {
		return writeNativeConfigJSON(deps.Stdout, struct {
			OK    bool            `json:"ok"`
			Path  string          `json:"path"`
			Value json.RawMessage `json:"value"`
		}{true, path, value})
	}
	if remove {
		fmt.Fprintf(deps.Stdout, "Unset %s.\n", path)
	} else {
		fmt.Fprintf(deps.Stdout, "Set %s.\n", path)
	}
	return ExitOK
}

func reportNativeConfigWriteError(deps Deps, err error) int {
	if errors.Is(err, configschema.ErrRawByteConflict) {
		return configWriteError(deps, "config changed while applying this update; retry", false)
	}
	if errors.Is(err, configschema.ErrMutationBusy) {
		return configWriteError(deps, "Config mutation already in progress", false)
	}
	if errors.Is(err, os.ErrNotExist) {
		return configWriteError(deps, "config is missing", false)
	}
	message := err.Error()
	if strings.HasPrefix(message, "invalid JSON:") {
		return configWriteError(deps, "config is invalid", false)
	}
	if message == "invalid config path" || strings.HasPrefix(message, "config parent path not found:") || strings.HasPrefix(message, "config path not found:") {
		return configWriteUsageError(deps, message)
	}
	if strings.HasPrefix(message, "schema_invalid:") {
		return configWriteValidationError(deps, message)
	}
	return configWriteError(deps, message, false)
}

func runNativeConfigImport(args []string, deps Deps) int {
	jsonOutput := takeFlag(&args, "--json")
	if len(args) == 0 {
		return configWriteUsageError(deps, "import path is required")
	}
	path := args[0]
	args = args[1:]
	yes := takeFlag(&args, "--yes")
	if !yes {
		return configWriteUsageError(deps, "import requires --yes")
	}
	if len(args) != 0 {
		return configWriteUsageError(deps, "Unexpected argument(s): "+strings.Join(args, " "))
	}
	raw, err := readConfigInputBytes(path)
	if err != nil {
		if strings.HasPrefix(err.Error(), "invalid JSON in ") {
			return configWriteValidationError(deps, err.Error())
		}
		return configWriteError(deps, err.Error(), false)
	}
	candidate, err := configschema.ValidateCandidateJSON(raw)
	if err != nil {
		return configWriteValidationError(deps, err.Error())
	}
	configPath, err := config.Path()
	if err != nil {
		return configWriteError(deps, err.Error(), false)
	}
	if _, err := configschema.ReplaceConfigCandidate(context.Background(), configPath, candidate); err != nil {
		if errors.Is(err, configschema.ErrMutationBusy) {
			return configWriteError(deps, "Config mutation already in progress", false)
		}
		return configWriteError(deps, err.Error(), false)
	}
	if jsonOutput {
		return writeNativeConfigJSON(deps.Stdout, struct {
			OK     bool   `json:"ok"`
			Source string `json:"source"`
		}{true, path})
	}
	fmt.Fprintf(deps.Stdout, "Imported config from %s. Restart or run ocx sync if needed.\n", path)
	return ExitOK
}

func readConfigInputBytes(path string) ([]byte, error) {
	var raw []byte
	var err error
	if path == "-" {
		raw, err = io.ReadAll(os.Stdin)
	} else {
		raw, err = os.ReadFile(path)
	}
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("ENOENT: no such file or directory, open %q", path)
		}
		return nil, err
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("invalid JSON in %s", path)
	}
	return raw, nil
}

type configSourceOutput struct {
	Config   json.RawMessage `json:"config"`
	Source   string          `json:"source"`
	Error    any             `json:"error"`
	Warnings []string        `json:"warnings"`
}

func readNativeConfig() (*configschema.Normalized, []byte, string, error) {
	path, err := config.Path()
	if err != nil {
		return nil, nil, "", err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, path, err
	}
	normalized, err := configschema.ValidateCandidateJSON(raw)
	if err != nil {
		return nil, nil, path, err
	}
	return normalized, raw, path, nil
}

func runNativeConfigShow(args []string, deps Deps) int {
	_ = takeFlag(&args, "--json")
	source := takeFlag(&args, "--source")
	if len(args) != 0 {
		fmt.Fprint(deps.Stderr, configUsage)
		return ExitUsage
	}
	normalized, _, _, err := readNativeConfig()
	if err != nil {
		delegateArgs := []string{"config", "show"}
		if source {
			delegateArgs = append(delegateArgs, "--source")
		}
		return runDelegated(delegateArgs, deps)
	}
	data, err := normalized.RedactedIndentedJSON()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	if !source {
		_, _ = deps.Stdout.Write(append(data, '\n'))
		return ExitOK
	}
	return writeNativeConfigJSON(deps.Stdout, configSourceOutput{Config: json.RawMessage(data), Source: "file", Error: nil, Warnings: []string{}})
}

func runNativeConfigValidate(args []string, deps Deps) int {
	jsonOutput := takeFlag(&args, "--json")
	if len(args) > 1 {
		fmt.Fprint(deps.Stderr, configUsage)
		return ExitUsage
	}
	path := ""
	var raw []byte
	var err error
	if len(args) == 1 {
		path = args[0]
		if path == "-" {
			raw, err = io.ReadAll(os.Stdin)
		} else {
			raw, err = os.ReadFile(path)
		}
	} else {
		_, raw, path, err = readNativeConfig()
	}
	if err == nil {
		_, err = configschema.ValidateCandidateJSON(raw)
	}
	if err != nil {
		if len(args) == 0 {
			return runDelegated([]string{"config", "validate"}, deps)
		}
		return reportNativeConfigValidation(deps, jsonOutput, false, "", err.Error())
	}
	return reportNativeConfigValidation(deps, jsonOutput, true, path, "")
}

func reportNativeConfigValidation(deps Deps, jsonOutput, valid bool, source, message string) int {
	if jsonOutput {
		if valid {
			return writeNativeConfigJSON(deps.Stdout, struct {
				OK     bool   `json:"ok"`
				Source string `json:"source"`
			}{true, source})
		}
		_ = writeNativeConfigJSON(deps.Stdout, struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}{false, message})
	} else if valid {
		fmt.Fprintln(deps.Stdout, "Config is valid.")
	} else {
		fmt.Fprintf(deps.Stdout, "Config is invalid: %s\n", message)
	}
	if valid || jsonOutput {
		return ExitOK
	}
	return ExitFailure
}

func runNativeConfigExport(args []string, deps Deps) int {
	if len(args) != 1 {
		fmt.Fprint(deps.Stderr, configUsage)
		return ExitUsage
	}
	normalized, _, _, err := readNativeConfig()
	if err != nil {
		return runDelegated(append([]string{"config", "export"}, args...), deps)
	}
	data, err := normalized.IndentedJSON()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	data = append(data, '\n')
	if args[0] == "-" {
		_, _ = deps.Stdout.Write(data)
		return ExitOK
	}
	if err := os.WriteFile(args[0], data, 0o600); err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	fmt.Fprintf(deps.Stdout, "Exported config to %s.\n", args[0])
	return ExitOK
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
		if modelRuntimeSubcommands[args[0]] == TypeScriptOwned {
			// These commands are management-API clients, not config projections. The
			// TypeScript owner already supplies their authenticated API transaction and
			// exact user-facing output; preserving that owner avoids a second client
			// with divergent request/response semantics during the takeover.
			return runDelegated(append([]string{"models"}, args...), deps)
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
		context := formatContextWindow(model["contextWindow"])
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
		for index, model := range unique {
			window := modelRecordValue(provider["modelContextWindows"], model)
			if window == nil {
				window = provider["contextWindow"]
			}
			modalities := modelRecordValue(provider["modelInputModalities"], model)
			if modelInList(provider["noVisionModels"], model) {
				modalities = []any{"text"}
			}
			efforts := configuredModelReasoningEfforts(provider, model)
			out = append(out, map[string]any{"provider": name, "model": model, "isDefault": model == defaultModel, "contextWindow": window, "inputModalities": modalities, "reasoningEfforts": efforts, "first": index == 0, "last": index == len(unique)-1})
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
		out = append(out, modelOutput{Provider: model["provider"].(string), Model: model["model"].(string), IsDefault: model["isDefault"].(bool), ContextWindow: model["contextWindow"], InputModalities: model["inputModalities"], ReasoningEfforts: model["reasoningEfforts"]})
	}
	return out
}

func formatContextWindow(raw any) string {
	var value float64
	switch typed := raw.(type) {
	case json.Number:
		value, _ = typed.Float64()
	case float64:
		value = typed
	case int:
		value = float64(typed)
	}
	if value <= 0 {
		return ""
	}
	return fmt.Sprintf(" (%dk)", int(math.Round(value/1000)))
}

func modelInList(raw any, model string) bool {
	list, ok := raw.([]any)
	if !ok {
		return false
	}
	family := model
	if colon := strings.Index(model, ":"); colon > 0 {
		family = model[:colon]
	}
	for _, value := range list {
		if text, ok := value.(string); ok && (text == model || text == family) {
			return true
		}
	}
	return false
}

func modelRecordValue(raw any, model string) any {
	record, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	if value, ok := record[model]; ok {
		return value
	}
	if colon := strings.Index(model, ":"); colon > 0 {
		if value, ok := record[model[:colon]]; ok {
			return value
		}
	}
	for key, value := range record {
		if strings.EqualFold(key, model) {
			return value
		}
	}
	return nil
}

func configuredModelReasoningEfforts(provider map[string]any, model string) any {
	if modelInList(provider["noReasoningModels"], model) {
		return []any{}
	}
	if efforts := modelRecordValue(provider["modelReasoningEfforts"], model); efforts != nil {
		return canonicalReasoningEfforts(efforts)
	}
	if efforts, ok := provider["reasoningEfforts"]; ok {
		return canonicalReasoningEfforts(efforts)
	}
	return nil
}

func canonicalReasoningEfforts(raw any) []any {
	values, ok := raw.([]any)
	if !ok {
		return []any{}
	}
	allowed := map[string]bool{"none": true, "minimal": true, "low": true, "medium": true, "high": true, "xhigh": true, "max": true, "ultra": true}
	order := []string{"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
	seen := map[string]bool{}
	for _, rawValue := range values {
		if value, ok := rawValue.(string); ok && allowed[value] {
			seen[value] = true
		}
	}
	out := []any{}
	for _, value := range order {
		if seen[value] {
			out = append(out, value)
		}
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
	provider, modelID, flags := strings.TrimSpace(args[0]), strings.TrimSpace(args[1]), append([]string(nil), args[2:]...)
	if provider == "" || modelID == "" {
		fmt.Fprintln(deps.Stderr, "Error: provider and modelId are required")
		return ExitFailure
	}
	if !isValidProviderName(provider) {
		fmt.Fprintf(deps.Stderr, "Error: invalid provider name %q\n", provider)
		return ExitFailure
	}
	displayName, contextWindow, modalities, reasoningEfforts, defaultEffort, err := parseCustomModelAddFlags(&flags)
	if err != nil {
		fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
		return ExitFailure
	}
	cfg, err := loadCLIConfig()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	providers, _ := cfg["providers"].(map[string]any)
	rawProvider, ok := providers[provider]
	if !ok {
		fmt.Fprintf(deps.Stderr, "Error: provider %q is not configured. See: ocx provider list\n", provider)
		return ExitFailure
	}
	models, _ := cfg["customModels"].([]any)
	slug := routedSlug(provider, modelID)
	for _, raw := range models {
		if model, ok := raw.(map[string]any); ok && routedSlug(fmt.Sprint(model["provider"]), fmt.Sprint(model["modelId"])) == slug {
			fmt.Fprintf(deps.Stderr, "Error: custom model %q already exists\n", slug)
			return ExitFailure
		}
	}
	providerConfig, _ := rawProvider.(map[string]any)
	if encodedModelIDCollides(modelID, knownModelIDs(provider, providerConfig, models)) {
		fmt.Fprintf(deps.Stderr, "Error: custom model %q is ambiguous; it encodes to an existing model id\n", slug)
		return ExitFailure
	}
	id, err := customModelUUID()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	entry := map[string]any{"id": id, "provider": provider, "modelId": modelID, "addedAt": time.Now().UTC().Format(time.RFC3339Nano)}
	if displayName != "" {
		entry["displayName"] = displayName
	}
	if contextWindow != nil {
		entry["contextWindow"] = *contextWindow
	}
	if modalities != nil {
		entry["inputModalities"] = *modalities
	}
	if reasoningEfforts != nil {
		entry["reasoningEfforts"] = *reasoningEfforts
	}
	if defaultEffort != "" {
		entry["defaultReasoningEffort"] = defaultEffort
	}
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
	printCustomModelTable(models, deps.Stdout)
	return ExitOK
}
func runCustomModelRemove(args []string, deps Deps) int {
	confirmed := takeFlag(&args, "--yes")
	if len(args) != 1 {
		fmt.Fprintln(deps.Stderr, "Error: custom model id or provider/modelId is required")
		fmt.Fprintln(deps.Stderr, modelRemoveUsage)
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
	selectedProvider := ""
	if slash := strings.Index(target, "/"); slash >= 0 {
		selectedProvider = target[:slash]
	}
	admitted := map[string]bool{}
	if selectedProvider != "" {
		roster := []string{}
		for _, raw := range models {
			if model, ok := raw.(map[string]any); ok && model["provider"] == selectedProvider {
				roster = append(roster, fmt.Sprint(model["modelId"]))
			}
		}
		for _, id := range resolveSlugSelection(selectedProvider, target, roster) {
			admitted[id] = true
		}
	}
	for i, raw := range models {
		model, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if fmt.Sprint(model["id"]) == target || (selectedProvider != "" && fmt.Sprint(model["provider"]) == selectedProvider && admitted[fmt.Sprint(model["modelId"])]) {
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
	fmt.Fprintf(deps.Stdout, "Removed custom model %s.\n", routedSlug(fmt.Sprint(model["provider"]), fmt.Sprint(model["modelId"])))
	return ExitOK
}

func parseCustomModelAddFlags(args *[]string) (string, *int, *[]any, *[]any, string, error) {
	var displayName, defaultEffort string
	var contextWindow *int
	var modalities, efforts *[]any
	take := func(flag string) (string, bool) {
		for i := 0; i < len(*args); i++ {
			if (*args)[i] == flag {
				if i+1 == len(*args) {
					return "", false
				}
				value := (*args)[i+1]
				*args = append((*args)[:i], (*args)[i+2:]...)
				return value, true
			}
		}
		return "", false
	}
	if value, found := take("--display-name"); found {
		displayName = strings.TrimSpace(value)
		if strings.Contains(displayName, "/") {
			return "", nil, nil, nil, "", errors.New("displayName must not contain /")
		}
	}
	if value, found := take("--context-window"); found {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed <= 0 {
			return "", nil, nil, nil, "", errors.New("context window must be a positive integer")
		}
		contextWindow = &parsed
	}
	if value, found := take("--modalities"); found {
		values := strings.Split(value, ",")
		seen := map[string]bool{}
		out := []any{}
		for _, item := range values {
			item = strings.TrimSpace(item)
			if item != "text" && item != "image" && item != "audio" {
				return "", nil, nil, nil, "", errors.New("modalities must be comma-separated values from text|image|audio")
			}
			if !seen[item] {
				seen[item] = true
				out = append(out, item)
			}
		}
		modalities = &out
	}
	if value, found := take("--reasoning-efforts"); found {
		if strings.TrimSpace(value) != "-" {
			parsed, err := parseReasoningEfforts(value)
			if err != nil {
				return "", nil, nil, nil, "", err
			}
			efforts = &parsed
		}
	}
	if value, found := take("--default-reasoning-effort"); found {
		defaultEffort = strings.TrimSpace(value)
		if defaultEffort == "-" {
			defaultEffort = ""
		} else {
			if !isDeclaredReasoningEffort(defaultEffort) {
				return "", nil, nil, nil, "", fmt.Errorf("unsupported reasoning effort: %s (allowed: none, minimal, low, medium, high, xhigh, max, ultra)", defaultEffort)
			}
			if efforts == nil || len(*efforts) == 0 {
				return "", nil, nil, nil, "", errors.New("--default-reasoning-effort requires --reasoning-efforts")
			}
			found := false
			for _, effort := range *efforts {
				if effort == defaultEffort {
					found = true
				}
			}
			if !found {
				return "", nil, nil, nil, "", fmt.Errorf("--default-reasoning-effort %q is not in the declared reasoning efforts", defaultEffort)
			}
		}
	}
	if len(*args) > 0 {
		return "", nil, nil, nil, "", fmt.Errorf("Unknown flag(s): %s", strings.Join(*args, ", "))
	}
	return displayName, contextWindow, modalities, efforts, defaultEffort, nil
}

func parseReasoningEfforts(raw string) ([]any, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "-" {
		return nil, nil
	}
	if trimmed == "" {
		return []any{}, nil
	}
	values := strings.Split(trimmed, ",")
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if !isDeclaredReasoningEffort(value) {
			return nil, fmt.Errorf("unsupported reasoning effort: %s (allowed: none, minimal, low, medium, high, xhigh, max, ultra)", value)
		}
		seen[value] = true
	}
	order := []string{"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
	out := []any{}
	for _, value := range order {
		if seen[value] {
			out = append(out, value)
		}
	}
	return out, nil
}
func isDeclaredReasoningEffort(value string) bool {
	for _, allowed := range []string{"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"} {
		if value == allowed {
			return true
		}
	}
	return false
}

func isValidProviderName(value string) bool {
	if value == "" || len(value) > 64 || value != strings.TrimSpace(value) {
		return false
	}
	reserved := map[string]bool{"__proto__": true, "prototype": true, "constructor": true}
	if reserved[strings.ToLower(value)] {
		return false
	}
	for i, char := range value {
		alnum := char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9'
		if i == 0 || i == len(value)-1 {
			if !alnum {
				return false
			}
			continue
		}
		if !alnum && char != '.' && char != '_' && char != '-' {
			return false
		}
	}
	return true
}
func routedSlug(provider, model string) string {
	return provider + "/" + strings.ReplaceAll(model, "/", "-")
}
func encodedModelIDCollides(model string, known []string) bool {
	encoded := strings.ReplaceAll(model, "/", "-")
	for _, id := range known {
		if id != model && strings.ReplaceAll(id, "/", "-") == encoded {
			return true
		}
	}
	return false
}
func knownModelIDs(provider string, config map[string]any, custom []any) []string {
	seen := map[string]bool{}
	out := []string{}
	add := func(id string) {
		if id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	if id, _ := config["defaultModel"].(string); id != "" {
		add(id)
	}
	if models, ok := config["models"].([]any); ok {
		for _, raw := range models {
			if id, ok := raw.(string); ok {
				add(id)
			}
		}
	}
	for _, raw := range custom {
		if model, ok := raw.(map[string]any); ok && model["provider"] == provider {
			add(fmt.Sprint(model["modelId"]))
		}
	}
	return out
}
func resolveSlugSelection(provider, selection string, ids []string) []string {
	namesNative := false
	for _, id := range ids {
		if id == selection {
			namesNative = true
		}
	}
	qualified := routedSlug(provider, selection)
	if !namesNative && strings.HasPrefix(selection, provider+"/") {
		qualified = selection
	}
	key := slugKey(qualified)
	out := []string{}
	for _, id := range ids {
		if slugKey(routedSlug(provider, id)) == key {
			out = append(out, id)
		}
	}
	return out
}
func slugKey(slug string) string {
	slash := strings.Index(slug, "/")
	if slash <= 0 {
		return "exact:" + slug
	}
	return "routed:" + slug[:slash] + ":" + strings.ReplaceAll(slug[slash+1:], "/", "-")
}
func customModelUUID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", raw[:4], raw[4:6], raw[6:8], raw[8:10], raw[10:]), nil
}
func printCustomModelTable(models []any, writer io.Writer) {
	groups := map[string][]map[string]any{}
	names := []string{}
	for _, raw := range models {
		model, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		provider := fmt.Sprint(model["provider"])
		if _, ok := groups[provider]; !ok {
			names = append(names, provider)
		}
		groups[provider] = append(groups[provider], model)
	}
	for _, provider := range names {
		headers := []string{"ID", "MODEL", "DISPLAY NAME", "CONTEXT", "MODALITIES", "EFFORTS", "DEFAULT EFFORT"}
		rows := make([][]string, 0, len(groups[provider]))
		widths := make([]int, len(headers))
		copy(widths, []int{2, 5, 12, 7, 10, 7, 14})
		for _, model := range groups[provider] {
			id := fmt.Sprint(model["id"])
			if len(id) > 8 {
				id = id[:8]
			}
			row := []string{id, fmt.Sprint(model["modelId"]), dash(model["displayName"]), customContext(model["contextWindow"]), customCSV(model["inputModalities"]), customCSV(model["reasoningEfforts"]), dash(model["defaultReasoningEffort"])}
			rows = append(rows, row)
			for i, cell := range row {
				if len(cell) > widths[i] {
					widths[i] = len(cell)
				}
			}
		}
		line := func(row []string) string {
			cells := make([]string, len(row))
			for i, cell := range row {
				cells[i] = fmt.Sprintf("%-*s", widths[i], cell)
			}
			return strings.Join(cells, "  ")
		}
		fmt.Fprintf(writer, "%s:\n  %s\n", provider, line(headers))
		for _, row := range rows {
			fmt.Fprintf(writer, "  %s\n", line(row))
		}
		fmt.Fprintln(writer)
	}
}
func dash(value any) string {
	if value == nil || fmt.Sprint(value) == "" {
		return "-"
	}
	return fmt.Sprint(value)
}
func customContext(value any) string {
	if value == nil {
		return "-"
	}
	number, err := strconv.ParseFloat(fmt.Sprint(value), 64)
	if err != nil || number <= 0 {
		return "-"
	}
	return fmt.Sprintf("%dk", int(math.Round(number/1000)))
}
func customCSV(value any) string {
	values, ok := value.([]any)
	if !ok || len(values) == 0 {
		return "-"
	}
	parts := make([]string, 0, len(values))
	for _, raw := range values {
		parts = append(parts, fmt.Sprint(raw))
	}
	return strings.Join(parts, ",")
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

func writeNativeConfigJSON(writer io.Writer, value any) int {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		fmt.Fprintln(writer, err)
		return ExitFailure
	}
	raw = bytes.ReplaceAll(raw, []byte("\\u003e"), []byte(">"))
	raw = bytes.ReplaceAll(raw, []byte("\\u003c"), []byte("<"))
	raw = bytes.ReplaceAll(raw, []byte("\\u0026"), []byte("&"))
	fmt.Fprintln(writer, string(raw))
	return ExitOK
}
