package ocxcli

import (
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// export_build.go — per-client document builders (src/clients/config-export.ts).
// Every builder mirrors the TypeScript object-literal key order so jsonwire's
// indented JSON (and the YAML/TOML/JSON5 renderers walking the same tree) emit
// byte-identical documents. No secret is serialized: env references and the
// loopback placeholder only.

const (
	exportProviderID           = "opencodex"
	exportProviderSchema       = "https://opencode.ai/config.json"
	exportProviderNPM          = "@ai-sdk/openai-compatible"
	exportProviderV2Package    = "@opencode-ai/ai/providers/openai-compatible"
	exportProviderName         = "OpenCodex"
	exportOpenCodeAPIKeyEnv    = "OPENCODEX_OPENCODE_API_KEY"
	exportOpenCodeAPIKeyEnvRef = "{env:OPENCODEX_OPENCODE_API_KEY}"
	exportHermesAPIKeyEnv      = "OPENCODEX_HERMES_API_KEY"
	exportOpenClawAPIKeyEnv    = "OPENCODEX_OPENCLAW_API_KEY"
	exportGajaeAPIKeyEnv       = "OPENCODEX_GAJAE_API_KEY"
	exportLoopbackPlaceholder  = "opencodex-loopback"
	exportPiAPIDialect         = "openai-completions"
)

func exportNumber(value float64) *jsonwire.Value { return jsonwire.NumberFrom(value) }
func exportStr(value string) *jsonwire.Value     { return jsonwire.StringValue(value) }

// exportContext bundles what the builders read.
type exportContext struct {
	baseURL string
	models  []exportModel
	config  exportConfigView
}

type exportConfigView struct {
	codexDirect    bool
	hostname       string
	unauthLoopback bool
	combos         *jsonwire.Value // providers.combos raw object, if any
}

// isLoopbackExportHostname mirrors isLoopbackHostname.
func isLoopbackExportHostname(hostname string) bool {
	normalized := strings.ToLower(strings.TrimSpace(hostname))
	if normalized == "" {
		return true
	}
	switch normalized {
	case "localhost", "127.0.0.1", "::1", "[::1]":
		return true
	}
	return false
}

// shouldInjectExportAPIHeader mirrors shouldInjectApiAuthHeader.
func shouldInjectExportAPIHeader(config exportConfigView) bool {
	if config.unauthLoopback {
		return false
	}
	return !isLoopbackExportHostname(config.hostname)
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode.

type exportProviderBlocks struct {
	v1, v2 *jsonwire.Value
}

func exportEffortVariants(model exportModel) *jsonwire.Value {
	if model.reasoningEfforts == nil {
		return nil
	}
	efforts := []string{}
	for _, effort := range canonicalizeExportReasoningEfforts(model.reasoningEfforts) {
		if effort != "none" {
			efforts = append(efforts, effort)
		}
	}
	if len(efforts) == 0 {
		return nil
	}
	variants := jsonwire.EmptyArray()
	for _, effort := range efforts {
		variant := jsonwire.ObjectValue()
		variant.Set("id", exportStr(effort))
		settings := jsonwire.ObjectValue()
		settings.Set("reasoningEffort", exportStr(effort))
		variant.Set("settings", settings)
		variants.AppendArray(variant)
	}
	return variants
}

func exportOpenCodeConnection(baseURL string, config exportConfigView) *jsonwire.Value {
	options := jsonwire.ObjectValue()
	options.Set("baseURL", exportStr(baseURL))
	if shouldInjectExportAPIHeader(config) {
		headers := jsonwire.ObjectValue()
		headers.Set("x-opencodex-api-key", exportStr(exportOpenCodeAPIKeyEnvRef))
		options.Set("headers", headers)
		return options
	}
	options.Set("apiKey", exportStr(exportOpenCodeAPIKeyEnvRef))
	return options
}

func exportOpenCodeProviderBlocks(baseURL string, models []exportModel, config exportConfigView) exportProviderBlocks {
	v1Models := jsonwire.ObjectValue()
	v2Models := jsonwire.ObjectValue()
	for _, model := range models {
		key := model.namespaced
		label := exportModelLabel(model)
		entry := jsonwire.ObjectValue()
		entry.Set("name", exportStr(label))
		if context, ok := authoritativeExportContextWindow(model); ok {
			limit := jsonwire.ObjectValue()
			limit.Set("context", exportNumber(context))
			limit.Set("output", exportNumber(outputBudgetForExport(context)))
			entry.Set("limit", limit)
		}
		v1Models.Set(key, entry)
		v2Entry := jsonwire.ObjectValue()
		v2Entry.Set("name", exportStr(label))
		if context, ok := authoritativeExportContextWindow(model); ok {
			limit := jsonwire.ObjectValue()
			limit.Set("context", exportNumber(context))
			limit.Set("output", exportNumber(outputBudgetForExport(context)))
			v2Entry.Set("limit", limit)
		}
		if variants := exportEffortVariants(model); variants != nil {
			v2Entry.Set("variants", variants)
		}
		v2Models.Set(key, v2Entry)
	}
	v1 := jsonwire.ObjectValue()
	v1.Set("npm", exportStr(exportProviderNPM))
	v1.Set("name", exportStr(exportProviderName))
	v1.Set("options", exportOpenCodeConnection(baseURL, config))
	v1.Set("models", v1Models)
	v2 := jsonwire.ObjectValue()
	v2.Set("package", exportStr(exportProviderV2Package))
	v2.Set("name", exportStr(exportProviderName))
	v2.Set("settings", exportOpenCodeConnection(baseURL, config))
	v2.Set("models", v2Models)
	return exportProviderBlocks{v1: v1, v2: v2}
}

func buildExportOpenCodeClientConfig(ctx exportContext) *jsonwire.Value {
	models := normalizeExportModels(ctx.models)
	blocks := exportOpenCodeProviderBlocks(ctx.baseURL, models, ctx.config)
	doc := jsonwire.ObjectValue()
	doc.Set("$schema", exportStr(exportProviderSchema))
	legacy := jsonwire.ObjectValue()
	legacy.Set(exportProviderID, blocks.v1)
	doc.Set("provider", legacy)
	v2 := jsonwire.ObjectValue()
	v2.Set(exportProviderID, blocks.v2)
	doc.Set("providers", v2)
	return doc
}

// ─────────────────────────────────────────────────────────────────────────────
// Pi-shaped clients (pi, omp, prime, aside) and OMP's extra metadata.

func buildExportPiClientConfig(ctx exportContext) *jsonwire.Value {
	models := jsonwire.EmptyArray()
	for _, model := range normalizeExportModels(ctx.models) {
		input := inputModalitiesForExportClient(model.inputModalities)
		if input == nil {
			continue
		}
		entry := jsonwire.ObjectValue()
		entry.Set("id", exportStr(model.namespaced))
		entry.Set("name", exportStr(exportModelLabel(model)))
		inputArray := jsonwire.EmptyArray()
		for _, modality := range input {
			inputArray.AppendArray(exportStr(modality))
		}
		entry.Set("input", inputArray)
		if len(model.reasoningEfforts) > 0 {
			entry.Set("reasoning", jsonwire.BoolValue(true))
			levelMap := jsonwire.ObjectValue()
			levels := []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}
			for _, level := range levels {
				var mapped string
				hasValue := false
				if level == "max" {
					if exportContains(model.reasoningEfforts, "max") {
						mapped, hasValue = "max", true
					} else if exportContains(model.reasoningEfforts, "ultra") {
						mapped, hasValue = "ultra", true
					}
				} else if exportContains(model.reasoningEfforts, level) {
					mapped, hasValue = level, true
				}
				if hasValue {
					levelMap.Set(level, exportStr(mapped))
				} else {
					levelMap.Set(level, jsonwire.NullValue())
				}
			}
			entry.Set("thinkingLevelMap", levelMap)
		}
		if context, ok := authoritativeExportContextWindow(model); ok {
			entry.Set("contextWindow", exportNumber(context))
			entry.Set("maxTokens", exportNumber(outputBudgetForExport(context)))
		}
		models.AppendArray(entry)
	}
	provider := jsonwire.ObjectValue()
	provider.Set("baseUrl", exportStr(ctx.baseURL))
	provider.Set("api", exportStr(exportPiAPIDialect))
	provider.Set("apiKey", exportStr(exportLoopbackPlaceholder))
	provider.Set("models", models)
	providers := jsonwire.ObjectValue()
	providers.Set(exportProviderID, provider)
	doc := jsonwire.ObjectValue()
	doc.Set("providers", providers)
	return doc
}

var exportOMPEffortVocabulary = map[string]bool{"minimal": true, "low": true, "medium": true, "high": true, "xhigh": true, "max": true}

func exportOMPEfforts(model exportModel) []string {
	efforts := []string{}
	for _, effort := range model.reasoningEfforts {
		normalized := strings.ToLower(strings.TrimSpace(effort))
		if exportOMPEffortVocabulary[normalized] && !exportContains(efforts, normalized) {
			efforts = append(efforts, normalized)
		}
	}
	return efforts
}

func buildExportOmpClientConfig(ctx exportContext) *jsonwire.Value {
	models := jsonwire.EmptyArray()
	for _, model := range normalizeExportModels(ctx.models) {
		input := inputModalitiesForExportClient(model.inputModalities)
		if input == nil {
			continue
		}
		entry := jsonwire.ObjectValue()
		entry.Set("id", exportStr(model.namespaced))
		entry.Set("name", exportStr(exportModelLabel(model)))
		inputArray := jsonwire.EmptyArray()
		for _, modality := range input {
			inputArray.AppendArray(exportStr(modality))
		}
		entry.Set("input", inputArray)
		if model.native && model.provider == "openai" {
			entry.Set("api", exportStr("openai-responses"))
		}
		if context, ok := authoritativeExportContextWindow(model); ok {
			entry.Set("contextWindow", exportNumber(context))
			entry.Set("maxTokens", exportNumber(outputBudgetForExport(context)))
		}
		efforts := exportOMPEfforts(model)
		if len(efforts) > 0 {
			defaultLevel := strings.ToLower(strings.TrimSpace(model.defaultReasoningEffort))
			entry.Set("reasoning", jsonwire.BoolValue(true))
			thinking := jsonwire.ObjectValue()
			thinking.Set("mode", exportStr("effort"))
			effortArray := jsonwire.EmptyArray()
			for _, effort := range efforts {
				effortArray.AppendArray(exportStr(effort))
			}
			thinking.Set("efforts", effortArray)
			if defaultLevel != "" && exportContains(efforts, defaultLevel) {
				thinking.Set("defaultLevel", exportStr(defaultLevel))
			}
			entry.Set("thinking", thinking)
		}
		models.AppendArray(entry)
	}
	provider := jsonwire.ObjectValue()
	provider.Set("baseUrl", exportStr(ctx.baseURL))
	provider.Set("api", exportStr(exportPiAPIDialect))
	provider.Set("apiKey", exportStr(exportLoopbackPlaceholder))
	provider.Set("models", models)
	providers := jsonwire.ObjectValue()
	providers.Set(exportProviderID, provider)
	doc := jsonwire.ObjectValue()
	doc.Set("providers", providers)
	return doc
}

// ─────────────────────────────────────────────────────────────────────────────
// Hermes / OpenClaw.

func buildExportHermesClientConfig(ctx exportContext) *jsonwire.Value {
	models := jsonwire.ObjectValue()
	for _, model := range normalizeExportModels(ctx.models) {
		if len(model.inputModalities) > 0 {
			entry := jsonwire.ObjectValue()
			entry.Set("supports_vision", jsonwire.BoolValue(exportContains(model.inputModalities, "image")))
			models.Set(model.namespaced, entry)
		} else {
			models.Set(model.namespaced, jsonwire.ObjectValue())
		}
	}
	provider := jsonwire.ObjectValue()
	provider.Set("api", exportStr(ctx.baseURL))
	provider.Set("api_key", exportStr("${"+exportHermesAPIKeyEnv+"}"))
	provider.Set("api_mode", exportStr("chat_completions"))
	provider.Set("discover_models", jsonwire.BoolValue(false))
	provider.Set("models", models)
	if shouldInjectExportAPIHeader(ctx.config) {
		headers := jsonwire.ObjectValue()
		headers.Set("x-opencodex-api-key", exportStr("${"+exportHermesAPIKeyEnv+"}"))
		provider.Set("extra_headers", headers)
	}
	providers := jsonwire.ObjectValue()
	providers.Set(exportProviderID, provider)
	doc := jsonwire.ObjectValue()
	doc.Set("providers", providers)
	return doc
}

func buildExportOpenclawClientConfig(ctx exportContext) *jsonwire.Value {
	models := jsonwire.EmptyArray()
	for _, model := range normalizeExportModels(ctx.models) {
		entry := jsonwire.ObjectValue()
		entry.Set("id", exportStr(model.namespaced))
		entry.Set("name", exportStr(exportModelLabel(model)))
		if context, ok := authoritativeExportContextWindow(model); ok {
			entry.Set("contextWindow", exportNumber(context))
		}
		models.AppendArray(entry)
	}
	provider := jsonwire.ObjectValue()
	provider.Set("baseUrl", exportStr(ctx.baseURL))
	provider.Set("apiKey", exportStr("${"+exportOpenClawAPIKeyEnv+"}"))
	provider.Set("api", exportStr("openai-completions"))
	provider.Set("models", models)
	if shouldInjectExportAPIHeader(ctx.config) {
		headers := jsonwire.ObjectValue()
		headers.Set("x-opencodex-api-key", exportStr("${"+exportOpenClawAPIKeyEnv+"}"))
		provider.Set("headers", headers)
	}
	providers := jsonwire.ObjectValue()
	providers.Set(exportProviderID, provider)
	merge := jsonwire.ObjectValue()
	merge.Set("mode", exportStr("merge"))
	merge.Set("providers", providers)
	doc := jsonwire.ObjectValue()
	doc.Set("models", merge)
	return doc
}

// ─────────────────────────────────────────────────────────────────────────────
// Kimi / Gajae.

func exportKimiModelAlias(namespaced string) string {
	return exportProviderID + "/" + namespaced
}

func buildExportKimiClientConfig(ctx exportContext) *jsonwire.Value {
	models := jsonwire.ObjectValue()
	for _, model := range normalizeExportModels(ctx.models) {
		context, ok := authoritativeExportContextWindow(model)
		if !ok {
			continue
		}
		block := jsonwire.ObjectValue()
		block.Set("provider", exportStr(exportProviderID))
		block.Set("model", exportStr(model.namespaced))
		block.Set("max_context_size", exportNumber(context))
		if model.displayName != "" {
			block.Set("display_name", exportStr(model.displayName))
		}
		models.Set(exportKimiModelAlias(model.namespaced), block)
	}
	provider := jsonwire.ObjectValue()
	provider.Set("type", exportStr("openai"))
	provider.Set("base_url", exportStr(ctx.baseURL))
	provider.Set("api_key", exportStr(exportLoopbackPlaceholder))
	providers := jsonwire.ObjectValue()
	providers.Set(exportProviderID, provider)
	doc := jsonwire.ObjectValue()
	doc.Set("providers", providers)
	doc.Set("models", models)
	return doc
}

func buildExportGajaeClientConfig(ctx exportContext) *jsonwire.Value {
	models := jsonwire.EmptyArray()
	for _, model := range normalizeExportModels(ctx.models) {
		input := inputModalitiesForExportClient(model.inputModalities)
		if input == nil {
			continue
		}
		entry := jsonwire.ObjectValue()
		entry.Set("id", exportStr(model.namespaced))
		entry.Set("name", exportStr(exportModelLabel(model)))
		inputArray := jsonwire.EmptyArray()
		for _, modality := range input {
			inputArray.AppendArray(exportStr(modality))
		}
		entry.Set("input", inputArray)
		if context, ok := authoritativeExportContextWindow(model); ok {
			entry.Set("contextWindow", exportNumber(context))
			entry.Set("maxTokens", exportNumber(outputBudgetForExport(context)))
		}
		models.AppendArray(entry)
	}
	provider := jsonwire.ObjectValue()
	provider.Set("baseUrl", exportStr(ctx.baseURL))
	provider.Set("apiKeyEnv", exportStr(exportGajaeAPIKeyEnv))
	provider.Set("api", exportStr("openai-completions"))
	provider.Set("models", models)
	providers := jsonwire.ObjectValue()
	providers.Set(exportProviderID, provider)
	doc := jsonwire.ObjectValue()
	doc.Set("providers", providers)
	return doc
}

// ─────────────────────────────────────────────────────────────────────────────
// DSH.

var exportDSHEffortOrder = []string{"low", "medium", "high", "xhigh", "max"}

func exportDshReasoningEfforts(model exportModel) *jsonwire.Value {
	offered := map[string]bool{}
	for _, raw := range model.reasoningEfforts {
		effort := strings.ToLower(strings.TrimSpace(raw))
		if effort == "ultra" || exportContains(exportDSHEffortOrder, effort) {
			offered[effort] = true
		}
	}
	if len(offered) == 0 {
		return nil
	}
	out := jsonwire.ObjectValue()
	for _, effort := range exportDSHEffortOrder {
		if effort != "max" {
			if offered[effort] {
				out.Set(effort, exportStr(effort))
			}
			continue
		}
		if offered["max"] {
			out.Set("max", exportStr("max"))
		} else if offered["ultra"] {
			out.Set("max", exportStr("ultra"))
		}
	}
	return out
}

// isKnownSafeExportDshCombo mirrors isKnownSafeDshCombo: the config's combos
// entry for model.id must name only non-openai providers/models with trimmed
// non-empty strings.
func isKnownSafeExportDshCombo(model exportModel, combos *jsonwire.Value) bool {
	if combos == nil || combos.Kind() != jsonwire.Object {
		return false
	}
	combo := combos.Find(model.id)
	if combo == nil || combo.Kind() != jsonwire.Object {
		return false
	}
	targets := combo.Find("targets")
	if targets == nil || targets.Kind() != jsonwire.Array || len(targets.Elements()) == 0 {
		return false
	}
	for _, target := range targets.Elements() {
		if target == nil || target.Kind() != jsonwire.Object {
			return false
		}
		provider := target.Find("provider")
		modelID := target.Find("model")
		if provider == nil || provider.Kind() != jsonwire.String {
			return false
		}
		if modelID == nil || modelID.Kind() != jsonwire.String {
			return false
		}
		providerValue := provider.String()
		modelValue := modelID.String()
		if providerValue == "" || providerValue != strings.TrimSpace(providerValue) || providerValue == "openai" {
			return false
		}
		if modelValue == "" || modelValue != strings.TrimSpace(modelValue) {
			return false
		}
	}
	return true
}

func buildExportDshClientConfig(ctx exportContext) *jsonwire.Value {
	direct := ctx.config.codexDirect
	models := jsonwire.EmptyArray()
	for _, model := range normalizeExportModels(ctx.models) {
		if direct && (model.native || model.provider == "openai") {
			continue
		}
		if direct && model.provider == "combo" && !isKnownSafeExportDshCombo(model, ctx.config.combos) {
			continue
		}
		input := dshExportInputModalities(model.inputModalities)
		if input == nil {
			continue
		}
		entry := jsonwire.ObjectValue()
		entry.Set("id", exportStr(model.namespaced))
		entry.Set("name", exportStr(exportModelLabel(model)))
		inputArray := jsonwire.EmptyArray()
		for _, modality := range input {
			inputArray.AppendArray(exportStr(modality))
		}
		entry.Set("input", inputArray)
		if context, ok := authoritativeExportContextWindow(model); ok {
			entry.Set("contextWindow", exportNumber(context))
		}
		if efforts := exportDshReasoningEfforts(model); efforts != nil {
			entry.Set("reasoningEfforts", efforts)
		}
		models.AppendArray(entry)
	}
	provider := jsonwire.ObjectValue()
	provider.Set("displayName", exportStr("OpenCodex"))
	provider.Set("api", exportStr("openai-responses"))
	provider.Set("baseURL", exportStr(ctx.baseURL))
	headers := jsonwire.ObjectValue()
	headers.Set("Authorization", exportStr("Bearer ocx_data_dsh"))
	provider.Set("headers", headers)
	provider.Set("models", models)
	providers := jsonwire.ObjectValue()
	providers.Set(exportProviderID, provider)
	llm := jsonwire.ObjectValue()
	llm.Set("providers", providers)
	top := jsonwire.ObjectValue()
	top.Set("llm-pi-ai", llm)
	return top
}

// ─────────────────────────────────────────────────────────────────────────────
// MiniMax Code / ZCode.

func buildExportMcodeClientConfig(ctx exportContext) *jsonwire.Value {
	models := jsonwire.ObjectValue()
	for _, model := range normalizeExportModels(ctx.models) {
		entry := jsonwire.ObjectValue()
		if context, ok := authoritativeExportContextWindow(model); ok {
			limit := jsonwire.ObjectValue()
			limit.Set("context", exportNumber(context))
			entry.Set("limit", limit)
		}
		efforts := sanitizeExportReasoningEfforts(model.reasoningEfforts)
		filtered := []string{}
		for _, effort := range efforts {
			if effort != "none" {
				filtered = append(filtered, effort)
			}
		}
		if len(filtered) > 0 {
			thinking := jsonwire.ObjectValue()
			options := jsonwire.EmptyArray()
			for _, effort := range filtered {
				options.AppendArray(exportStr(effort))
			}
			thinking.Set("effortOptions", options)
			entry.Set("thinking", thinking)
		}
		models.Set(model.namespaced, entry)
	}
	provider := jsonwire.ObjectValue()
	provider.Set("name", exportStr("OpenCodex"))
	provider.Set("kind", exportStr("custom"))
	provider.Set("enabled", jsonwire.BoolValue(true))
	provider.Set("api", exportStr("anthropic-messages"))
	options := jsonwire.ObjectValue()
	options.Set("apiKey", exportStr(exportLoopbackPlaceholder))
	options.Set("baseURL", exportStr(exportTrimV1Suffix(ctx.baseURL)))
	options.Set("authMode", exportStr("api-key"))
	provider.Set("options", options)
	provider.Set("models", models)
	custom := jsonwire.ObjectValue()
	custom.Set(exportProviderID, provider)
	doc := jsonwire.ObjectValue()
	doc.Set("custom_provider", custom)
	return doc
}

// exportTrimV1Suffix mirrors ctx.baseUrl.replace(/\/v1\/?$/, "").
func exportTrimV1Suffix(baseURL string) string {
	if strings.HasSuffix(baseURL, "/v1") {
		return baseURL[:len(baseURL)-3]
	}
	if strings.HasSuffix(baseURL, "/v1/") {
		return baseURL[:len(baseURL)-4]
	}
	return baseURL
}

func buildExportZcodeClientConfig(ctx exportContext) *jsonwire.Value {
	models := jsonwire.ObjectValue()
	for _, model := range normalizeExportModels(ctx.models) {
		input := inputModalitiesForExportClient(model.inputModalities)
		if input == nil {
			continue
		}
		entry := jsonwire.ObjectValue()
		entry.Set("name", exportStr(exportModelLabel(model)))
		modalities := jsonwire.ObjectValue()
		inputArray := jsonwire.EmptyArray()
		for _, modality := range input {
			inputArray.AppendArray(exportStr(modality))
		}
		modalities.Set("input", inputArray)
		output := jsonwire.EmptyArray()
		output.AppendArray(exportStr("text"))
		modalities.Set("output", output)
		entry.Set("modalities", modalities)
		if context, ok := authoritativeExportContextWindow(model); ok {
			limit := jsonwire.ObjectValue()
			limit.Set("context", exportNumber(context))
			entry.Set("limit", limit)
		}
		models.Set(model.namespaced, entry)
	}
	provider := jsonwire.ObjectValue()
	provider.Set("name", exportStr("OpenCodex"))
	provider.Set("kind", exportStr("openai-compatible"))
	provider.Set("enabled", jsonwire.BoolValue(true))
	provider.Set("source", exportStr("custom"))
	options := jsonwire.ObjectValue()
	options.Set("apiKey", exportStr(exportLoopbackPlaceholder))
	options.Set("baseURL", exportStr(exportTrimV1Suffix(ctx.baseURL)+"/v1"))
	options.Set("apiKeyRequired", jsonwire.BoolValue(true))
	provider.Set("options", options)
	provider.Set("models", models)
	providers := jsonwire.ObjectValue()
	providers.Set(exportProviderID, provider)
	doc := jsonwire.ObjectValue()
	doc.Set("provider", providers)
	return doc
}
