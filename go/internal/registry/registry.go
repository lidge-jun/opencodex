package registry

import (
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type AuthKind string

const (
	AuthForward AuthKind = "forward"
	AuthOAuth   AuthKind = "oauth"
	AuthKey     AuthKind = "key"
	AuthLocal   AuthKind = "local"
)

// Provider describes one built-in upstream and its static catalog seed.
type Provider struct {
	ID                         string
	Label                      string
	Adapter                    string
	BaseURL                    string
	AuthKind                   AuthKind
	DefaultModel               string
	DashboardURL               string
	OAuthID                    string
	CodexAccountMode           string
	Featured                   bool
	DashboardPreset            bool
	LiveModels                 bool
	KeyOptional                bool
	FreeTier                   bool
	AllowBaseURLOverride       bool
	AllowPrivateNetworkDefault bool
	StaticHeaders              map[string]string
	Models                     []ModelDefinition
}

func p(id, label, adapter, baseURL string, auth AuthKind) Provider {
	return Provider{ID: id, Label: label, Adapter: adapter, BaseURL: baseURL, AuthKind: auth}
}

// Providers is the canonical 58-provider registry, in dashboard display order.
var Providers = func() []Provider {
	rows := []Provider{
		p("openai", "OpenAI (Codex login)", "openai-responses", "https://chatgpt.com/backend-api/codex", AuthForward),
		p("cursor", "Cursor (experimental)", "cursor", "https://api2.cursor.sh", AuthOAuth),
		p("xai", "xAI Grok", "openai-chat", "https://api.x.ai/v1", AuthOAuth),
		p("anthropic", "Anthropic Claude", "anthropic", "https://api.anthropic.com", AuthOAuth),
		p("anthropic-apikey", "Anthropic (API key)", "anthropic", "https://api.anthropic.com", AuthKey),
		p("kimi", "Kimi (Moonshot login)", "openai-chat", "https://api.kimi.com/coding/v1", AuthOAuth),
		p("kiro", "Kiro (AWS CodeWhisperer)", "kiro", "https://runtime.us-east-1.kiro.dev", AuthOAuth),
		p("openai-apikey", "OpenAI API", "openai-responses", "https://api.openai.com/v1", AuthKey),
		p("umans", "Umans AI Coding Plan", "anthropic", "https://api.code.umans.ai", AuthKey),
		p("opencode-go", "opencode go", "openai-chat", "https://opencode.ai/zen/go/v1", AuthKey),
		p("neuralwatt", "NeuralWatt", "openai-chat", "https://api.neuralwatt.com/v1", AuthKey),
		p("openrouter", "OpenRouter", "openai-chat", "https://openrouter.ai/api/v1", AuthKey),
		p("orcarouter", "OrcaRouter", "openai-chat", "https://api.orcarouter.ai/v1", AuthKey),
		p("groq", "Groq", "openai-chat", "https://api.groq.com/openai/v1", AuthKey),
		p("google", "Google Gemini", "google", "https://generativelanguage.googleapis.com", AuthKey),
		p("google-vertex", "Google Vertex AI", "google", "https://aiplatform.googleapis.com", AuthKey),
		p("google-antigravity", "Google Antigravity", "google", "https://daily-cloudcode-pa.googleapis.com", AuthOAuth),
		p("azure-openai", "Azure OpenAI", "azure-openai", "https://{resource}.openai.azure.com/openai", AuthKey),
		p("ollama", "Ollama (local)", "openai-chat", "http://localhost:11434/v1", AuthLocal),
		p("vllm", "vLLM (local)", "openai-chat", "http://localhost:8000/v1", AuthLocal),
		p("lm-studio", "LM Studio (local)", "openai-chat", "http://localhost:1234/v1", AuthLocal),
		p("deepseek", "DeepSeek", "openai-chat", "https://api.deepseek.com", AuthKey),
		p("cerebras", "Cerebras", "openai-chat", "https://api.cerebras.ai/v1", AuthKey),
		p("together", "Together", "openai-chat", "https://api.together.xyz/v1", AuthKey),
		p("fireworks", "Fireworks", "openai-chat", "https://api.fireworks.ai/inference/v1", AuthKey),
		p("firepass", "Fire Pass (Fireworks Kimi)", "openai-chat", "https://api.fireworks.ai/inference/v1", AuthKey),
		p("moonshot", "Moonshot (Kimi API)", "openai-chat", "https://api.moonshot.ai/v1", AuthKey),
		p("huggingface", "Hugging Face", "openai-chat", "https://router.huggingface.co/v1", AuthKey),
		p("nvidia", "NVIDIA NIM", "openai-chat", "https://integrate.api.nvidia.com/v1", AuthKey),
		p("venice", "Venice", "openai-chat", "https://api.venice.ai/api/v1", AuthKey),
		p("zai", "Z.AI — GLM Coding Plan", "openai-chat", "https://api.z.ai/api/coding/paas/v4", AuthKey),
		p("nanogpt", "NanoGPT", "openai-chat", "https://nano-gpt.com/api/v1", AuthKey),
		p("synthetic", "Synthetic", "openai-chat", "https://api.synthetic.new/openai/v1", AuthKey),
		p("siliconflow", "SiliconFlow", "openai-chat", "https://api.siliconflow.cn/v1", AuthKey),
		p("qwen-cloud", "Qwen Cloud", "openai-chat", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", AuthKey),
		p("tencent-coding-plan", "Tencent Cloud Coding Plan", "openai-chat", "https://api.lkeap.cloud.tencent.com/coding/v3", AuthKey),
		p("qianfan", "Qianfan (Baidu)", "openai-chat", "https://qianfan.baidubce.com/v2", AuthKey),
		p("alibaba", "Alibaba Coding Plan", "openai-chat", "https://coding-intl.dashscope.aliyuncs.com/v1", AuthKey),
		p("alibaba-token-plan", "Alibaba Token Plan (Beijing)", "openai-chat", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", AuthKey),
		p("alibaba-token-plan-intl", "Alibaba Token Plan (International)", "openai-chat", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", AuthKey),
		p("parallel", "Parallel", "openai-chat", "https://platform.parallel.ai", AuthKey),
		p("zenmux", "ZenMux", "openai-chat", "https://zenmux.ai/api/v1", AuthKey),
		p("litellm", "LiteLLM (self-hosted)", "openai-chat", "http://localhost:4000/v1", AuthKey),
		p("ollama-cloud", "Ollama Cloud", "openai-chat", "https://ollama.com/v1", AuthKey),
		p("mistral", "Mistral", "openai-chat", "https://api.mistral.ai/v1", AuthKey),
		p("minimax", "MiniMax — Coding Plan", "openai-chat", "https://api.minimax.io/v1", AuthKey),
		p("minimax-cn", "MiniMax — Coding Plan (CN)", "openai-chat", "https://api.minimaxi.com/v1", AuthKey),
		p("kimi-code", "Kimi (coding)", "openai-chat", "https://api.kimi.com/coding/v1", AuthKey),
		p("opencode-zen", "opencode zen", "openai-chat", "https://opencode.ai/zen/v1", AuthKey),
		p("vercel-ai-gateway", "Vercel AI Gateway", "openai-chat", "https://ai-gateway.vercel.sh/v1", AuthKey),
		p("opencode-free", "OpenCode Free", "openai-chat", "https://opencode.ai/zen/v1", AuthKey),
		p("xiaomi", "Xiaomi MiMo", "anthropic", "https://api.xiaomimimo.com/anthropic", AuthKey),
		p("kilo", "Kilo", "openai-chat", "https://api.kilo.ai/api/gateway", AuthKey),
		p("mimo-free", "MiMo Free", "mimo-free", "https://api.xiaomimimo.com/api/free-ai/openai/chat", AuthKey),
		p("cloudflare-ai-gateway", "Cloudflare AI Gateway", "anthropic", "https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic", AuthKey),
		p("cloudflare-workers-ai", "Cloudflare Workers AI", "openai-chat", "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1", AuthKey),
		p("github-copilot", "GitHub Copilot", "openai-chat", "https://api.githubcopilot.com", AuthOAuth),
		p("gitlab-duo", "GitLab Duo", "openai-chat", "https://cloud.gitlab.com/ai/v1/proxy/openai/v1", AuthKey),
	}
	for i := range rows {
		rows[i].Models = StaticModels(rows[i].ID)
		if rows[i].ID == "anthropic-apikey" {
			rows[i].Models = StaticModels("anthropic")
		}
	}
	rows[0].CodexAccountMode, rows[0].Featured = "pool", true
	for _, id := range []string{"xai", "anthropic", "anthropic-apikey", "kimi", "openai-apikey", "umans", "opencode-go", "openrouter", "groq", "google", "azure-openai", "ollama", "vllm", "lm-studio", "opencode-free", "mimo-free"} {
		for i := range rows {
			if rows[i].ID == id {
				rows[i].Featured = true
			}
		}
	}
	for i := range rows {
		switch rows[i].ID {
		case "cursor":
			rows[i].DashboardPreset, rows[i].LiveModels, rows[i].DefaultModel = true, true, "auto"
		case "xai":
			rows[i].OAuthID, rows[i].LiveModels, rows[i].DefaultModel = "xai", true, "grok-4.5"
		case "anthropic":
			rows[i].OAuthID, rows[i].DefaultModel = "anthropic", "claude-sonnet-5"
		case "anthropic-apikey":
			rows[i].DefaultModel, rows[i].LiveModels = "claude-sonnet-5", true
		case "kimi":
			rows[i].OAuthID, rows[i].DefaultModel = "kimi", "kimi-k2.7-code"
		case "kiro":
			rows[i].OAuthID, rows[i].DefaultModel = "kiro", "kiro-auto"
		case "google-antigravity":
			rows[i].OAuthID, rows[i].DefaultModel = "google-antigravity", "gemini-3.6-flash"
		case "openai-apikey":
			rows[i].DefaultModel, rows[i].LiveModels = "gpt-5.5", true
		case "umans":
			rows[i].DefaultModel = "umans-coder"
		case "opencode-go":
			rows[i].DefaultModel = "kimi-k2.7-code"
		case "neuralwatt":
			rows[i].DefaultModel = "glm-5.2"
		case "google":
			rows[i].DefaultModel = "gemini-3.5-flash"
		case "deepseek":
			rows[i].DefaultModel = "deepseek-v4-flash"
		case "zai":
			rows[i].DefaultModel = "glm-5.2"
		case "moonshot":
			rows[i].DefaultModel = "kimi-k2.7-code"
		case "minimax", "minimax-cn":
			rows[i].DefaultModel = "MiniMax-M3"
		case "kimi-code":
			rows[i].DefaultModel = "kimi-k2.7-code"
		case "github-copilot":
			rows[i].LiveModels, rows[i].DefaultModel = true, "gpt-4o"
		case "ollama", "vllm", "lm-studio":
			rows[i].AllowPrivateNetworkDefault, rows[i].AllowBaseURLOverride = true, true
		case "litellm":
			rows[i].AllowPrivateNetworkDefault, rows[i].AllowBaseURLOverride, rows[i].KeyOptional = true, true, true
		case "opencode-free":
			rows[i].KeyOptional, rows[i].LiveModels = true, true
		case "mimo-free":
			rows[i].KeyOptional, rows[i].LiveModels, rows[i].DefaultModel = true, true, "mimo-auto"
		case "nvidia", "cloudflare-workers-ai":
			rows[i].FreeTier = true
		case "siliconflow", "tencent-coding-plan":
			rows[i].LiveModels = true
		case "zenmux":
			rows[i].LiveModels = true
		}
	}
	dashboards := map[string]string{
		"anthropic-apikey": "https://console.anthropic.com/settings/keys", "openai-apikey": "https://platform.openai.com/api-keys",
		"umans": "https://app.umans.ai/billing", "opencode-go": "https://opencode.ai/auth", "neuralwatt": "https://portal.neuralwatt.com",
		"openrouter": "https://openrouter.ai/keys", "orcarouter": "https://www.orcarouter.ai/console", "groq": "https://console.groq.com/keys",
		"google": "https://aistudio.google.com/apikey", "google-vertex": "https://console.cloud.google.com/vertex-ai", "google-antigravity": "https://antigravity.google",
		"azure-openai": "https://portal.azure.com", "deepseek": "https://platform.deepseek.com/api_keys", "cerebras": "https://cloud.cerebras.ai/platform/apikeys",
		"together": "https://api.together.xyz/settings/api-keys", "fireworks": "https://fireworks.ai/account/api-keys", "firepass": "https://fireworks.ai/account/api-keys",
		"moonshot": "https://platform.moonshot.ai/console/api-keys", "huggingface": "https://huggingface.co/settings/tokens", "nvidia": "https://build.nvidia.com",
		"venice": "https://venice.ai/settings/api", "zai": "https://z.ai/manage-apikey/apikey-list", "nanogpt": "https://nano-gpt.com/api",
		"synthetic": "https://synthetic.new", "siliconflow": "https://cloud.siliconflow.cn/account/ak", "qwen-cloud": "https://docs.qwencloud.com",
		"tencent-coding-plan": "https://console.cloud.tencent.com/tokenhub/codingplan", "alibaba": "https://dashscope.console.aliyun.com/apiKey",
		"zenmux": "https://zenmux.ai", "mistral": "https://console.mistral.ai/api-keys", "minimax": "https://platform.minimax.io", "minimax-cn": "https://platform.minimaxi.com",
		"opencode-zen": "https://opencode.ai/auth", "vercel-ai-gateway": "https://vercel.com/dashboard", "opencode-free": "https://opencode.ai",
		"xiaomi": "https://xiaomimimo.com", "kilo": "https://kilo.ai", "mimo-free": "https://xiaomimimo.com", "github-copilot": "https://github.com/settings/copilot",
	}
	for i := range rows {
		if dashboard := dashboards[rows[i].ID]; dashboard != "" {
			rows[i].DashboardURL = dashboard
		}
	}
	return rows
}()

type ProviderRegistry struct {
	mu      sync.RWMutex
	entries []Provider
	byID    map[string]int
}

func New(entries ...Provider) *ProviderRegistry {
	if len(entries) == 0 {
		entries = Providers
	}
	r := &ProviderRegistry{entries: make([]Provider, 0, len(entries)), byID: make(map[string]int, len(entries))}
	for _, entry := range entries {
		if entry.ID == "" {
			continue
		}
		entry.Models = cloneDefinitions(entry.Models)
		entry.StaticHeaders = cloneStringMap(entry.StaticHeaders)
		if index, ok := r.byID[entry.ID]; ok {
			r.entries[index] = entry
			continue
		}
		r.byID[entry.ID] = len(r.entries)
		r.entries = append(r.entries, entry)
	}
	return r
}

func cloneStringMap(in map[string]string) map[string]string {
	if in == nil {
		return nil
	}
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func cloneProvider(entry Provider) Provider {
	entry.Models = cloneDefinitions(entry.Models)
	entry.StaticHeaders = cloneStringMap(entry.StaticHeaders)
	return entry
}

func (r *ProviderRegistry) Lookup(id string) (Provider, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	index, ok := r.byID[id]
	if !ok {
		return Provider{}, false
	}
	return cloneProvider(r.entries[index]), true
}

func (r *ProviderRegistry) Entries() []Provider {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Provider, len(r.entries))
	for i, entry := range r.entries {
		out[i] = cloneProvider(entry)
	}
	return out
}

func (r *ProviderRegistry) ResolveModel(selector string) (*types.ResolvedModel, error) {
	selector = strings.TrimSpace(selector)
	if selector == "" {
		return nil, fmt.Errorf("resolve model: selector is empty")
	}
	providerID, modelID := "openai", selector
	if slash := strings.IndexByte(selector, '/'); slash >= 0 {
		providerID, modelID = selector[:slash], selector[slash+1:]
	}
	provider, ok := r.Lookup(providerID)
	if !ok {
		return nil, fmt.Errorf("resolve model: unknown provider %q", providerID)
	}
	if modelID == "" {
		modelID = provider.DefaultModel
	}
	if modelID == "" {
		return nil, fmt.Errorf("resolve model: model is empty for provider %q", providerID)
	}
	known := make([]string, 0, len(provider.Models))
	for _, model := range provider.Models {
		known = append(known, model.ID)
	}
	modelID = DecodeRoutedModelID(modelID, known)
	return &types.ResolvedModel{Selector: selector, Provider: providerID, Model: modelID}, nil
}

func (r *ProviderRegistry) ResolveTransport(provider string, cred *types.AuthContext) (*types.Transport, error) {
	entry, ok := r.Lookup(provider)
	if !ok {
		return nil, fmt.Errorf("resolve transport: unknown provider %q", provider)
	}
	return ResolveProviderTransport(entry, cred)
}

func (r *ProviderRegistry) ListModels() []types.ModelEntry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []types.ModelEntry
	for _, provider := range r.entries {
		for _, model := range provider.Models {
			id := RoutedSlug(provider.ID, model.ID)
			if provider.ID == "openai" {
				id = model.ID
			}
			out = append(out, types.ModelEntry{ID: id, Provider: provider.ID, DisplayName: model.DisplayName, ReasoningEfforts: append([]string(nil), model.ReasoningEfforts...), ContextWindow: model.ContextWindow})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

var _ types.Registry = (*ProviderRegistry)(nil)
