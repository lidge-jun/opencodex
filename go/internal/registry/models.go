package registry

// ModelDefinition is static capability metadata used when no live catalog is available.
type ModelDefinition struct {
	ID               string
	DisplayName      string
	ContextWindow    int
	ReasoningEfforts []string
}

var standardReasoningEfforts = []string{"low", "medium", "high", "xhigh", "max"}

var antigravityModels = []ModelDefinition{
	{ID: "gemini-3.6-flash", ContextWindow: 1_048_576, ReasoningEfforts: []string{"low", "medium", "high"}},
	{ID: "gemini-3.1-pro", ContextWindow: 1_048_576, ReasoningEfforts: []string{"low", "high"}},
	{ID: "claude-sonnet-4-6", ContextWindow: 200_000, ReasoningEfforts: []string{"low", "medium", "high", "max"}},
	{ID: "claude-opus-4-6-thinking", ContextWindow: 1_000_000, ReasoningEfforts: []string{"low", "medium", "high", "max"}},
	{ID: "gpt-oss-120b-medium", ContextWindow: 131_072},
}

var kiroModels = []ModelDefinition{
	{ID: "kiro-auto", ReasoningEfforts: standardReasoningEfforts},
	{ID: "gpt-5.6-sol", ContextWindow: 272_000, ReasoningEfforts: standardReasoningEfforts},
	{ID: "gpt-5.6-terra", ContextWindow: 272_000, ReasoningEfforts: standardReasoningEfforts},
	{ID: "gpt-5.6-luna", ContextWindow: 272_000, ReasoningEfforts: standardReasoningEfforts},
	{ID: "claude-sonnet-5", ContextWindow: 1_000_000, ReasoningEfforts: standardReasoningEfforts},
	{ID: "claude-opus-5", ContextWindow: 1_000_000, ReasoningEfforts: standardReasoningEfforts},
	{ID: "claude-opus-4.8", ContextWindow: 1_000_000, ReasoningEfforts: standardReasoningEfforts},
	{ID: "claude-opus-4.7", ContextWindow: 1_000_000, ReasoningEfforts: standardReasoningEfforts},
	{ID: "claude-opus-4.6", ContextWindow: 1_000_000, ReasoningEfforts: standardReasoningEfforts},
	{ID: "claude-opus-4.5", ContextWindow: 200_000, ReasoningEfforts: standardReasoningEfforts},
	{ID: "claude-sonnet-4.6", ContextWindow: 1_000_000, ReasoningEfforts: standardReasoningEfforts},
	{ID: "claude-sonnet-4.5", ContextWindow: 200_000, ReasoningEfforts: standardReasoningEfforts},
	{ID: "claude-sonnet-4.0", ContextWindow: 200_000, ReasoningEfforts: standardReasoningEfforts},
	{ID: "claude-haiku-4.5", ContextWindow: 200_000, ReasoningEfforts: standardReasoningEfforts},
	{ID: "deepseek-3.2", ContextWindow: 128_000, ReasoningEfforts: standardReasoningEfforts},
	{ID: "minimax-m2.5", ContextWindow: 200_000, ReasoningEfforts: standardReasoningEfforts},
	{ID: "minimax-m2.1", ContextWindow: 200_000, ReasoningEfforts: standardReasoningEfforts},
	{ID: "glm-5", ContextWindow: 200_000, ReasoningEfforts: standardReasoningEfforts},
	{ID: "qwen3-coder-next", ContextWindow: 256_000, ReasoningEfforts: standardReasoningEfforts},
}

var providerModels = map[string][]ModelDefinition{
	"openai": {
		{ID: "gpt-5.6", ContextWindow: 372_000, ReasoningEfforts: standardReasoningEfforts},
		{ID: "gpt-5.6-sol", ContextWindow: 372_000, ReasoningEfforts: standardReasoningEfforts},
		{ID: "gpt-5.6-terra", ContextWindow: 372_000, ReasoningEfforts: standardReasoningEfforts},
		{ID: "gpt-5.6-luna", ContextWindow: 372_000, ReasoningEfforts: []string{"low", "medium", "high", "xhigh", "max"}},
	},
	"openai-apikey": {
		{ID: "gpt-5.5", ContextWindow: 1_050_000, ReasoningEfforts: standardReasoningEfforts},
		{ID: "gpt-5.6", ContextWindow: 1_050_000, ReasoningEfforts: standardReasoningEfforts},
		{ID: "gpt-5.6-sol", ContextWindow: 1_050_000, ReasoningEfforts: standardReasoningEfforts},
		{ID: "gpt-5.6-terra", ContextWindow: 1_050_000, ReasoningEfforts: standardReasoningEfforts},
		{ID: "gpt-5.6-luna", ContextWindow: 1_050_000, ReasoningEfforts: standardReasoningEfforts},
		{ID: "gpt-5.6-sol-pro", ContextWindow: 1_050_000, ReasoningEfforts: standardReasoningEfforts},
		{ID: "gpt-5.6-terra-pro", ContextWindow: 1_050_000, ReasoningEfforts: standardReasoningEfforts},
		{ID: "gpt-5.6-luna-pro", ContextWindow: 1_050_000, ReasoningEfforts: standardReasoningEfforts},
	},
	"anthropic": {
		{ID: "claude-fable-5", ContextWindow: 1_000_000}, {ID: "claude-sonnet-5", ContextWindow: 1_000_000},
		{ID: "claude-opus-5", ContextWindow: 1_000_000}, {ID: "claude-opus-4-8", ContextWindow: 1_000_000},
		{ID: "claude-opus-4-7"}, {ID: "claude-opus-4-6"}, {ID: "claude-sonnet-4-6"},
		{ID: "claude-haiku-4-5", ContextWindow: 200_000},
	},
	"kiro":               kiroModels,
	"google-antigravity": antigravityModels,
	"xai": {
		{ID: "grok-4.5", ContextWindow: 500_000, ReasoningEfforts: []string{"low", "medium", "high"}},
		{ID: "grok-4.3", ContextWindow: 1_000_000}, {ID: "grok-4.20-0309-reasoning"},
		{ID: "grok-4.20-0309-non-reasoning"}, {ID: "grok-build-0.1"}, {ID: "grok-composer-2.5-fast"},
	},
	"zenmux":         {{ID: "moonshotai/kimi-k3-free"}, {ID: "moonshotai/kimi-k3"}},
	"github-copilot": {{ID: "gpt-4o"}, {ID: "gpt-4.1"}, {ID: "gpt-4.1-mini"}, {ID: "claude-sonnet-4"}, {ID: "gemini-2.5-pro"}},
	"umans": {
		{ID: "umans-coder", ContextWindow: 262_144, ReasoningEfforts: standardReasoningEfforts},
		{ID: "umans-kimi-k2.7", ContextWindow: 262_144, ReasoningEfforts: standardReasoningEfforts},
		{ID: "umans-flash", ContextWindow: 262_144, ReasoningEfforts: standardReasoningEfforts},
		{ID: "umans-glm-5.2", ContextWindow: 405_504, ReasoningEfforts: []string{"high", "xhigh", "max"}},
		{ID: "umans-glm-5.1", ContextWindow: 202_752, ReasoningEfforts: []string{"high", "xhigh", "max"}},
		{ID: "umans-qwen3.6-35b-a3b", ContextWindow: 262_144, ReasoningEfforts: standardReasoningEfforts},
	},
	"openrouter": {
		{ID: "anthropic/claude-sonnet-5", ContextWindow: 1_000_000},
		{ID: "openai/gpt-5.6", ContextWindow: 1_050_000}, {ID: "openai/gpt-5.6-sol", ContextWindow: 1_050_000},
		{ID: "openai/gpt-5.6-terra", ContextWindow: 1_050_000}, {ID: "openai/gpt-5.6-luna", ContextWindow: 1_050_000},
	},
	"orcarouter": {{ID: "openai/gpt-5.5"}, {ID: "anthropic/claude-opus-4.8"}, {ID: "google/gemini-3.5-flash"}, {ID: "deepseek/deepseek-v4-pro"}, {ID: "orcarouter/auto"}},
	"google": {
		{ID: "gemini-3.6-flash", ContextWindow: 1_048_576, ReasoningEfforts: []string{"minimal", "low", "medium", "high"}},
		{ID: "gemini-3.5-flash", ContextWindow: 1_000_000, ReasoningEfforts: []string{"minimal", "low", "medium", "high"}},
		{ID: "gemini-3.5-flash-lite", ContextWindow: 1_048_576},
		{ID: "gemini-3.1-pro-preview", ReasoningEfforts: []string{"low", "medium", "high"}},
	},
	"deepseek": {
		{ID: "deepseek-chat"}, {ID: "deepseek-reasoner"},
		{ID: "deepseek-v4-pro", ContextWindow: 1_000_000, ReasoningEfforts: []string{"high", "xhigh", "max"}},
		{ID: "deepseek-v4-flash", ContextWindow: 1_000_000, ReasoningEfforts: []string{"high", "xhigh", "max"}},
	},
	"neuralwatt": {
		{ID: "glm-5.2", ReasoningEfforts: standardReasoningEfforts}, {ID: "glm-5.2-fast"},
		{ID: "glm-5.2-short", ReasoningEfforts: standardReasoningEfforts}, {ID: "glm-5.2-short-fast"},
		{ID: "kimi-k2.6"}, {ID: "kimi-k2.6-fast"}, {ID: "kimi-k2.7-code"},
		{ID: "qwen3.5-397b", ReasoningEfforts: standardReasoningEfforts}, {ID: "qwen3.5-397b-fast"},
		{ID: "qwen3.6-35b", ReasoningEfforts: standardReasoningEfforts}, {ID: "qwen3.6-35b-fast"},
	},
	"moonshot":              {{ID: "kimi-k3", ContextWindow: 1_048_576, ReasoningEfforts: []string{"max"}}, {ID: "kimi-k2.7-code", ContextWindow: 262_144}, {ID: "kimi-k2.7-code-highspeed", ContextWindow: 262_144}, {ID: "kimi-k2.6", ContextWindow: 262_144}, {ID: "kimi-k2.5", ContextWindow: 262_144}},
	"kimi":                  {{ID: "k3", ContextWindow: 262_144, ReasoningEfforts: []string{"low", "high", "max"}}, {ID: "k3[1m]", ContextWindow: 1_048_576, ReasoningEfforts: []string{"low", "high", "max"}}, {ID: "kimi-k2.7-code", ContextWindow: 262_144}, {ID: "kimi-k2.7-code-highspeed", ContextWindow: 262_144}, {ID: "kimi-k2.6", ContextWindow: 262_144}, {ID: "kimi-k2.5", ContextWindow: 262_144}, {ID: "kimi-for-coding", ContextWindow: 262_144}},
	"kimi-code":             {{ID: "k3", ContextWindow: 262_144, ReasoningEfforts: []string{"low", "high", "max"}}, {ID: "k3[1m]", ContextWindow: 1_048_576, ReasoningEfforts: []string{"low", "high", "max"}}, {ID: "kimi-k2.7-code", ContextWindow: 262_144}, {ID: "kimi-k2.7-code-highspeed", ContextWindow: 262_144}, {ID: "kimi-k2.6", ContextWindow: 262_144}, {ID: "kimi-k2.5", ContextWindow: 262_144}, {ID: "kimi-for-coding", ContextWindow: 262_144}},
	"zai":                   {{ID: "glm-5.2", ContextWindow: 1_000_000, ReasoningEfforts: standardReasoningEfforts}, {ID: "glm-5.2[1m]", ContextWindow: 1_000_000, ReasoningEfforts: standardReasoningEfforts}, {ID: "glm-5.1"}, {ID: "glm-5"}, {ID: "glm-4.6"}},
	"minimax":               {{ID: "MiniMax-M3", ContextWindow: 1_000_000}, {ID: "MiniMax-M2.7", ContextWindow: 204_800}, {ID: "MiniMax-M2.7-highspeed", ContextWindow: 204_800}, {ID: "MiniMax-M2.5", ContextWindow: 204_800}, {ID: "MiniMax-M2.5-highspeed", ContextWindow: 204_800}},
	"minimax-cn":            {{ID: "MiniMax-M3", ContextWindow: 1_000_000}, {ID: "MiniMax-M2.7", ContextWindow: 204_800}, {ID: "MiniMax-M2.7-highspeed", ContextWindow: 204_800}, {ID: "MiniMax-M2.5", ContextWindow: 204_800}, {ID: "MiniMax-M2.5-highspeed", ContextWindow: 204_800}},
	"cloudflare-workers-ai": {{ID: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"}, {ID: "@cf/qwen/qwq-32b"}, {ID: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b"}, {ID: "@cf/moonshotai/kimi-k2.7-code"}, {ID: "@cf/zai-org/glm-5.2"}, {ID: "@cf/mistralai/mistral-small-3.1-24b-instruct"}},
}

func cloneDefinitions(in []ModelDefinition) []ModelDefinition {
	out := make([]ModelDefinition, len(in))
	for i, model := range in {
		out[i] = model
		out[i].ReasoningEfforts = append([]string(nil), model.ReasoningEfforts...)
	}
	return out
}

// StaticModels returns a defensive copy of the bundled model seed.
func StaticModels(provider string) []ModelDefinition {
	return cloneDefinitions(providerModels[provider])
}
