package registry

import (
	"fmt"
	"strings"
)

const (
	OpenAIProviderTierVersion   = 2
	OpenAICodexProviderID       = "openai"
	OpenAIAPIProviderID         = "openai-apikey"
	LegacyOpenAIMultiProviderID = "openai-multi"
	LegacyChatGPTProviderID     = "chatgpt"
)

type OpenAITierProvider struct {
	Adapter        string
	BaseURL        string
	AuthKind       AuthKind
	AccountMode    string
	Disabled       bool
	SelectedModels []string
}

type OpenAITierConfig struct {
	Version         int
	DefaultProvider string
	Providers       map[string]OpenAITierProvider
	ModelSelectors  []string
}

type OpenAITierMigration struct {
	Config       OpenAITierConfig
	Changed      bool
	ResolvedMode string
	Warnings     []string
}

func MigrateOpenAITiers(input OpenAITierConfig) (OpenAITierMigration, error) {
	out := cloneTierConfig(input)
	legacy, hasLegacy := out.Providers[LegacyOpenAIMultiProviderID]
	if hasLegacy && !canonicalLegacyOpenAI(legacy) {
		return OpenAITierMigration{}, fmt.Errorf("reserved provider %q has noncanonical shape", LegacyOpenAIMultiProviderID)
	}
	openai, hasOpenAI := out.Providers[OpenAICodexProviderID]
	mode := openai.AccountMode
	if mode != "direct" && mode != "pool" {
		if hasLegacy || input.DefaultProvider == LegacyOpenAIMultiProviderID {
			mode = "pool"
		} else if input.Version == 1 && hasOpenAI {
			mode = "direct"
		} else {
			mode = "pool"
		}
	}
	_, hasLegacyChatGPT := out.Providers[LegacyChatGPTProviderID]
	changed := out.Version != OpenAIProviderTierVersion || hasLegacy || hasLegacyChatGPT || out.DefaultProvider == LegacyOpenAIMultiProviderID || out.DefaultProvider == LegacyChatGPTProviderID
	for _, selector := range out.ModelSelectors {
		if strings.HasPrefix(selector, LegacyOpenAIMultiProviderID+"/") {
			changed = true
			break
		}
	}
	if hasOpenAI || hasLegacy || out.DefaultProvider == OpenAICodexProviderID || out.DefaultProvider == LegacyOpenAIMultiProviderID || out.DefaultProvider == LegacyChatGPTProviderID {
		selected := dedupeStrings(append(rewriteLegacySelectors(openai.SelectedModels), rewriteLegacySelectors(legacy.SelectedModels)...))
		disabled := (hasOpenAI || hasLegacy) && (!hasOpenAI || openai.Disabled) && (!hasLegacy || legacy.Disabled)
		out.Providers[OpenAICodexProviderID] = OpenAITierProvider{Adapter: "openai-responses", BaseURL: "https://chatgpt.com/backend-api/codex", AuthKind: AuthForward, AccountMode: mode, Disabled: disabled, SelectedModels: selected}
	}
	delete(out.Providers, LegacyOpenAIMultiProviderID)
	delete(out.Providers, LegacyChatGPTProviderID)
	if out.DefaultProvider == LegacyOpenAIMultiProviderID || out.DefaultProvider == LegacyChatGPTProviderID {
		out.DefaultProvider = OpenAICodexProviderID
	}
	out.ModelSelectors = rewriteLegacySelectors(out.ModelSelectors)
	out.Version = OpenAIProviderTierVersion
	return OpenAITierMigration{Config: out, Changed: changed, ResolvedMode: mode}, nil
}

func canonicalLegacyOpenAI(provider OpenAITierProvider) bool {
	return provider.Adapter == "openai-responses" && provider.AuthKind == AuthForward && strings.TrimRight(provider.BaseURL, "/") == "https://chatgpt.com/backend-api/codex"
}

func rewriteLegacySelectors(values []string) []string {
	out := make([]string, len(values))
	for i, value := range values {
		out[i] = strings.TrimPrefix(value, LegacyOpenAIMultiProviderID+"/")
	}
	return dedupeStrings(out)
}

func dedupeStrings(values []string) []string {
	seen, out := make(map[string]struct{}, len(values)), make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func cloneTierConfig(input OpenAITierConfig) OpenAITierConfig {
	out := input
	out.Providers = make(map[string]OpenAITierProvider, len(input.Providers))
	for name, provider := range input.Providers {
		provider.SelectedModels = append([]string(nil), provider.SelectedModels...)
		out.Providers[name] = provider
	}
	out.ModelSelectors = append([]string(nil), input.ModelSelectors...)
	return out
}

type OpenAIVirtualModel struct{ SelectedModelID, WireModelID, ReasoningMode string }

var openAIVirtualModels = map[string]string{"gpt-5.6-sol-pro": "gpt-5.6-sol", "gpt-5.6-terra-pro": "gpt-5.6-terra", "gpt-5.6-luna-pro": "gpt-5.6-luna"}

func ResolveOpenAIVirtualModel(provider, selected string) (OpenAIVirtualModel, bool) {
	if provider != OpenAIAPIProviderID {
		return OpenAIVirtualModel{}, false
	}
	wire, ok := openAIVirtualModels[selected]
	return OpenAIVirtualModel{SelectedModelID: selected, WireModelID: wire, ReasoningMode: "pro"}, ok
}
