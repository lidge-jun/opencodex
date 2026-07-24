export type ProviderAccessGroup =
  | "recurring-or-keyless"
  | "recurring-uncapped"
  | "recurring-credit"
  | "signup-credit";

export const FREE_PROVIDER_ACCESS_GROUPS = {
  "recurring-or-keyless": [
    "agy", "aihorde", "api-airforce", "arcee-ai", "bazaarlink", "blackbox", "bluesminds", "cerebras",
    "cloudflare-ai", "cohere", "coze", "duckduckgo-web", "felo-web", "friendliai", "gemini", "github-models",
    "groq", "hackclub", "huggingchat", "huggingface", "iflytek", "inference-net", "kiro", "liquid", "llm7",
    "mistral", "morph", "muse-spark-web", "nara", "navy", "nlpcloud", "ollama-cloud", "opencode", "openrouter",
    "ovhcloud", "pollinations", "puter", "qwen-web", "reka", "sambanova", "sparkdesk", "t3-web", "uncloseai",
  ],
  "recurring-uncapped": [
    "agnes", "ainative", "aion", "baidu", "glm", "glm-cn", "kilo-gateway", "opencode-zen", "requesty",
    "routeway", "sealion", "siliconflow", "tencent",
  ],
  "recurring-credit": ["bytez", "nous-research"],
  "signup-credit": [
    "agentrouter", "ai21", "baichuan", "deepinfra", "deepseek", "doubao", "fireworks", "freemodel-dev", "glm-cn",
    "hyperbolic", "longcat", "monsterapi", "nebius", "novita", "nscale", "nvidia", "predibase", "publicai", "qoder",
    "scaleway", "sensenova", "stepfun", "together", "vertex",
  ],
} as const satisfies Record<ProviderAccessGroup, readonly string[]>;

export interface FreeDirectoryProvider {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  authKind: "oauth" | "key";
  accessGroups: readonly ProviderAccessGroup[];
  supportLevel: "supported" | "experimental" | "reference";
  verification: "official" | "primary" | "unverified";
  documentationUrl?: string;
  modelsUrl?: string;
  discovery: "live" | "static" | "hybrid" | "unsupported";
  lastVerified: string;
  dashboardUrl?: string;
  keyOptional?: boolean;
  models?: string[];
  liveModels: boolean;
  note?: string;
  googleMode?: "ai-studio" | "vertex";
}

type ConnectableOverride = Partial<Omit<FreeDirectoryProvider, "id" | "accessGroups">>;

const LAST_VERIFIED = "2026-07-23";
const openAi = (baseUrl: string, dashboardUrl: string, extra: Partial<ConnectableOverride> = {}): ConnectableOverride => ({
  baseUrl,
  dashboardUrl,
  adapter: "openai-chat",
  authKind: "key",
  supportLevel: "experimental",
  verification: "primary",
  discovery: "live",
  liveModels: true,
  ...extra,
});

// API roots are limited to documented or primary-source integrations. Consumer-web/session
// providers remain reference-only: this directory never asks users to paste cookies or bypass WAFs.
const CONNECTABLE: Record<string, ConnectableOverride> = {
  kiro: { baseUrl: "https://runtime.us-east-1.kiro.dev", dashboardUrl: "https://kiro.dev", adapter: "kiro", authKind: "oauth", supportLevel: "supported", verification: "official", documentationUrl: "https://kiro.dev/docs/cli/authentication/", discovery: "static", liveModels: false },
  aihorde: openAi("https://oai.aihorde.net/v1", "https://aihorde.net", { modelsUrl: "https://oai.aihorde.net/v1/models" }),
  "arcee-ai": openAi("https://conductor.arcee.ai/v1", "https://conductor.arcee.ai", { verification: "official", documentationUrl: "https://docs.arcee.ai/" }),
  cerebras: openAi("https://api.cerebras.ai/v1", "https://cloud.cerebras.ai/platform/apikeys", { supportLevel: "supported", verification: "official", documentationUrl: "https://inference-docs.cerebras.ai/api-reference/models/list" }),
  "cloudflare-ai": openAi("https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1", "https://dash.cloudflare.com/?to=/:account/ai/workers-ai", { supportLevel: "supported", verification: "official", documentationUrl: "https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/", discovery: "static", liveModels: false, models: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/qwen/qwq-32b"] }),
  cohere: openAi("https://api.cohere.com/compatibility/v1", "https://dashboard.cohere.com/api-keys", { supportLevel: "supported", verification: "official", documentationUrl: "https://docs.cohere.com/reference/list-models", modelsUrl: "https://api.cohere.com/compatibility/v1/models" }),
  friendliai: openAi("https://api.friendli.ai/serverless/v1", "https://suite.friendli.ai", { modelsUrl: "https://api.friendli.ai/serverless/v1/models" }),
  gemini: { baseUrl: "https://generativelanguage.googleapis.com", dashboardUrl: "https://aistudio.google.com/apikey", adapter: "google", authKind: "key", supportLevel: "supported", verification: "official", documentationUrl: "https://ai.google.dev/api/models", discovery: "live", liveModels: true, googleMode: "ai-studio", models: ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"] },
  "github-models": openAi("https://models.github.ai/inference", "https://github.com/settings/tokens", { supportLevel: "supported", verification: "official", documentationUrl: "https://docs.github.com/en/github-models/prototyping-with-ai-models", discovery: "static", liveModels: false, models: ["openai/gpt-4.1", "meta/llama-4-scout-17b-16e-instruct"] }),
  groq: openAi("https://api.groq.com/openai/v1", "https://console.groq.com/keys", { supportLevel: "supported", verification: "official", documentationUrl: "https://console.groq.com/docs/api-reference#models" }),
  hackclub: openAi("https://ai.hackclub.com/proxy/v1", "https://ai.hackclub.com", { modelsUrl: "https://ai.hackclub.com/proxy/v1/models" }),
  huggingface: openAi("https://router.huggingface.co/v1", "https://huggingface.co/settings/tokens", { supportLevel: "supported", verification: "official", documentationUrl: "https://huggingface.co/docs/inference-providers/index", modelsUrl: "https://router.huggingface.co/v1/models" }),
  iflytek: openAi("https://spark-api-open.xf-yun.com/v1", "https://console.xfyun.cn", { verification: "official", documentationUrl: "https://www.xfyun.cn/doc/spark/Web.html" }),
  liquid: openAi("https://inference.liquid.ai/v1", "https://playground.liquid.ai", { modelsUrl: "https://inference.liquid.ai/v1/models" }),
  mistral: openAi("https://api.mistral.ai/v1", "https://console.mistral.ai/api-keys", { supportLevel: "supported", verification: "official", documentationUrl: "https://docs.mistral.ai/api/endpoint/models" }),
  morph: openAi("https://api.morphllm.com/v1", "https://morphllm.com", { verification: "official", documentationUrl: "https://docs.morphllm.com/api-reference/introduction" }),
  "ollama-cloud": openAi("https://ollama.com/v1", "https://ollama.com/settings/keys", { supportLevel: "supported", verification: "official", documentationUrl: "https://docs.ollama.com/cloud", modelsUrl: "https://ollama.com/api/tags" }),
  opencode: openAi("https://opencode.ai/zen/v1", "https://opencode.ai/auth", { supportLevel: "supported", verification: "official", documentationUrl: "https://opencode.ai/docs/zen/", modelsUrl: "https://opencode.ai/zen/v1/models" }),
  openrouter: openAi("https://openrouter.ai/api/v1", "https://openrouter.ai/keys", { supportLevel: "supported", verification: "official", documentationUrl: "https://openrouter.ai/docs/api/api-reference/models/get-models" }),
  ovhcloud: openAi("https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", "https://console.ovhcloud.com", { keyOptional: true, modelsUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models" }),
  pollinations: openAi("https://gen.pollinations.ai/v1", "https://pollinations.ai", { keyOptional: true }),
  reka: openAi("https://api.reka.ai/v1", "https://platform.reka.ai"),
  sambanova: openAi("https://api.sambanova.ai/v1", "https://cloud.sambanova.ai/apis", { supportLevel: "supported", verification: "official", documentationUrl: "https://docs.sambanova.ai/cloud/docs/api-reference/models" }),
  sparkdesk: openAi("https://spark-api-open.xf-yun.com/v1", "https://console.xfyun.cn", { verification: "official", documentationUrl: "https://www.xfyun.cn/doc/spark/Web.html" }),
  agnes: openAi("https://apihub.agnes-ai.com/v1", "https://agnes-ai.com"),
  ainative: openAi("https://api.ainative.studio/api/v1", "https://ainative.studio", { modelsUrl: "https://api.ainative.studio/api/v1/models" }),
  aion: openAi("https://api.aionlabs.ai/v1", "https://aionlabs.ai", { modelsUrl: "https://api.aionlabs.ai/v1/models" }),
  baidu: openAi("https://qianfan.baidubce.com/v2", "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application", { verification: "official", documentationUrl: "https://cloud.baidu.com/doc/WENXINWORKSHOP/s/Fm2vrveyu", discovery: "static", liveModels: false, models: ["ernie-5.1", "ernie-5.0", "ernie-4.5-turbo-128k"] }),
  glm: openAi("https://api.z.ai/api/coding/paas/v4", "https://z.ai/manage-apikey/apikey-list", { supportLevel: "supported", verification: "official", documentationUrl: "https://docs.z.ai/guides/overview/quick-start", discovery: "static", liveModels: false, models: ["glm-5"] }),
  "glm-cn": openAi("https://open.bigmodel.cn/api/coding/paas/v4", "https://open.bigmodel.cn/usercenter/apikeys", { supportLevel: "supported", verification: "official", documentationUrl: "https://docs.bigmodel.cn/cn/api/introduction", discovery: "static", liveModels: false, models: ["glm-4.5-flash"] }),
  "kilo-gateway": openAi("https://api.kilo.ai/api/gateway", "https://kilo.ai", { modelsUrl: "https://api.kilo.ai/api/gateway/models" }),
  "opencode-zen": openAi("https://opencode.ai/zen/v1", "https://opencode.ai/auth", { supportLevel: "supported", verification: "official", documentationUrl: "https://opencode.ai/docs/zen/" }),
  requesty: openAi("https://router.requesty.ai/v1", "https://app.requesty.ai", { modelsUrl: "https://router.requesty.ai/v1/models" }),
  routeway: openAi("https://api.routeway.ai/v1", "https://routeway.ai", { modelsUrl: "https://api.routeway.ai/v1/models" }),
  sealion: openAi("https://api.sea-lion.ai/v1", "https://sea-lion.ai", { discovery: "static", liveModels: false, models: ["aisingapore/Llama-SEA-LION-v3.5-70B-R", "aisingapore/Llama-SEA-LION-v3-70B-IT", "aisingapore/Gemma-SEA-LION-v4-27B-IT", "aisingapore/Qwen-SEA-LION-v4.5-27B-IT", "aisingapore/Qwen-SEA-LION-v4-32B-IT"] }),
  siliconflow: openAi("https://api.siliconflow.cn/v1", "https://cloud.siliconflow.cn/account/ak", { supportLevel: "supported", verification: "official", documentationUrl: "https://docs.siliconflow.cn/en/api-reference/models/get-model-list" }),
  tencent: openAi("https://api.hunyuan.cloud.tencent.com/v1", "https://console.cloud.tencent.com/hunyuan/api-key", { verification: "official", documentationUrl: "https://cloud.tencent.com/document/product/1729/111007", discovery: "static", liveModels: false, models: ["hunyuan-turbos-latest", "hunyuan-t1-latest", "hunyuan-pro", "hunyuan-lite"] }),
  bytez: openAi("https://api.bytez.com/models/v2/openai/v1", "https://bytez.com", { verification: "unverified", documentationUrl: "https://docs.bytez.com/", discovery: "static", liveModels: false, models: ["meta-llama/Llama-3.3-70B-Instruct", "mistralai/Mistral-7B-Instruct-v0.3", "Qwen/Qwen2.5-72B-Instruct"], note: "The recurring-credit classification is retained from the requested catalog, but the current reset terms could not be independently verified." }),
  "nous-research": openAi("https://inference-api.nousresearch.com/v1", "https://portal.nousresearch.com", { discovery: "static", liveModels: false, models: ["Hermes-4-405B", "Hermes-4-70B"] }),
  agentrouter: { baseUrl: "https://agentrouter.org", dashboardUrl: "https://agentrouter.org", adapter: "anthropic", authKind: "key", supportLevel: "experimental", verification: "primary", modelsUrl: "https://agentrouter.org/v1/models", discovery: "live", liveModels: true },
  ai21: openAi("https://api.ai21.com/studio/v1", "https://studio.ai21.com/account/api-key", { supportLevel: "supported", verification: "official", documentationUrl: "https://docs.ai21.com/reference/models" }),
  baichuan: openAi("https://api.baichuan-ai.com/v1", "https://platform.baichuan-ai.com/console/apikey", { verification: "official" }),
  deepinfra: openAi("https://api.deepinfra.com/v1/openai", "https://deepinfra.com/dash/api_keys", { supportLevel: "supported", verification: "official", documentationUrl: "https://deepinfra.com/docs/openai_api" }),
  deepseek: openAi("https://api.deepseek.com", "https://platform.deepseek.com/api_keys", { supportLevel: "supported", verification: "official", documentationUrl: "https://api-docs.deepseek.com/api/list-models" }),
  doubao: openAi("https://ark.cn-beijing.volces.com/api/v3", "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey", { verification: "official" }),
  fireworks: openAi("https://api.fireworks.ai/inference/v1", "https://fireworks.ai/account/api-keys", { supportLevel: "supported", verification: "official", documentationUrl: "https://docs.fireworks.ai/api-reference/list-models", modelsUrl: "https://api.fireworks.ai/v1/accounts/fireworks/models?filter=supports_serverless=true" }),
  "freemodel-dev": openAi("https://api.freemodel.dev/v1", "https://freemodel.dev", { modelsUrl: "https://api.freemodel.dev/v1/models" }),
  hyperbolic: openAi("https://api.hyperbolic.xyz/v1", "https://app.hyperbolic.xyz/settings", { verification: "official" }),
  longcat: openAi("https://api.longcat.chat/openai/v1", "https://longcat.chat", { verification: "official", discovery: "static", liveModels: false, models: ["LongCat-2.0"] }),
  monsterapi: openAi("https://api.monsterapi.ai/v1", "https://monsterapi.ai", { verification: "official" }),
  nebius: openAi("https://api.tokenfactory.nebius.com/v1", "https://studio.nebius.com", { verification: "official" }),
  novita: openAi("https://api.novita.ai/openai/v1", "https://novita.ai/settings/key-management", { supportLevel: "supported", verification: "official", modelsUrl: "https://api.novita.ai/openai/v1/models" }),
  nscale: openAi("https://inference.api.nscale.com/v1", "https://console.nscale.com", { verification: "official" }),
  nvidia: openAi("https://integrate.api.nvidia.com/v1", "https://build.nvidia.com", { supportLevel: "supported", verification: "official", documentationUrl: "https://docs.api.nvidia.com/nim/reference/llm-apis" }),
  publicai: openAi("https://api.publicai.co/v1", "https://publicai.co"),
  scaleway: openAi("https://api.scaleway.ai/v1", "https://console.scaleway.com/generative-api", { verification: "official" }),
  sensenova: openAi("https://token.sensenova.cn/v1", "https://console.sensenova.cn", { verification: "official" }),
  stepfun: openAi("https://api.stepfun.com/v1", "https://platform.stepfun.com", { verification: "official" }),
  together: openAi("https://api.together.xyz/v1", "https://api.together.xyz/settings/api-keys", { supportLevel: "supported", verification: "official", documentationUrl: "https://docs.together.ai/reference/models-1" }),
  vertex: { baseUrl: "https://aiplatform.googleapis.com", dashboardUrl: "https://console.cloud.google.com/vertex-ai", adapter: "google", authKind: "key", supportLevel: "experimental", verification: "official", documentationUrl: "https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference", discovery: "static", liveModels: false, googleMode: "vertex", models: ["gemini-3.1-pro-preview", "gemini-3.1-flash-lite", "gemini-3-flash-preview"], note: "Vertex accepts an express-mode API key here. ADC users can instead configure project and location through the existing Google Vertex provider." },
};

const LABELS: Record<string, string> = {
  agy: "AGY", aihorde: "AI Horde", "api-airforce": "API Airforce", "arcee-ai": "Arcee AI",
  bazaarlink: "BazaarLink", blackbox: "Blackbox", bluesminds: "Bluesminds", "cloudflare-ai": "Cloudflare AI",
  coze: "Coze", "duckduckgo-web": "DuckDuckGo Web", "felo-web": "Felo Web", friendliai: "FriendliAI",
  gemini: "Google Gemini", "github-models": "GitHub Models", huggingchat: "HuggingChat", huggingface: "Hugging Face",
  iflytek: "iFlytek", "inference-net": "Inference.net", llm7: "LLM7", "muse-spark-web": "Muse Spark Web",
  nlpcloud: "NLP Cloud", "ollama-cloud": "Ollama Cloud", ovhcloud: "OVHcloud", "qwen-web": "Qwen Web",
  "t3-web": "T3 Web", uncloseai: "UncloseAI", ainative: "AI Native", baidu: "Baidu Qianfan",
  glm: "Z.AI GLM", "glm-cn": "BigModel GLM (CN)", "kilo-gateway": "Kilo Gateway", "opencode-zen": "OpenCode Zen",
  sealion: "SEA-LION", bytez: "Bytez", "nous-research": "Nous Research", agentrouter: "AgentRouter",
  ai21: "AI21", baichuan: "Baichuan", deepinfra: "DeepInfra", deepseek: "DeepSeek", doubao: "Doubao",
  "freemodel-dev": "FreeModel.dev", nebius: "Nebius", novita: "Novita", nscale: "Nscale", nvidia: "NVIDIA NIM",
  publicai: "PublicAI", qoder: "Qoder", sensenova: "SenseNova", stepfun: "StepFun", vertex: "Google Vertex AI",
};

const referenceNote = "Reference entry only: no safe documented API integration is enabled. Configure it manually only with provider documentation; consumer-web cookies and anti-bot bypasses are intentionally unsupported.";

export const FREE_PROVIDER_DIRECTORY: readonly FreeDirectoryProvider[] = Object.values(FREE_PROVIDER_ACCESS_GROUPS)
  .flat()
  .filter((id, index, ids) => ids.indexOf(id) === index)
  .map(id => {
    const accessGroups = (Object.entries(FREE_PROVIDER_ACCESS_GROUPS) as [ProviderAccessGroup, readonly string[]][])
      .filter(([, ids]) => ids.includes(id))
      .map(([group]) => group);
    const override = CONNECTABLE[id];
    return {
      id,
      label: LABELS[id] ?? id.split("-").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" "),
      adapter: "openai-chat",
      baseUrl: "",
      authKind: "key",
      accessGroups,
      supportLevel: "reference",
      verification: "unverified",
      discovery: "unsupported",
      lastVerified: LAST_VERIFIED,
      liveModels: false,
      ...(!override ? { note: referenceNote } : {}),
      ...override,
    } satisfies FreeDirectoryProvider;
  });
