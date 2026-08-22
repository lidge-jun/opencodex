import type { UpstreamHttpVersion, ReasoningSummaryDelivery, CodexAccountMode } from "./wire";

/**
 * Per-provider proactive-refresh policy. The guardian only ever touches a provider whose EFFECTIVE
 * policy is "proactive"; "lazy-only" keeps today's on-demand refresh, "disabled" forbids the
 * guardian entirely (used for providers whose ToS actively enforces against non-official-client
 * token traffic, e.g. Anthropic subscription OAuth). See devlog 260703_oauth-multi-account-refresh-and-tos.
 */
export type RefreshPolicy = "proactive" | "lazy-only" | "disabled";

export interface OpenRouterProviderRouting {
  /** OpenRouter provider slugs to try first, in priority order. */
  order?: string[];
  /** Restrict routing to these OpenRouter provider slugs. */
  only?: string[];
  /** Whether OpenRouter may use providers outside `order`. Defaults to OpenRouter's policy. */
  allowFallbacks?: boolean;
}

export interface ResponsesItemIdRepairConfig {
  /** Exact `message` item ids that the proxy should rewrite to request-local canonical ids. */
  message?: string[];
  /** Exact `reasoning` item ids that the proxy should rewrite to request-local canonical ids. */
  reasoning?: string[];
  /** Backfill missing `output_item.done` / terminal snapshot ids from the matching output_index. */
  repairMissingTerminalIds?: boolean;
  /**
   * Treat existing message/reasoning ids without the canonical `msg_`/`rs_` prefix (e.g. bare
   * UUIDs from DeepSeek's Responses route) as invalid and mint canonical replacements (#938).
   * function_call ids and call_id pairing are never rewritten.
   */
  repairInvalidIds?: boolean;
}

/**
 * Same-target 429 wait-and-retry policy (`providers.<name>.retryOn429`). When present and not
 * explicitly disabled, the proxy waits and replays the identical request on the same key before
 * any key failover. All fields optional; the runtime applies defaults (attempts=3,
 * intervalMs=5000, maxIntervalMs=60000, respectRetryAfter=true, enabled=true).
 */
export interface RateLimitRetryPolicy {
  /** Master switch. The presence of the object also enables the policy (default true). */
  enabled?: boolean;
  /** Extra replay attempts after the first 429 (1..20, default 3). */
  attempts?: number;
  /** Fixed wait between attempts when the upstream sends no usable Retry-After (default 5000). */
  intervalMs?: number;
  /** Cap for any single wait, including an upstream Retry-After (default 60000). */
  maxIntervalMs?: number;
  /** Prefer the upstream Retry-After header when present and parseable (default true). */
  respectRetryAfter?: boolean;
}

/**
 * User-configured display price for one model (USD per 1M tokens).
 * Mirrors the `Cost4` shape used by the usage cost estimator; structurally
 * compatible so config rows can be lifted directly into price overlays.
 */
export interface ProviderCostOverlay {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface RequestPacingRule {
  /** Evenly spread request starts to this many requests per minute. */
  requestsPerMinute?: number;
  /** Minimum delay between request starts. The slower configured value wins. */
  minIntervalMs?: number;
}

export interface ProviderRequestPacingConfig extends RequestPacingRule {
  /** False preserves legacy behavior with no client-side waiting. */
  enabled: boolean;
  /** Exact upstream model-id overrides; other models inherit the provider rule. */
  models?: Record<string, RequestPacingRule>;
}

export interface FastWire {
  kind: "service-tier" | "anthropic-speed";
  /** Canonical tier name to upstream wire spelling. */
  canonicalToWire: Readonly<Record<string, string>>;
  /** Policy for non-canonical caller-provided tier values. */
  foreignCallerTiers: "verbatim" | "drop";
  /** Anthropic speed headers/betas reserved for the later wire implementation. */
  betas?: readonly string[];
}

/** Durable per-attempt service-tier fact produced at the adapter serialization boundary. */
export interface AttemptTierOutcome {
  canonical?: "priority";
  wireKind?: FastWire["kind"] | null;
  wireValue?: string | null;
  fastOutcome: "not-requested" | "applied" | "downgraded" | "unknown";
  fastDowngradeReason?: "route-unsupported" | "wire-unavailable" | "response-declined";
  callerTierDropped?: boolean;
  callerFastSuppressedByConfig?: boolean;
  confirmation: "confirmed" | "assumed" | "downgraded" | "unknown";
  responseServiceTier?: string;
}

/**
 * Request-local observation inputs captured before the final tier action mutates the parsed view.
 * This is not persisted; the final adapter turns it into AttemptTierOutcome after serialization.
 */
export interface TierObservationContext {
  capability: boolean | undefined;
  eligibility:
    | "eligible"
    | "capability-unsupported"
    | "unclassified"
    | "wire-unavailable"
    | "pin-unavailable";
  fastWire: FastWire | null;
  demandDecision: "force-fast" | "force-default" | "inherit";
  callerTier?: string;
}

export type TierDecision =
  | { readonly kind: "forward-caller" }
  | { readonly kind: "drop" }
  | { readonly kind: "set"; readonly value: string };

/**
 * One configured provider entry. `authMode` (default `"key"`) decides whether same-target 429
 * retries are allowed; OAuth/forward credentials and local runtimes are never replayed.
 */
export interface OcxProviderConfig {
  adapter: string;
  /**
   * Codex tool calling mode for routed models.
   * "code_mode_only" (default) sets entry.tool_mode = "code_mode_only" (unified exec helper tool).
   * "shell" leaves tool_mode unset so Codex declares top-level shell tools (exec_command).
   */
  codexToolMode?: "code_mode_only" | "shell";
  /** Optional outbound request-start pacing shared by this provider and its model overrides. */
  requestPacing?: ProviderRequestPacingConfig;
  /** Cursor MCP compatibility bounds; positive integers when configured. */
  mcpMaxTools?: number;
  mcpMaxSchemaBytes?: number;
  mcpMaxResultBytes?: number;
  /**
   * Per-model wire override, keyed by the upstream native model id (after namespace
   * and combo resolution). A single gateway can front models that speak different
   * wires — Grok needs the Responses API for hosted web_search while a sibling model
   * is fine on chat completions (#404).
   *
   * Only OpenAI-shaped wires may be selected; see MODEL_ADAPTER_OVERRIDE_ALLOWED.
   * Absent or empty means the provider-wide `adapter` applies to everything, exactly
   * as before.
   */
  modelAdapters?: Record<string, string>;
  /**
   * Fast-wire declaration. `null` explicitly disables adapter-derived defaults;
   * absence derives from the final model adapter.
   */
  fastWire?: FastWire | null;
  baseUrl: string;
  /**
   * Optional relative resource path for key-auth openai-responses requests. Must start with `/`
   * and must not include a URL scheme, query string, or fragment. When omitted, the adapter keeps
   * the legacy `/v1/responses` construction.
   */
  responsesPath?: string;
  /**
   * Command Code protocol version sent as `x-command-code-version` on /alpha/generate requests.
   * The internal endpoint's schema drifts with the CLI version; operators can pin a known-good
   * version here instead of waiting for a code change. Absent uses the adapter's current default.
   */
  commandCodeVersion?: string;
  /**
   * Responses upstream that stores nothing server-side (DeepSeek documents "the API
   * is stateless"). Stateful request parameters are dropped, `store` is pinned false,
   * and orphaned tool results left by a replay miss are repaired rather than
   * forwarded to an upstream that cannot resolve their pair.
   */
  statelessResponses?: boolean;
  /**
   * Responses upstream whose parser requires an unambiguous call batch and its matched
   * result batch to remain contiguous. Hook-injected context that splits the batch is
   * preserved after it, and parallel calls stay together with the reasoning turn that produced them.
   */
  requiresAdjacentResponsesToolResults?: boolean;
  /**
   * Provider fallback for canonical Fast capability over an OpenAI `service_tier` wire.
   * This pure tri-state feeds catalog publication, routing eligibility, compatibility
   * fingerprints, and proxy-owned canonical Fast injection on both Responses and Chat routes.
   * Tri-state: `true` lets fast mode inject/remove the canonical field; `false` strips it and
   * never injects, because an upstream documented as not supporting the parameter
   * must not receive it; absent (`undefined`) leaves the provider unclassified — fast mode never
   * injects or translates, and caller values pass only under the final wire's forwarding permission.
   * On Chat, that CallerTierForward permission is `chatServiceTier`; Responses retains passthrough.
   * An explicit config value always wins over the registry default.
   */
  supportsServiceTier?: boolean;
  /** Exact upstream model ids that override the provider-level service-tier capability. */
  modelSupportsServiceTier?: Record<string, boolean>;
  /**
   * Responses upstream whose native contract accepts plaintext reasoning replay
   * (DeepSeek documents reasoning items with plaintext content). When set, the
   * passthrough serializer keeps `reasoning_text` content on replayed reasoning
   * items instead of blanking it the way the ChatGPT backend requires; proxy-minted
   * `ocxr1` envelopes are still stripped because no upstream can decrypt them.
   */
  preserveResponsesReasoningContent?: boolean;
  /**
   * Explicit opt-in for a relay that genuinely fronts OpenAI and can decode native
   * compaction blobs. Absent or false degrades foreign blobs to an opaque note.
   */
  decodesNativeCompactionBlobs?: boolean;
  /**
   * Explicit opt-in for non-registry private-network destinations such as localhost, RFC1918,
   * link-local, or unique-local upstreams. Metadata endpoints remain blocked.
   */
  allowPrivateNetwork?: boolean;
  /**
   * Pin the HTTP version used for upstream provider requests. Bun's fetch negotiates
   * HTTP/2 via TLS ALPN by default; some Cloudflare-fronted SSE endpoints hang on
   * HTTP/2 streaming responses (issue #1668). "http1.1" / "h1" forces HTTP/1.1,
   * "http2" / "h2" forces HTTP/2. Absent or "auto" keeps Bun's default negotiation
   * (current behavior unchanged). Only meaningful for https: base URLs.
  */
  upstreamHttpVersion?: UpstreamHttpVersion;
  /**
   * Google only. When `false`, the AI Studio (direct) path sends Gemini Flash ids
   * unchanged to the wire instead of applying the `-tiered` suffix (`gemini-3.7-flash`
   * -> `gemini-3.7-flash-tiered`). Set this to `false` when the configured upstream still
   * serves the bare ids. Absent (default) keeps the rename.
   */
  directGeminiWireRenames?: boolean;
  /** Keep provider settings on disk but exclude it from routing and model/catalog listings. */
  disabled?: boolean;
  /**
   * Codex account-selection mode. Valid ONLY on the canonical built-in `openai` forward provider.
   * "pool" (default) rotates main + added Codex accounts through the affinity/quota/cooldown/
   * failover engine; "direct" pins the caller's main Codex login and never touches pool state.
   */
  codexAccountMode?: CodexAccountMode;
  apiKey?: string;
  /**
   * Key-auth header style for Anthropic-compatible providers.
   * Defaults to the native Anthropic `x-api-key`; gateways may require
   * `Authorization: Bearer <key>` instead.
   */
  apiKeyTransport?: "x-api-key" | "bearer";
  /**
   * Multi-key pool (API-key twin of OAuth multiauth). `apiKey` always mirrors the ACTIVE
   * entry so routing stays single-key; managed via /api/providers/keys. A legacy bare
   * `apiKey` seeds a one-entry pool on first management touch.
   */
  apiKeyPool?: Array<{ id: string; key: string; label?: string; addedAt?: number }>;
  defaultModel?: string;
  models?: string[];
  /**
   * Fetch the provider's live `/models` endpoint. Defaults to true.
   * Set false when `models` is an intentional allowlist or a provider's live catalog is too large
   * or too flaky for startup/catalog sync.
   */
  liveModels?: boolean;
  /**
   * Per-provider catalog allowlist. When non-empty, ONLY these model ids are emitted to Codex's
   * catalog and `/v1/models` — live discovery still runs, this just narrows what ships (so a proxy
   * exposing thousands of models, or an aggregator like OpenRouter, doesn't bloat the catalog).
   * Empty/undefined = expose all. The admin `/api/models` list is unaffected (it always shows the
   * full set so the user can pick). See devlog issue_052_provider-model-allowlist.
   */
  selectedModels?: string[];
  /** Provider-wide fallback when context metadata is absent; otherwise caps the reported window. */
  contextWindow?: number;
  /** Per-model fallback when context metadata is absent; otherwise caps the reported window. */
  modelContextWindows?: Record<string, number>;
  /** Model-specific Codex catalog input modalities, e.g. ["text"] or ["text", "image"]. */
  modelInputModalities?: Record<string, string[]>;
  /** Model-specific max input token limits. Values cap auto_compact_token_limit. */
  modelMaxInputTokens?: Record<string, number>;
  /**
   * Provider-wide fallback for chat-completions `max_tokens` when the caller omits
   * Responses `max_output_tokens`. Adapters still let an explicit request win.
   */
  defaultMaxOutputTokens?: number;
  /** Model-specific fallback output token budgets. Exact/model-pattern entries beat the provider default. */
  modelMaxOutputTokens?: Record<string, number>;
  /**
   * Per-model display prices (USD per 1M tokens) keyed by exact model id —
   * opencode-style per-model pricing in ocx's flat `modelXxx` convention:
   * `{ "deepseek-v4-flash": { "input": 0.14, "output": 0.28, "cacheRead": 0.0028, "cacheWrite": 0 } }`.
   * User-configured prices win over the built-in jawcode/expected catalogs in
   * the Logs `~$` estimate. Display-time estimation only; never billing. An
   * all-zero entry means "not billable here" and falls through to the catalogs.
   */
  modelCosts?: Record<string, ProviderCostOverlay>;
  headers?: Record<string, string>;
  /** Default provider-routing preferences for models sent through the canonical OpenRouter API. */
  openRouterRouting?: OpenRouterProviderRouting;
  /** Exact model-id overrides for `openRouterRouting`. Each matching entry replaces the default. */
  modelOpenRouterRouting?: Record<string, OpenRouterProviderRouting>;
  /**
   * "key" (default): authenticate upstream with `apiKey`.
   * "forward": relay the caller's incoming auth headers verbatim (OAuth passthrough; gpt only).
   * "oauth": resolve a stored OAuth access token (auto-refreshed) and use it as the Bearer key.
   * Only the openai-responses adapter implements "forward"; openai-chat uses its own key/token.
   * "local": local runtime (Ollama etc.) — no remote key required. Valid only for
   * providers whose registry entry declares authKind "local" (management API enforces).
   */
  authMode?: "key" | "forward" | "oauth" | "local";
  /** Allow an explicitly key/oauth provider to run without a credential (for keyless local proxies). */
  keyOptional?: boolean;
  /**
   * Free-tier pricing flag for UI/catalog (Free badge, Free filter). Not the same as
   * `keyOptional` — free tiers may still require an API key (e.g. NVIDIA NIM free credits).
   */
  freeTier?: boolean;
  /** Optional human note shown in the providers UI (not used for routing). */
  note?: string;
  /** Strip one trailing bracketed suffix from model ids before sending them upstream. */
  modelSuffixBracketStrip?: boolean;
  /**
   * Override the guardian's proactive-refresh policy for this provider. When unset, the provider's
   * built-in risk-tiered default applies (see OAUTH_PROVIDERS in src/oauth/index.ts). Set "proactive"
   * to opt this provider into background refresh; "disabled"/"lazy-only" to forbid/limit it.
   */
  refreshPolicy?: RefreshPolicy;
  /**
   * Provider-wide Codex-visible reasoning tiers for routed models. Use only Codex-supported labels
   * here (`low`, `medium`, `high`, `xhigh`, `max`); translate provider aliases with
   * `reasoningEffortMap` / `modelReasoningEffortMap` below.
   */
  reasoningEfforts?: string[];
  /** Model-specific Codex-visible reasoning tiers. An empty array means “do not expose effort”. */
  modelReasoningEfforts?: Record<string, string[]>;
  /** Model-specific default Codex reasoning tier; must also be present in the visible tier list. */
  modelDefaultReasoningEfforts?: Record<string, string>;
  /**
   * Model-specific Codex reasoning-summary capability. Set false when an OpenAI-compatible
   * Responses backend rejects Codex summary-delivery fields for that model.
   */
  modelSupportsReasoningSummaries?: Record<string, boolean>;
  /**
   * Per-model wire value for Responses `stream_options.reasoning_summary_delivery`.
   * Presence also advertises reasoning-summary support for that routed model.
   */
  modelReasoningSummaryDelivery?: Record<string, ReasoningSummaryDelivery>;
  /**
   * Exact-model hosted tools that win collisions with Codex client tool declarations.
   * Use for non-forward Responses gateways that reserve a hosted tool namespace server-side.
   */
  modelPreferHostedTools?: Record<string, string[]>;
  /**
   * Whether the Responses upstream accepts OpenAI's extended hosted web_search fields.
   * Set false only for a provider whose native contract rejects them; absence preserves
   * passthrough compatibility for OpenAI and unclassified gateways.
   */
  supportsOpenAiWebSearchToolFields?: boolean;
  /**
   * Whether the Responses upstream accepts native custom tools and custom_tool_call items.
   * Set false only for a provider whose native contract rejects them; absence preserves
   * apply_patch passthrough compatibility for OpenAI and unclassified gateways.
   */
  supportsResponsesCustomTools?: boolean;
  /**
   * Provider-local repair for Responses gateways whose lifecycle snapshots omit canonical
   * fields or closing events (#893). Disabled by default and applied only to client-facing
   * SSE/JSON; raw inspection state remains authoritative.
   */
  responsesSnapshotRepair?: boolean;
  /** Provider-wide mapping from Codex effort labels to upstream `reasoning_effort` values. */
  reasoningEffortMap?: Record<string, string>;
  /** Model-specific mapping from Codex effort labels to upstream `reasoning_effort` values. */
  modelReasoningEffortMap?: Record<string, Record<string, string>>;
  /** OpenAI-compatible gateway reasoning wire shape. Default sends `reasoning_effort`. */
  reasoningWireFormat?: "gateway-object";
  /**
   * Model ids that do NOT support a reasoning/thinking parameter. The openai-chat adapter drops
   * reasoning_effort for these even when Codex selects a reasoning level (e.g. xAI grok-build-0.1).
   */
  noReasoningModels?: string[];
  /** Model ids that reject caller-specified temperature. */
  noTemperatureModels?: string[];
  /** Model ids that reject caller-specified top_p. */
  noTopPModels?: string[];
  /** Model ids that reject caller-specified presence/frequency penalty values. */
  noPenaltyModels?: string[];
  /**
   * Model ids whose Chat Completions endpoint rejects `response_format`.
   * Structured-output translation remains enabled by default; this is a narrow
   * per-model compatibility escape hatch for mixed-capability gateways.
   */
  noStructuredOutputModels?: string[];
  /**
   * Allow multiple tool calls per completion. DEFAULT-ON for openai-chat providers (the
   * buffered stream parser assembles interleaved/fragmented multi-call turns safely);
   * set `false` to force `parallel_tool_calls:false` upstream and drop the catalog's
   * `supports_parallel_tool_calls` bit for that provider. Non-chat adapters advertise
   * only on explicit `true`. See devlog/_plan/260709_parallel_tool_calls.
   */
  parallelToolCalls?: boolean;
  /**
   * Opt-in: when `parallelToolCalls` is `false`, actually send `parallel_tool_calls: false`
   * on the `/chat/completions` wire for this provider. By default an opted-out provider only
   * OMITS the field (strict OpenAI-compatible hosts reject unknown knobs), and the NVIDIA NIM
   * baseUrl is the sole built-in exception that pins the wire bit. Some self-hosted gateways
   * (Kimi/GLM-family, vLLM, etc.) do honor `parallel_tool_calls` and keep emitting concurrent
   * tool calls unless it is present; enable this to pin the bit without hardcoding their URL.
   * No effect unless `parallelToolCalls === false`; ignored by non-`openai-chat` adapters.
   */
  pinParallelToolCallsFalse?: boolean;
  /**
   * Opt-in: extend the no-tool-call terminal continuation guard to this provider's
   * `openai-chat` routed turns. The guard (originally Anthropic-only, see
   * devlog/_fin/260706_previous-response-id-400) issues one bounded internal re-ask when a
   * model announces work but ends the turn without emitting a tool call. Self-hosted
   * OpenAI-compatible gateways (GLM/Kimi-family, etc.) hit the same premature-completion
   * pattern, but the heuristic that decides a "suspicious no-tool stop" was tuned on
   * Anthropic turns, so it stays OFF by default for the many registry providers that share
   * the `openai-chat` adapter. Enable only for a provider whose models are known to stop
   * mid-work; non-`openai-chat` adapters ignore this flag.
   */
  terminalContinuationGuard?: boolean;
  /**
   * Opt-in for OpenAI-compatible chat gateways that may close after emitting a complete
   * tool-call delta without `finish_reason` or `[DONE]`. The adapter accepts that EOF only
   * when every pending call has a non-empty name and complete JSON-object arguments;
   * incomplete JSON, missing arguments, and empty streams remain truncation errors.
   */
  openaiChatEofTolerance?: boolean;
  /**
   * Opt-in: forward `prompt_cache_key` to the upstream `/chat/completions` body.
   * OpenAI-specific extension; strict backends (Groq, Cerebras, etc.) reject unknown
   * fields. Default off; only enable for providers that document this parameter.
   */
  promptCacheKey?: boolean;
  /**
   * Opt-in: forward caller `service_tier` values to the upstream `/chat/completions` body.
   * On a classified route it governs foreign values (for example `flex`), not proxy-owned
   * canonical Fast after capability validation. On an unclassified route it governs every caller
   * value, including canonical spellings, because no Fast capability has been validated.
   * OpenAI-specific extension with the same hazard as `promptCacheKey` — strict backends
   * reject unknown fields, and 66 registry providers share the `openai-chat` adapter, so a
   * caller-supplied `service_tier` would otherwise turn working requests into upstream 400s.
   * Exact-model `true` enables canonical Fast capability but does not grant foreign-tier
   * forwarding; provider-level `supportsServiceTier: false` remains a global denial. Default off;
   * only enable for providers that document this parameter on the chat wire.
   */
  chatServiceTier?: boolean;
  /**
   * Provider-local passthrough SSE repair for broken openai-responses gateways that reuse exact
   * placeholder message/reasoning ids or omit the terminal id after a stable added event.
   * Disabled by default; function_call ids and call_id pairing are never rewritten.
   */
  responsesItemIdRepair?: ResponsesItemIdRepairConfig;
  /** Model ids whose tool_choice only accepts `auto` or `none`; forced/named choices are downgraded. */
  autoToolChoiceOnlyModels?: string[];
  /** Model ids that expect prior assistant `reasoning_content` to be preserved in chat history. */
  preserveReasoningContentModels?: string[];
  /**
   * Model ids whose upstream hard-rejects a tool_call continuation missing
   * `reasoning_content` (DeepSeek thinking mode: HTTP 400). When the replay
   * cache misses, the adapter injects a minimal placeholder for these models.
   * Defaults to `preserveReasoningContentModels` when unset; set `[]` to opt
   * out explicitly (e.g. MiniMax, where low effort disables thinking).
   */
  requiresReasoningPlaceholderModels?: string[];
  /**
   * Opt-in same-target 429 retry policy. Codex itself never retries 429 (it retries 5xx only,
   * openai/codex#30471), and single-key pools have no failover, so the proxy waits and replays
   * the identical request on the same key before any failover. Pre-stream only: a 429 arrives
   * before any response bytes are relayed, so the replay is lossless.
   */
  retryOn429?: RateLimitRetryPolicy;
  /**
   * Model ids whose OpenAI-compatible chat endpoint accepts `reasoning_split: true` and returns
   * thinking separately in `reasoning_content` / `reasoning_details` instead of visible content.
   */
  reasoningSplitModels?: string[];
  /**
   * Model ids whose reasoning is a vendor `thinking: {type}` toggle on the
   * chat-completions wire (MiMo v2.x, GLM 5/5.1 style), NOT an OpenAI `reasoning_effort` ladder.
   * The openai-chat adapter translates the mapped effort into the thinking toggle for these.
   */
  thinkingToggleModels?: string[];
  /**
   * Model ids whose reasoning is a `thinking_budget` integer on the chat-completions wire
   * (Qwen3.x style), NOT an OpenAI `reasoning_effort` ladder. The openai-chat adapter maps the
   * Codex effort to a budget fraction.
   */
  thinkingBudgetModels?: string[];
  /** Anthropic-compatible gateways that need custom tool names escaped on the wire. */
  escapeBuiltinToolNames?: boolean;
  /**
   * Anthropic-compatible gateways (e.g. AgentRouter) that may close the stream before
   * `message_stop`. With this enabled the adapter completes an otherwise-clean EOF only when
   * visible text was received or an open tool call has complete JSON-object arguments; all
   * other EOFs remain truncation errors. Absent = strict default behavior.
   */
  anthropicEofTolerance?: boolean;
  /**
   * Model ids that do NOT accept image inputs. The proxy gives them "eyes" via the vision sidecar:
   * attached images are described by a gpt vision model and replaced with text before the call.
   */
  noVisionModels?: string[];
  /**
   * Google adapter mode. "ai-studio" (default) = Generative Language API + x-goog-api-key.
   * "vertex" = Vertex AI project/location endpoints with GCP ADC (or x-goog-api-key).
   * "cloud-code-assist" = Google Antigravity (Cloud Code Assist) OAuth + CCA envelope.
   */
  googleMode?: "ai-studio" | "vertex" | "cloud-code-assist";
  /** Vertex AI GCP project id (or GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT env). */
  project?: string;
  /** Vertex AI location, e.g. "us-central1" or "global" (or GOOGLE_CLOUD_LOCATION env). */
  location?: string;
  /**
   * Cursor adapter only: MCP servers opencodex starts/connects and exposes to the Cursor agent
   * as callable tools. Each entry is spawned (stdio `command`) or connected (`url`) lazily per
   * stream; their tools are advertised to the Cursor server and executed against the live server.
   */
  mcpServers?: Record<string, import("../adapters/cursor/mcp-config").CursorMcpServerConfig>;
  /**
   * Cursor adapter only: opt-in external executor for computer-use / record-screen. opencodex is
   * headless and cannot control a screen itself; provide commands here only when running on a host
   * that can. With no executor, these tools honestly report "not supported".
   */
  desktopExecutor?: import("../adapters/cursor/native-exec-desktop").DesktopExecutorConfig;
  /**
   * Cursor adapter only: unsafe opt-in escape hatch for Cursor server-driven built-in local
   * read/write/delete/ls/grep/shell/fetch execution. Prefer `nativeLocalExec: "on"` for new
   * configs; this legacy boolean remains a server-local explicit opt-in for existing operators.
   * Defaults to false so remote Cursor messages cannot bypass Codex approval/sandbox semantics.
   * Explicit MCP and desktop executors remain controlled by their own opt-in config.
   */
  unsafeAllowNativeLocalExec?: boolean;
  /**
   * Cursor adapter only: native local exec policy mode (exec-policy.ts).
   * "off" (default) rejects server-driven local exec; "on" always allows it for this
   * provider and should be used only for a trusted local experiment on a host where every
   * data-plane caller is trusted. "codex-sandbox" is accepted for backwards compatibility
   * but is fail-closed like "off": Responses instructions/system/developer text is
   * caller-controlled prose, and opencodex has no trustworthy per-request attestation that it
   * reflects a real Codex sandbox state. The default loopback bind admits ANY local process
   * without auth (including other local users on multi-user machines), and
   * isAllowedRequestOrigin blocks non-loopback browser origins by default but not
   * loopback-origin or origin-less callers.
   */
  nativeLocalExec?: "off" | "codex-sandbox" | "on";
}
