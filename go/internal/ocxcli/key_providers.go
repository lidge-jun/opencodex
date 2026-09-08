package ocxcli

// keyLoginProvider is the Go-side minimal seed for one key-authenticated
// OpenAI-compatible login (issue #57). It deliberately carries only the fields
// the login flow needs — label/baseUrl/adapter for the row, dashboardUrl for the
// browser prompt, defaultModel for the provider row — and never the model
// classification fields the runtime enriches from the registry. The keyless and
// OAuth tiers are intentionally absent: `opencode-free` needs no login, and
// `kiro` is an import-first OAuth flow that stays TypeScript-owned.
type keyLoginProvider struct {
	Label        string
	BaseURL      string
	Adapter      string
	DashboardURL string
	DefaultModel string
}

// keyLoginProviders is the hand-maintained table (issue #57 decision: a Go-side
// minimal table, not the generated registry) covering the openai-chat key slice
// an operator reaches via `ocx login <name>`. Keep it in lockstep with the
// TypeScript registry entries for the same ids; it is not the source of truth
// for provider classification, only for the login prompt + row seed.
var keyLoginProviders = map[string]keyLoginProvider{
	"zai": {
		Label:        "Z.AI — GLM Coding Plan",
		BaseURL:      "https://api.z.ai/api/coding/paas/v4",
		Adapter:      "openai-chat",
		DashboardURL: "https://z.ai/manage-apikey/apikey-list",
		DefaultModel: "glm-5.3",
	},
	"zhipu-bigmodel-coding": {
		Label:        "Zhipu AI — BigModel Coding Plan",
		BaseURL:      "https://open.bigmodel.cn/api/coding/paas/v4",
		Adapter:      "openai-chat",
		DashboardURL: "https://bigmodel.cn/console/usercenter/apikeys",
		DefaultModel: "glm-5.3",
	},
}
