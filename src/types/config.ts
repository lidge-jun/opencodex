import type { OcxProviderConfig } from "./provider";
import type { CodexAccount } from "./accounts";

/**
 * Claude Code inbound settings (devlog/260711_claude_inbound). Consumed by the
 * /v1/messages surface, the `ocx claude` launcher, and the GUI Claude page.
 */
export interface OcxClaudeCodeConfig {
  /** Kill switch for the /v1/messages inbound (GUI "Claude ON" toggle). Default: enabled. */
  enabled?: boolean;
  /**
   * Verbatim passthrough of unmapped claude/anthropic models to api.anthropic.com with the
   * caller's own sk-ant-* credential (Claude Code subscription OAuth). Default: enabled.
   */
  nativePassthrough?: boolean;
  /** Upstream for the native passthrough (tests/enterprise gateways). Default: https://api.anthropic.com */
  anthropicBaseUrl?: string;
  /**
   * Native passthrough body inactivity budget in SECONDS — raw upstream-byte silence
   * while a read is pending, NOT total duration (slow-but-alive streams never trip it;
   * devlog 260716_passthrough_followups/010). Default 90. Min 1. Exactly 0 disables;
   * negative/non-finite values fall back to the default.
   */
  bodyStallSec?: number;
  /**
   * Native passthrough cumulative body byte cap (streamed SSE and buffered non-stream
   * alike) — an OOM/occupancy guard, not a correctness limit. Default 67108864 (64 MiB).
   * Exactly 0 disables; negative/non-finite values fall back to the default.
   */
  bodyMaxBytes?: number;
  /** Default model slot injected as ANTHROPIC_MODEL by `ocx claude`. */
  model?: string;
  /** Haiku/small-fast slot injected as ANTHROPIC_DEFAULT_HAIKU_MODEL (+ legacy SMALL_FAST). */
  smallFastModel?: string;
  /** Inbound model id remaps: exact id first, then date-stripped (`-\d{8}$`). */
  modelMap?: Record<string, string>;
  /**
   * Explicit classifier model for Claude Code Auto Mode safety checks (e.g. "RelayA/claude-opus-5").
   * When unset, bare classifier requests check modelMap, then same-provider affinity from
   * `claudeCode.model`, then compatible Anthropic-adapter providers, and finally fallbacks.
   */
  classifierModel?: string;
  /**
   * Ordered fallback candidates for Claude Code Auto Mode classifier routing when the primary
   * classifier route is not available.
   */
  classifierFallbacks?: string[];
  /**
  * Inject ANTHROPIC_BASE_URL etc. into the macOS user domain via `launchctl setenv`
  * so plain `claude` commands route through the proxy without `ocx claude`. Reverted
   * on stop/shutdown. Default: false (opt-in). macOS only.
   */
  systemEnv?: boolean;
  /**
   * Auth mode for Claude Code inbound requests — a THREE-state intent.
   *
   * "proxy": inject the dummy ANTHROPIC_AUTH_TOKEN so Claude Code routes through the
   * proxy without a real Anthropic key. "subscription": never inject it. UNSET means
   * AUTO: the mode is resolved from detected Claude auth on every launch and every
   * status read (src/claude/auth-mode.ts), so registering a Claude login switches the
   * behaviour with no migration and no stored state.
   *
   * An explicit value always wins over detection and is never rewritten by the auto
   * logic — that is what makes a manual choice stick (devlog 260726_claude_auth_auto).
   */
  authMode?: "proxy" | "subscription";
  /**
   * ISO timestamp of the one-time authMode migration. Before auto existed, choosing
   * "Subscription" DELETED the key, so a pre-upgrade config cannot distinguish an
   * explicit subscription choice from "never chose". Its ABSENCE identifies a
   * pre-upgrade block; the migration writes it once and never re-runs, so a user who
   * later picks Auto (which deletes authMode) is not silently converted back.
   */
  authModeMigratedAt?: string;
  /**
   * Context-window override for Claude Code/Desktop clients (devlog 136 B6):
   * injected as CLAUDE_CODE_MAX_CONTEXT_TOKENS + DISABLE_COMPACT=1 (the official
   * env pair — recognized claude-shaped ids need both). WARNING: DISABLE_COMPACT
   * turns off auto-compaction. Unset = client defaults.
   */
  maxContextTokens?: number;
  /**
   * Opt-in CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1 injection. Default OFF: opus-shaped
   * aliases already carry output_config.effort on the wire (devlog 136 실측), and
   * forcing effort on every request can leak reasoning params to non-reasoning routes.
   */
  alwaysEnableEffort?: boolean;
  /**
   * Subagent tier slots (devlog 260712 B2): injected as ANTHROPIC_DEFAULT_*_MODEL so
   * Claude Code's Agent-tool aliases (opus/sonnet/haiku/fable + parent-inherit) route
   * to proxy models. haiku falls back to smallFastModel (one effective value feeds
   * both ANTHROPIC_DEFAULT_HAIKU_MODEL and legacy ANTHROPIC_SMALL_FAST_MODEL).
   */
  tierModels?: { opus?: string; sonnet?: string; haiku?: string; fable?: string };
  /**
   * Auto-context (devlog 260712 020): when not false, routed/native models whose
   * authoritative window is > 200k AND >= the compact window get the [1m] marker
   * (Claude Code then accounts 1M) and CLAUDE_CODE_AUTO_COMPACT_WINDOW is injected
   * so compaction fires at the real budget. 2.1.207 semantics (binary-verified):
   * effective compact window = min(believed window, env) — one global env behaves
   * like a per-model floor. Default: enabled. Inert while maxContextTokens is set
   * (the legacy DISABLE_COMPACT pair takes rule-1 precedence in the CLI).
   */
  autoContext?: boolean;
  /** Compact-window tokens for auto-context. Default 829_800 (AUTO_COMPACT_WINDOW_DEFAULT). */
  autoCompactWindow?: number;
  /**
   * Bundled-skill content elision for ROUTED (non-Anthropic) models (devlog 260712
   * 060): Skill-tool results whose skill name matches an entry here are replaced
   * with a short stub in the anthropic->responses translation. Third-party models
   * are not trained on these Anthropic doc bundles, and claude-api alone injects
   * ~136k tokens (GitHub anthropics/claude-code#74473). Native Anthropic
   * passthrough never goes through the translation, so Claude models keep the
   * full content. Default: ["claude-api"]. Empty array = explicitly off.
   */
  blockedSkills?: string[];
  /**
   * Sync the featured subagent roster (config.subagentModels + main model) into
   * ~/.claude/agents/ocx-*.md custom agent definitions at launch (devlog 260712
   * 070) so any routed model is dispatchable as a subagent_type — the Agent
   * tool's model argument is a hard 4-alias enum, but definition frontmatter is
   * free. Only ocx-*.md files are owned/pruned. Default: enabled.
   */
  injectAgents?: boolean;
  /**
   * Optional Claude Code effort pinned in every generated ocx-* subagent
   * definition. Unset inherits the parent session effort.
   */
  subagentEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Claude-originated web-search override. Unset fields inherit the global sidecar settings. */
  webSearchSidecar?: { backend?: "openai" | "anthropic" | "xai" | "gemini" | "exa"; model?: string };
  /** Claude-originated vision override. Unset fields inherit the global sidecar settings. */
  visionSidecar?: { backend?: "openai" | "anthropic" | "routed"; model?: string };
  /** Persisted Claude Desktop four-family routing profile. */
  desktopProfile?: OcxClaudeDesktopProfile;
  /** Auto-reconcile Desktop 3P config when provider catalog changes. Default: enabled. */
  desktopAutoApply?: boolean;
  /**
   * When false, omit `native/*` rows from Claude Desktop show/export/apply. Default: enabled.
   * Routing-sidecar alias decoding is unchanged — only the Desktop model list writer.
   */
  desktopNativeModels?: boolean;
}

export type OcxClaudeDesktopFamily = "opus" | "fable" | "sonnet" | "haiku";

export interface OcxClaudeDesktopAssignment {
  family: OcxClaudeDesktopFamily;
  alias: string;
}

export interface OcxClaudeDesktopProfile {
  version: 1;
  assignments: Record<string, OcxClaudeDesktopAssignment>;
  defaults: Record<OcxClaudeDesktopFamily, string | null>;
  /** SHA-256 fingerprint of the last successfully applied 3P config content. */
  appliedFingerprint?: string;
  /** ISO timestamp of the last successful apply. */
  appliedAt?: string;
}

/**
 * Opt-in archived-session auto-cleanup policy (issue #42 Phase 3).
 * Persisted under `OcxConfig.storageCleanupPolicy`. Default `enabled: false`.
 */
export interface StorageCleanupPolicy {
  /** When false/unset, the engine never mutates. Default false. */
  enabled: boolean;
  /** Run when archived session bytes exceed this threshold. */
  trigger: { archivedBytesOver: number };
  /** Either shrink archives toward a byte floor, or remove the oldest N%. */
  target: { reduceToBytes?: number } | { removeOldestPercent?: number };
  schedule: "startup" | "daily" | "weekly" | "manual";
  /** Default quarantine. Permanent only when explicitly set. */
  mode: "quarantine" | "permanent";
  lastRun?: { at: number; freedBytes: number; removed: number };
  /** Epoch ms when the next scheduled evaluation is due. */
  nextRun?: number;
}

/** 사용자가 대시보드에서 직접 추가한 커스텀 모델 정의. */
export interface OcxCustomModel {
  /** 고유 ID (crypto.randomUUID()) */
  id: string;
  /** 프로바이더 키 (기존 providers[name]) */
  provider: string;
  /** Native provider model id; slashes are allowed and encoded for Codex as provider/<hyphenated-id>. */
  modelId: string;
  /** 인간 가독 표시명 (선택, 슬래시 불가) */
  displayName?: string;
  /** 컨텍스트 윈도우 (토큰) */
  contextWindow?: number;
  /** 입력 모달리티 (선택, 기본 ["text"]) */
  inputModalities?: string[];
  /**
   * Reasoning ladder (Codex labels) this custom row explicitly advertises. An empty array
   * hides the effort control; an omitted key leaves the provider-derived ladder in charge.
   */
  reasoningEfforts?: string[];
  /** Default effort label when `reasoningEfforts` is non-empty. */
  defaultReasoningEffort?: string;
  /**
   * Codex tool calling mode override for this custom model.
   * "code_mode_only" (default) sets entry.tool_mode = "code_mode_only".
   * "shell" leaves tool_mode unset so Codex declares top-level shell tools (exec_command).
   */
  codexToolMode?: "code_mode_only" | "shell";
  /** 추가 시각 (ISO 8601) */
  addedAt?: string;
}

/**
 * A generated `ocx_` data-plane key. `key` is the secret itself and never leaves
 * the server except in the one-time POST /api/keys response; every other surface
 * sees only the masked prefix.
 */
export interface OcxApiKeyEntry {
  id: string;
  name: string;
  key: string;
  createdAt: string;
  pendingRotation?: OcxPendingApiKeyRotation;
}

export interface OcxPendingApiKeyRotation {
  id: string;
  key: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * Durable per-client intent. One key today, deliberately.
 *
 * A top-level `codexEnabled` would force every later client to invent an
 * unrelated name and its own helpers; a ten-key union recreated the coupling
 * that failed two audits, because every phase then had to touch every client's
 * write path. A one-key object keeps the extension point without letting this
 * phase claim ownership over a client it does not implement.
 */
export interface OcxClientIntegrationsConfig {
  /** Durable desired state for native Codex. MISSING MEANS ON. */
  codex?: boolean;
  /** Durable desired state for Grok Build. MISSING MEANS ON. */
  grok?: boolean;
  /** Durable desired state for Claude Desktop. MISSING MEANS ON. */
  "claude-desktop"?: boolean;
}

export interface OcxConfigRebaseProvenance {
  version: 1;
  deletedTopLevelKeys: string[];
}

export type OcxRuntimeRole = "standalone" | "hub" | "client";

export interface OcxHubConfig {
  /** Canonical browser-reachable management origin advertised by a hub. */
  managementPublicOrigin?: string;
  /**
   * Optional management-only listener for a local HTTPS frontend such as Tailscale Serve.
   * The hostname is deliberately not configurable: when enabled the socket is always bound
   * to 127.0.0.1, and only GUI, session-bootstrap, and management API routes are admitted.
   */
  managementIngress?:
    | { enabled: false }
    | { enabled: true; port: number };
}

export interface OcxRemoteGuiConfig {
  /** Exact Tailscale login identities permitted to receive an automatic remote GUI session. */
  allowedTailscaleUsers?: string[];
  /**
   * Retired. Once permitted a one-time pairing exchange over non-loopback plaintext HTTP.
   *
   * Still parsed so an existing config file keeps loading, but it grants nothing: a pairing
   * grant now crosses loopback or authenticated HTTPS only. A persisted `true` is reported
   * once and otherwise ignored. Kept in the type rather than deleted because the schema is
   * strict — dropping the key outright would make an older config fail to load entirely,
   * which is a worse outcome than ignoring one retired field.
   *
   * @deprecated has no effect; remove it from your config.
   */
  allowInsecureHttp?: boolean;
}

export type OcxConnectedClientId = "codex" | "claude";

export interface OcxClientConnectionConfig {
  serverUrl: string;
  managementUrl: string;
  managementTransport: "direct" | "relay";
  selectedClients: OcxConnectedClientId[];
  tokenEnv: "OPENCODEX_API_AUTH_TOKEN";
  apiKeyId: string;
  tokenFingerprint: string;
  protocolVersion: 1;
  connectedAt: string;
  /**
   * sha256/base64url of the catalog bytes this connection wrote, used to tell "still ours"
   * from "edited or replaced" before removing the file on disconnect.
   *
   * Our own hash rather than the hub's ETag: /v1/catalog emits no validator, and this was
   * always an ownership check on local bytes rather than a cache concern.
   */
  catalogFingerprint?: string;
  /**
   * The catalog that was on disk before connect overwrote it, base64-encoded, or the
   * empty string when there was none.
   *
   * Durable because disconnect runs in a different process than connect: an in-memory
   * snapshot only covers a connect that fails and rolls back on the spot. Without this,
   * disconnect deletes the remote catalog and reports a restored native state while the
   * user's own catalog is simply gone.
   */
  priorCatalog?: string;
  catalogSyncedAt?: string;
  pendingOperation?: {
    kind: "rotate";
    rotationId: string;
    newKeyIssuedAt: string;
    oldKeyBackupPath: string;
  };
}

export interface OcxConfig {
  port: number;
  /** Runtime topology role. Absence preserves the historical standalone behavior. */
  runtimeRole?: OcxRuntimeRole;
  /** Hub-only public management metadata. Presence is inert outside the hub role. */
  hub?: OcxHubConfig;
  /** Opt-in remote dashboard issuance policy. Presence is inert outside the hub role. */
  remoteGui?: OcxRemoteGuiConfig;
  /** Remote-hub client state. The admission secret is stored only in service-api-token. */
  client?: OcxClientConnectionConfig;
  /** Opt in to one identical-turn retry when a Responses completion has no text or tool call. */
  emptyCompletionRetry?: boolean;
  /**
   * Whether a login may open a browser on the machine running the proxy.
   *
   * Absent and `true` both mean "open", which is what every existing install
   * already does. Only an explicit `false` declines — for an operator who wants
   * to paste the authorization URL into a different browser profile, or who is
   * driving the dashboard from a different machine than the proxy.
   *
   * Deliberately a boolean and not an "auto" mode: inferring headlessness from
   * SSH_CONNECTION or a missing DISPLAY breaks a working login silently when
   * the guess is wrong.
   */
  oauthOpenBrowser?: boolean;
  /**
   * @deprecated Compatibility-only limit for bounded legacy usage readers.
   * `GET /api/usage` always aggregates the complete ledger.
   */
  managementUsageMaxReadBytes?: number;
  providers: Record<string, OcxProviderConfig>;
  defaultProvider: string;
  /** Persisted state for newly discovered provider models (#2464). Absent keeps legacy "on" behavior. */
  modelDiscovery?: {
    newModelPolicy?: "on" | "off";
    knownModels?: Record<string, {
      ids: string[];
      removed: string[];
      updatedAt: string;
      /** Consecutive successful discoveries in which an active id was absent. */
      missing?: Record<string, number>;
    }>;
    recentArrivals?: Record<string, Array<{ id: string; at: string }>>;
  };
  /** Enable the shipped model alias patterns for providers without an override. */
  defaultModelAliases?: boolean;
  /**
   * Opt-in Cursor Private Inference compatibility rows. When true, `/v1/models`
   * adds `<base-id>--<effort>` selectors for reasoning-capable model ids absent
   * from Cursor's built-in effort table. Omitted/false preserves discovery output.
   */
  cursorEffortRows?: boolean;
  /** Explicit top-level deletion intent used by stale whole-config rebases. */
  configRebaseProvenance?: OcxConfigRebaseProvenance | Record<string, unknown>;
  /** OpenAI provider-contract migration marker (v2 = single `openai` provider with account mode). */
  openaiProviderTierVersion?: 1 | 2;
  /** One-time migration marker for Antigravity's static-catalog defaults. */
  googleAntigravityStaticCatalogVersion?: 1 | 2;
  /** Claude Code inbound + launcher settings. */
  claudeCode?: OcxClaudeCodeConfig;
  /**
   * Per-client durable intent. This phase owns only `codex`; later phases extend
   * one key at a time rather than widening a shared union.
   */
  clientIntegrations?: OcxClientIntegrationsConfig;
  /**
   * Up to 5 Codex-facing catalog ids to feature first. Values may be bare catalog ids,
   * exact account-qualified "<selector>/<native-openai-model>" ids, or routed
   * "<provider>/<model>" ids. With account selectors, one bare native choice can expand
   * into a selector-qualified group; Codex still advertises only the first 5 visible rows.
   */
  subagentModels?: string[];
  /**
   * Optional full picker ordering for the Codex model catalog, independent of the
   * 5-slot `subagentModels` spawn_agent cap. DISPLAY-ONLY: it controls the visual order of
   * the Codex model picker for large routed catalogs (10-20+ models) that would otherwise sort
   * arbitrarily and reshuffle on every rebuild. Values are routed `<provider>/<model>` catalog
   * slugs (matched by exact slug or `provider/id`); native OpenAI passthrough rows and
   * account-qualified native rows are not reordered (order native rows via `subagentModels`).
   * Listed routed rows appear in array order; rows not listed keep their normal display order.
   * `subagentModels`-featured rows keep their top position. When unset or empty, catalog
   * priority is unchanged. This changes ONLY what the user sees in the picker: the spawn_agent
   * candidate set is derived from each row's natural priority and is provably unaffected, even
   * when every routed row is listed (see opencodex_spawn_priority / effectiveSubagentRoster).
   */
  modelPickerOrder?: string[];
  /**
   * Priority-ordered fallback models for spawned sub-agents. When the requested
   * model is quota-exhausted or recently failed, opencodex rewrites the child
   * turn to the next available entry before routing.
   */
  subagentModelFallback?: string[];
  /**
   * Per-primary-model fallback chains for spawned sub-agents, keyed by the
   * requested primary model id (bare native or "provider/model"). Entries for
   * the matching key are consulted after the requested model and before the
   * global `subagentModelFallback` list.
   *
   * This is the supported home for per-role fallback metadata: storing it as
   * `model_fallback` inside `$CODEX_HOME/agents/*.toml` makes Codex >= 0.146
   * reject the whole role file as an unknown field (#1190).
   */
  subagentModelFallbackByModel?: Record<string, string[]>;
  /**
   * TTL (ms) for cached sub-agent model availability probes. Default 60_000.
   */
  subagentModelFallbackPollMs?: number;
  injectionModel?: string;
  /**
   * Opt in to synchronizing the selected injection model into Codex's native
   * sub-agent defaults. Only meaningful while `injectionModel` is set.
   */
  syncCodexSubagentDefaults?: boolean;
  /**
   * Optional reasoning effort the delegation prompt tells the agent to pass in spawn_agent calls
   * (`reasoning_effort` argument). Only meaningful while `injectionModel` is set; validated against
   * the Codex ladder (src/reasoning-effort.ts CODEX_REASONING_LEVELS) at the API boundary.
   */
  injectionEffort?: string;
  /**
   * Explicit sideband websocket base for realtime/live joins, mirroring upstream's
   * `experimental_realtime_ws_base_url`. The value is a ROOT (or a recognized
   * `/realtime`, `/realtime/calls/<id>`, `/live/<id>` endpoint form, which is
   * stripped back to the root); `/v1` is appended during normalization. Intended
   * for local development against a fake realtime server — plaintext `http`/`ws`
   * is accepted only for loopback hosts, and URL userinfo is rejected; both
   * failures close to the canonical `https://api.openai.com/v1`. Configured by
   * editing this file; there is deliberately no management-API or GUI surface.
   */
  experimentalRealtimeWsBaseUrl?: string;
  /**
   * Model ids the user has EXCLUDED from the Grok Build managed block. Absent or empty
   * means "everything visible", which is the historical behaviour — so an existing
   * config keeps the fence it already had.
   *
   * Exclusion list rather than an inclusion list on purpose: a newly added provider
   * model should appear in Grok by default, exactly as it does today. An inclusion list
   * would silently hide every future model behind a switch nobody knew to flip.
   */
  grokExcludedModels?: string[];
  /**
   * When true, OpenAI-routed requests include `service_tier: "priority"` (fast inference).
   * When false, service_tier is stripped so requests use default speed.
   * Undefined = passthrough (don't modify what the client sends).
   */
  fastMode?: boolean;
  /**
   * Windows/macOS SSE passthrough stream shape (#314 mitigation).
   * On Windows, "auto" (default) selects eager relay only on a runtime proven
   * to carry the Bun#32111 fix. On macOS, "auto" always stays on legacy tee and
   * eager relay is explicit-only. "eager-relay" opts into the new relay (and
   * accepts #32111 crash risk on Bun 1.3.14); "legacy-tee" pins the tee path.
   * Persisted in config.json so service users can select the stream shape.
   * See src/lib/bun-stream-caps.ts.
   */
  streamMode?: "auto" | "legacy-tee" | "eager-relay";
  /**
   * Custom override for the injected v2 multi-agent guidance body (the text inside
   * the <multi_agent_mode> tags). After guidance is enabled and the v2 surface and
   * catalog-state gates pass, a configured injectionModel is sufficient to render it;
   * otherwise an eligible roster or fallback is required. Placeholders: `{{model}}` -> the
   * effective preferred model for the request (a bare native model is account-qualified
   * only when the request targets an explicit account selector; unresolved or ambiguous
   * bare values become "", while unresolved explicit routed or account-qualified values
   * remain unchanged),
   * `{{effort}}` -> injectionEffort, `{{roster}}` -> the resolved sub-agent roster
   * block ("" when nothing resolves), `{{fallback}}` -> the configured subagent
   * model fallback guidance block ("" when unset).
   */
  injectionPrompt?: string;
  /**
   * Proxy-authored multi-agent developer guidance. Undefined/true = enabled for
   * backward compatibility; false suppresses both v1 and v2 guidance injection.
   */
  multiAgentGuidanceEnabled?: boolean;
  /**
   * Global hard ceiling for the reasoning effort of EVERY proxied turn (main agent AND
   * sub-agents). Ladder value "low".."max"; incoming efforts ranking above it are rewritten
   * in both request shapes before any adapter or clamp. Unset = no cap. codex-rs converts
   * ultra -> max client-side, so e.g. a "high" cap sends ultra/max-tier turns as high.
   */
  effortCap?: string;
  /**
   * Hard ceiling applied ONLY to sub-agent turns — requests carrying codex-rs's spawned-child
   * markers (`x-openai-subagent` header, or `subagent_kind` inside `x-codex-turn-metadata`).
   * Lets the main agent keep its tier while delegated children are capped. When both caps are
   * set, the lower one wins for sub-agents. See src/server/effort-policy.ts.
   */
  subagentEffortCap?: string;
  /**
   * Models hidden from Codex discovery without blocking direct proxy calls. Routed provider ids
   * are excluded from the catalog + /v1/models entirely. Account-qualified native ids hide only
   * their generated selector row and are omitted from raw /v1/models. BARE native GPT ids hide
   * the bare row plus every generated selector row and omit that model family from raw discovery.
   */
  disabledModels?: string[];
  /** 사용자가 대시보드에서 직접 추가한 커스텀 모델 목록. */
  customModels?: OcxCustomModel[];
  /**
   * Internal, versioned evidence for reconciling custom-model deletions with
   * pre-marker Codex catalog rows. Consumers must parse this defensively so a
   * future state written by a newer binary survives older whole-config saves.
   */
  customModelCatalogMigration?: unknown;
  /**
  * Shadow call intercept: redirect Codex's hard-coded helper calls (title generation,
  * commit messages, skill orchestration) to a user-chosen model. Default intercepted
  * source models: gpt-5.4-mini (older clients) and gpt-5.6-luna (Codex 0.145.0+).
  * Opt-in; disabled by default. Matching requests preserve their configured reasoning effort.
  * All requests for configured shadow source models are intercepted regardless of request kind,
  * except when the replacement intersects the same provider+model source set.
  */
 shadowCallIntercept?: {
   /** When true, requests for known shadow/helper source models are rewritten to the configured model. */
   enabled?: boolean;
   /** Replacement model id (e.g. "gpt-5.5"). */
   model?: string;
   /** Optional override of intercepted source-model prefixes (default: gpt-5.4-mini, gpt-5.6-luna). */
   sourceModels?: string[];
 };
  /**
   * Optional map of blocked model IDs to their replacement model IDs.
   * When configured, incoming requests targeting a blocked model (including
   * account-namespaced and concrete routes) are redirected to the replacement
   * model at the shared routing layer with routeReason "blocked-model-redirect".
   * Unset or omitted by default.
   */
  blockedModelRedirects?: Record<string, string>;
  /**
   * 3-state multi-agent surface override:
   * - "v1": force ALL models to v1 surface (override upstream pins)
   * - "default" | undefined: respect upstream model pins (sol/terra=v2, luna=v1, rest=codex flag)
   * - "v2": force ALL models to v2 surface (override upstream pins)
   */
  multiAgentMode?: "v1" | "default" | "v2";
  /**
   * When `multiAgentMode` is `"v2"`, keep ChatGPT-native catalog rows on v1.
   * Routed parents get v2 tools; Sol/Terra can still spawn Grok/Claude (issue #92).
   */
  keepNativeChatGptOnV1?: boolean;
  /** Experimental, default-off ChatGPT recovery for encrypted V2 routed tasks. */
  agentTaskRecovery?: {
    enabled?: boolean;
    /** ChatGPT model used by the recovery request. Default: gpt-5.6-sol. */
    model?: string;
    /** Recovery request timeout in milliseconds. Default: 45000. */
    timeoutMs?: number;
    /** Maximum in-memory ciphertext-to-assignment entries. Default: 200. */
    cacheEntries?: number;
  };
  /** Provider-level Codex-visible context caps. Values only lower known model context windows. */
  providerContextCaps?: Record<string, number>;
  /** Global Codex-visible context cap value (tokens). Falls back to DEFAULT_PROVIDER_CONTEXT_CAP. */
  contextCapValue?: number;
  /** Bind hostname. Default "127.0.0.1" (loopback only). Set "0.0.0.0" to expose on all interfaces. */
  hostname?: string;
  /**
   * Optional second listener bound to 127.0.0.1 that admits data-plane requests without a
   * credential (issue #1102).
   *
   * Why a separate listener rather than an exemption on the main one: when `hostname` is a
   * wildcard, every caller needs `x-opencodex-api-key`, but a `codex app-server` spawned
   * directly from the resolved entrypoint never goes through the generated shim and so never
   * inherits the token. Exempting "loopback-looking peers" on the public listener would be
   * unsound — `requestIP()` only proves the last transport hop, and Docker Desktop port
   * forwarding, host-network containers, WSL mirrored networking and tunnels all terminate
   * remote connections locally. Binding a second socket to 127.0.0.1 makes the kernel refuse
   * remote connections outright, so there is no address to judge.
   *
   * The public listener's admission policy is unchanged. This adds an explicit local trust
   * surface: every process on the machine can reach it, spend account quota, and consume paid
   * provider credentials. Off by default; not for multi-tenant hosts.
   *
   * The port is required when enabled and must differ from the proxy port. An OS-assigned port
   * would change across restarts, which would break already-running app-servers holding the
   * previous `base_url` — the exact symptom #1102 reported and we disproved for token rotation.
   */
  unauthenticatedLoopbackListener?:
    | { enabled: false }
    | { enabled: true; port: number };
  /**
   * Outbound HTTP(S) proxy URL for provider requests (e.g. "http://user:pass@proxy:8080", or
   * "${HTTPS_PROXY}"-style env reference). Mirrored into HTTP_PROXY/HTTPS_PROXY at startup when
   * those are unset — Bun's fetch honors them for all outbound calls; localhost is excluded.
   * The literal `"auto"` reads the Windows WinINET static proxy (`ProxyEnable`/`ProxyServer`)
   * once at process start; on other platforms, or when the system proxy is off, SOCKS-only,
   * or unreadable, it degrades to direct egress with one log line (#1525). PAC/WPAD and live
   * changes are not followed.
   */
  proxy?: string;
  /**
   * Hosts that bypass `proxy` for OpenCodex's own outbound provider calls, merged into
   * NO_PROXY at startup. Accepts a comma-separated string (NO_PROXY syntax) or an array.
   * Loopback is always excluded regardless of this setting, and an inherited NO_PROXY is
   * preserved — this ADDS entries, it never replaces the environment.
   */
  noProxy?: string | string[];
  /**
   * Upstream stall timeout (seconds). After this many seconds of no upstream data, emits
   * response.incomplete. Default 300. Min 1.
   */
  stallTimeoutSec?: number;
  /** Connect timeout (ms) for upstream fetch — covers DNS, TCP, TLS, and response header. Default 200000. */
  connectTimeoutMs?: number;
  /** Graceful shutdown drain timeout (ms). Active turns are aborted after this deadline. Default 5000. */
  shutdownTimeoutMs?: number;
  /** Advertise supports_websockets so Codex opens the WS endpoint. Default false; set true to opt in. */
  websockets?: boolean;
  /**
   * Opt-in auto-cleanup policy for archived Codex sessions (issue #42 Phase 3).
   * Default OFF (`enabled` false / unset). Never enabled implicitly.
   * See `src/storage/policy.ts`.
   */
  storageCleanupPolicy?: StorageCleanupPolicy;
  /** Generated API keys for external access to the proxy's /v1/responses endpoint. */
  apiKeys?: OcxApiKeyEntry[];
  /** Auto-start/sync the proxy from the Codex shim before launching Codex. Default true. */
  codexAutoStart?: boolean;
  /** Restore an installed shim after a stable external Codex update replaces it. Default true. */
  codexShimAutoRestore?: boolean;
  /**
   * Opt-in authless Codex Desktop routing (#1107). On a loopback bind, inject the dedicated
   * `[model_providers.opencodex]` table with `requires_openai_auth = false` instead of the root
   * `openai_base_url` override, so Desktop opens without a ChatGPT login. Default off; ignored on
   * non-loopback binds, whose admission token contract is unchanged.
   */
  codexDesktopAuthless?: boolean;
  /**
   * Compatibility mode: temporarily rewrite Codex resume-history metadata while the proxy is active
   * so Codex App can show old OpenAI chats and opencodex-created exec chats under its default
   * interactive-source/provider filters. Default true; originals are backed up and restored by
   * `ocx stop` / `ocx restore`. Set false to opt out of history remapping.
   */
  syncResumeHistory?: boolean;
  /** Freshness window (ms) for the per-provider live `/models` cache. Defaults to 5 min. */
  modelCacheTtlMs?: number;
  /** Evictable retained app-state budget in MiB. Default 256; valid 64..4096. */
  appOwnedMemoryBudgetMb?: number;
  /** Anthropic prompt-cache retention: "short" = 5-min ephemeral (default), "long" = 1-hour extended, "none" = disabled. */
  cacheRetention?: "none" | "short" | "long";
  /** Web-search sidecar: route web_search for non-OpenAI models through a gpt-mini via ChatGPT passthrough. */
  webSearchSidecar?: OcxWebSearchSidecarConfig;
  /** Vision sidecar: describe images via a gpt vision model so text-only models can "see" them. */
  visionSidecar?: OcxVisionSidecarConfig;
  /** /v1/images relay for codex's built-in image_gen tool. */
  images?: OcxImagesConfig;
  /** /v1/alpha/search relay for codex's built-in web search client. */
  search?: OcxSearchConfig;
  /** Codex multi-account pool. */
  codexAccounts?: CodexAccount[];
  /** Account ids administratively excluded from future pool selection until resumed. */
  pausedCodexAccountIds?: string[];
  /**
   * Selection order per account id, higher used earlier; absent = 0. Keyed by id
   * rather than stored on `codexAccounts` rows so the Desktop login (`__main__`),
   * which has no row, can be ordered too. Range -100..100.
   */
  codexAccountPriorities?: Record<string, number>;
  /**
   * Account id the operator last selected by hand. Suppresses upward priority
   * preemption until that account crosses the auto-switch threshold. Stores the
   * id (not a flag) so a stale pin cannot outlive the selection it described.
   */
  activeCodexAccountPinned?: string;
  /**
   * Public model-selector namespaces bound to one Codex account. Values are stored account ids;
   * `"@main"` selects the Codex Desktop/main auth.json account. Account display aliases
   * are intentionally separate from these selectors.
   */
  codexAccountNamespaces?: Record<string, string>;
  /**
   * Picker visibility override for account-qualified native models. When omitted, a non-empty
   * selector map remains visible for compatibility with hand-written configurations.
   */
  codexAccountPickerEnabled?: boolean;
  /**
   * Show the GPT-5.3-Codex-Spark weekly window on Codex quota surfaces. Default false.
   *
   * Spark is a single-model window that reads 0% for most operators, and on a multi-account
   * pool it doubles the bar count for information almost nobody acts on. Hidden by default and
   * revealed by an explicit `true`; a malformed value reads as hidden rather than rejecting the
   * whole config.
   */
  showCodexSparkQuota?: boolean;
  /**
   * Opt-in auto-redemption of a main-account Codex reset credit shortly before it expires
   * (#822). Default off. `leadTimeMinutes` (1–60, default 10) is how long before
   * `expires_at` the redeem is attempted; the credit list is re-read upstream right before
   * every dispatch and the request id is journaled first, so a manual redeem or a crash never
   * spends a second credit. A malformed value reads as off.
   */
  resetCreditAutoRedeem?: { enabled?: boolean; leadTimeMinutes?: number };
  /** Active pool account id for next session. undefined = main (passthrough as-is). */
  activeCodexAccountId?: string;
  /** Auto-switch threshold (0-100). Default 80. 0 = disabled. */
  autoSwitchThreshold?: number;
  /** New-session account rotation strategy for the Codex pool. Default quota (today's behaviour). */
  accountPoolStrategy?: OcxAccountPoolRotationStrategy;
  /** Successful new-session binds retained on one round-robin selection. Default 1; range 1..100. */
  accountPoolStickyLimit?: number;
  /** Consecutive non-2xx upstream responses before switching future new threads. Default 3. 0 = disabled. */
  upstreamFailoverThreshold?: number;
  /**
   * Opt-in provider-origin circuit threshold for proven pre-connection reachability failures.
   * Default 0 (disabled); range 0..20. The circuit never counts timeouts or HTTP responses.
   */
  upstreamHostCircuitThreshold?: number;
  /**
   * Opt-in ceiling, in bytes, for a serialized native Responses **passthrough** body. When the
   * built body exceeds it OpenCodex refuses locally instead of sending, naming the size and any
   * embedded image payload. Translated adapter paths are not covered.
   *
   * Omitted or 0 = disabled, which is the default: no implicit ceiling is inferred for any
   * destination. The only measured limit in this codebase is the WebSocket create-frame size,
   * and the same body still succeeds over HTTP SSE, so a default here would refuse requests
   * that work today — on Azure and custom Responses gateways as well, whose limits are unknown.
   */
  maxUpstreamBodyBytes?: number;
  /**
   * Opt-in Anthropic OAuth account pool (#294). Default OFF.
   * Failover on 429 + sticky affinity; new sessions may pick lowest known 5h usage.
   * Experimental — see docs and GUI warning before enabling.
   */
  anthropicAccountPool?: {
    enabled?: boolean;
    /** Usage % threshold for new-session auto-pick. Default 80. 0 = disabled (affinity/active only). */
    autoSwitchThreshold?: number;
    /** New-session rotation strategy. Default quota (today's behaviour). */
    strategy?: OcxAccountPoolRotationStrategy;
    /** Successful new-session binds retained on one round-robin selection. Default 1; range 1..100. */
    stickyLimit?: number;
    /** Usage window for quota-based scoring. Default "five-hour" (today's behaviour). */
    quotaWindow?: OcxAccountPoolQuotaWindow;
  };
  /**
   * Generic OAuth multi-account 429 failover (#2568). Presence-driven by default.
   *
   * Rotates to another logged-in account of the SAME provider when one is rate-limited, for
   * OAuth providers that have no pool of their own — xAI, Cursor, Kimi, GitHub Copilot,
   * Antigravity, Nous. The Codex pool and the Anthropic pool own their own rotation and are
   * excluded; this setting changes neither.
   *
   * With the key absent, rotation activates when a provider has 2 or more eligible stored
   * accounts — the same consent rule API-key pools already apply to a 2+ key pool (#2568d). A
   * single account is a strict no-op. Set `false` to keep strict single-account behaviour;
   * `providers.<name>.oauthAccountFailover` overrides this per provider.
   */
  oauthAccountFailover?: {
    enabled?: boolean;
  };
  /** Virtual `combo/<id>` models spanning concrete provider/model targets (issue #133). */
  combos?: Record<string, OcxComboConfig>;
  /**
   * Routing policy profiles (Router Intelligence, RI-04+): explicitly requested
   * `policy/<id>` (or configured alias) models select among an explicit
   * candidate allowlist using hard capability requirements and deterministic
   * scoring. Existing model ids are never routed through profiles implicitly.
   */
  routingProfiles?: Record<string, OcxRoutingProfileConfig>;
  /** Background proactive token refresh ("Token Guardian"). Off by default; see OcxTokenGuardianConfig. */
  tokenGuardian?: OcxTokenGuardianConfig;
  /** Additional exact origins allowed for CORS (e.g. HTTPS or chrome-extension://<id>). Loopback origins are always allowed. */
  corsAllowOrigins?: string[];
}

export type OcxAccountPoolRotationStrategy = "quota" | "round-robin" | "fill-first";

export type OcxAccountPoolQuotaWindow = "five-hour" | "weekly" | "max-utilization";

export type OcxComboStrategy = "failover" | "round-robin" | "random" | "least-used" | "reset-window";
export type OcxComboDefaultEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/**
 * How a combo derives the reasoning ladder it publishes to the picker.
 *
 * `strict` (default) intersects every advertised ladder, so a target that explicitly
 * advertises no effort control (`reasoningEfforts: []`) empties the combo's picker.
 * `adaptive` excludes those empty ladders from the published intersection, keeping the
 * control usable for a mixed-capability group. Unknown (`undefined`) ladders stay
 * wildcards in both modes. Dispatch is unchanged: each concrete target still resolves
 * its own effort at request time.
 */
export type OcxComboReasoningEffortMode = "strict" | "adaptive";

export interface OcxComboTarget {
  provider: string;
  model: string;
  /** Relative target weight for round-robin batches and random selection. Default 1; valid range 1..10000. */
  weight?: number;
}

export interface OcxComboConfig {
  targets: OcxComboTarget[];
  /** Ordered failover (default), round-robin, weighted random, least-used, or quota reset-window selection. */
  strategy?: OcxComboStrategy;
  /** Successful requests retained on one RR selection batch. Default 1; range 1..100. */
  stickyLimit?: number;
  /** Used when the client omits reasoning.effort. null/omitted leaves the target default unchanged. */
  defaultEffort?: OcxComboDefaultEffort | null;
  /**
   * Picker-ladder derivation policy. Omitted / `"strict"` keeps the legacy rule where an
   * explicitly empty target ladder suppresses the whole combo's effort control.
   */
  reasoningEffortMode?: OcxComboReasoningEffortMode;
  /**
   * Disable image input even when every target supports it.
   * Omitted / `"auto"` keeps automatic capability derivation (default: enabled when
   * the target intersection includes image).
   */
  imageInput?: "auto" | "disabled";
  /**
   * Optional public model name replacing the default `combo/<id>` slug. Bare names
   * without "/" are allowed (e.g. "deepseek-v4-flash") so the combo can answer to a
   * mandated model id; exact-match requests route here before any provider resolution.
   */
  alias?: string;
  /**
   * Explicitly allow a bare OpenAI-native alias (for example `gpt-5.6-sol`) to
   * be represented by this routed combo. Never inferred from `alias`.
   */
  nativeAlias?: boolean;
  /** Display-only label for the public catalog row. Required for native aliases. */
  displayName?: string;
}

export type OcxRoutingUnknownEvidenceMode = "allow" | "penalize" | "exclude";

export interface OcxRoutingProfileCandidate {
  provider: string;
  model: string;
}

export interface OcxRoutingProfileRequirements {
  /** Minimum model context window in tokens. */
  minContextWindow?: number;
  /** Minimum remaining quota headroom fraction (0..1). */
  minQuotaHeadroom?: number;
  tools?: boolean;
  imageInput?: boolean;
  structuredOutput?: boolean;
  reasoningEffort?: string;
  serviceTier?: string;
  localOnly?: boolean;
  remoteAllowed?: boolean;
  /** Special encrypted Codex task readability (ChatGPT forward pool). */
  encryptedCodexTasks?: boolean;
}

export interface OcxRoutingProfileOptimize {
  latency?: number;
  health?: number;
  cost?: number;
  quota?: number;
}

/**
 * Policy for the hard cost ceiling when a candidate has no finite cost
 * estimate. `"allow"` (default) preserves the documented dry-run contract:
 * the cap only excludes evidence known to exceed it, and the candidate's
 * `cost.capOutcome` is `"unknown-allowed"`. `"exclude"` makes the ceiling
 * fail-closed (`cost-limit-unknown` + `capOutcome: "unknown-excluded"`).
 */
export type OcxRoutingUnknownCostCapMode = "allow" | "exclude";

export interface OcxRoutingProfileLimits {
  /** Hard per-request estimated-cost ceiling in USD. */
  maxEstimatedCostUsd?: number;
  /**
   * How `maxEstimatedCostUsd` behaves when the estimate is unknown.
   * Defaults to `"allow"` (eligible + `cost.capOutcome: "unknown-allowed"`);
   * opt in to `"exclude"` for a true hard ceiling.
   */
  onUnknownCost?: OcxRoutingUnknownCostCapMode;
}

export interface OcxRoutingProfileUnknownEvidence {
  capability?: OcxRoutingUnknownEvidenceMode;
  health?: OcxRoutingUnknownEvidenceMode;
  quota?: OcxRoutingUnknownEvidenceMode;
  cost?: OcxRoutingUnknownEvidenceMode;
}

export interface OcxRoutingProfileCompatibilitySuite {
  suiteId: string;
  evidenceLayer: "protocol_conformance" | "live_route_compatibility";
}

export interface OcxRoutingProfileCompatibility {
  requiredSuites?: OcxRoutingProfileCompatibilitySuite[];
  minStatus?: "PROBED" | "VERIFIED";
  maxEvidenceAgeMs?: number;
  unknownEvidence?: OcxRoutingUnknownEvidenceMode;
  degradedEvidence?: OcxRoutingUnknownEvidenceMode;
}

export interface OcxRoutingProfileConfig {
  /**
   * Explicit candidate allowlist (`provider/model` refs). No implicit
   * expansion in v1.
   */
  candidates: OcxRoutingProfileCandidate[];
  /** Optional public model name replacing the default `policy/<id>` slug. */
  alias?: string;
  /** Hard requirements evaluated before scoring. */
  require?: OcxRoutingProfileRequirements;
  /** Optimization weights; normalized deterministically. */
  optimize?: OcxRoutingProfileOptimize;
  limits?: OcxRoutingProfileLimits;
  /** How unknown evidence is handled per dimension. */
  unknownEvidence?: OcxRoutingProfileUnknownEvidence;
  /** Optional Compatibility Lab policy (CL-06). */
  compatibility?: OcxRoutingProfileCompatibility;
}


export interface OcxTokenGuardianConfig {
  /** Global kill-switch. Default false — the guardian does nothing unless explicitly enabled. */
  enabled?: boolean;
  /** Seconds between refresh sweeps. Default 21600 (6h). Min 60. */
  tickSeconds?: number;
  /** Random 0..jitterSeconds added before each sweep to de-synchronize. Default 300. */
  jitterSeconds?: number;
  /** Max concurrent refreshes per sweep. Default 3. Min 1. */
  concurrency?: number;
  /** Extra lead (seconds) beyond one tick when deciding a token is "expiring soon". Default 900. */
  leadSeconds?: number;
  /** First backoff (seconds) after a permanent refresh failure. Default 300. */
  failureBackoffBaseSeconds?: number;
  /** Backoff ceiling (seconds). Default 3600. */
  failureBackoffMaxSeconds?: number;
  /** Optional Codex pool session warmup sweep. Default false to avoid background synthetic traffic. */
  codexWarmupEnabled?: boolean;
  /** Max age before a Codex pool account is revalidated via `/codex/responses`. Default 691200 (8d). */
  codexWarmupMaxAgeSeconds?: number;
  /** Model used for optional Codex pool warmup. Default gpt-5.4-mini. */
  codexWarmupModel?: string;
}

export interface OcxImagesConfig {
  /** Optional custom API-key provider for /v1/images relays. Built-in OpenAI tiers remain automatic. */
  provider?: string;
  /** Upstream timeout (ms) for one image generation/edit call (bridge xAI + /v1/images relay). Default 60000 for the bridge; relay may use a higher default (300000). */
  timeoutMs?: number;
  /** Master switch for the image bridge. Default false — set true to enable paid xAI Grok Imagine generation. */
  bridgeEnabled?: boolean;
  /** xAI image model id. Default "grok-imagine-image-quality" (see DEFAULT_MODEL in images/plan.ts). */
  bridgeModel?: string;
  /** Max image-generation loop iterations before forced-final. Default 3; clamped to [0, 10]. */
  maxRounds?: number;
  /** Max files retained under artifacts/. Oldest deleted when exceeded. Default 200. */
  artifactsKeepCount?: number;
  /** Master switch for the video bridge. Default false — must be explicitly opted in. */
  videoBridgeEnabled?: boolean;
  /** Model for xAI video generation. Default "grok-imagine-video". */
  videoBridgeModel?: string;
  /** Max video-gen rounds before forced-final. Default 2 (video is slower than image). */
  videoMaxRounds?: number;
  /** Per-video generation timeout (ms) including polling. Default 300000 (5 min). */
  videoTimeoutMs?: number;
}

export interface OcxSearchConfig {
  /**
   * Total upstream deadline (ms) for one /v1/alpha/search relay. Default 200000. The endpoint
   * is non-streaming JSON (headers arrive only when the search completes), so this is a whole-
   * request budget — deliberately NOT connectTimeoutMs, which is a header-arrival budget.
   */
  timeoutMs?: number;
}

export interface OcxVisionSidecarConfig {
  /** Master switch. Default: enabled when the selected backend has a usable credential. */
  enabled?: boolean;
  /**
   * Description backend. Unset prefers a usable stored Anthropic OAuth credential, else OpenAI —
   * the historical default order, deliberately unchanged by the union widening (#2188 roadmap
   * 170/180 revised): "routed" describes through the proxy's OWN routing (loopback
   * /v1/chat/completions) with a NAMESPACED "provider/model" describer, is explicit-only, and is
   * never auto-selected from credential availability.
   */
  backend?: "openai" | "anthropic" | "routed";
  /** Vision model that describes images. */
  model?: string;
  /** Max description cache misses admitted in one main-model turn. Zero disables description calls. */
  maxDescriptionsPerTurn?: number;
  /** Sidecar fetch timeout (ms). */
  timeoutMs?: number;
}

export interface OcxWebSearchSidecarConfig {
  /** Master switch. Default: enabled when a forward (ChatGPT) provider exists and the caller is logged in. */
  enabled?: boolean;
  /**
   * Which backend actually runs the server-side search. "openai" replays the hosted web_search via
   * the ChatGPT forward provider (gpt-mini sidecar); "anthropic" runs web_search_20250305 on a Claude
   * model authenticated by the STORED anthropic OAuth credential. "xai" runs Grok hosted web_search
   * and optional x_search through stored Grok OAuth. "gemini" (google_search grounding via the
   * Antigravity CCA transport) and "exa" (non-LLM search JSON via an operator key) are explicit-only
   * and stay inactive until their executors ship. Unset ALWAYS resolves to "openai"; no backend is ever
   * auto-selected from credential availability (that once sent incompatible models to the
   * Anthropic API — see resolveSidecarBackend).
   */
  backend?: "openai" | "anthropic" | "xai" | "gemini" | "exa";
  /** Sidecar model that runs the real server-side web_search (must be a native ChatGPT model). */
  model?: string;
  /**
   * Operator-supplied Exa API key for the "exa" backend. Management GET responses never echo it,
   * and src/lib/redact.ts strips it from any logged structure or error string.
   */
  exaApiKey?: string;
  /**
   * Opt-in X (Twitter) search for the xai backend: adds the hosted x_search tool next to
   * web_search. Limits are doc-validated at the management layer AND in the executor:
   * handles <=20 per list, allow XOR exclude, ISO-8601 dates.
   */
  xSearch?: {
    enabled?: boolean;
    allowedXHandles?: string[];
    excludedXHandles?: string[];
    fromDate?: string;
    toDate?: string;
  };
  /** Reasoning effort for the sidecar — "minimal" (non-thinking) keeps it fast/cheap. */
  reasoning?: string;
  /** Max searches executed per main-model turn (loop guard). */
  maxSearchesPerTurn?: number;
  /** Sidecar fetch timeout (ms). */
  timeoutMs?: number;
  /**
   * Config-file-only deadline (ms) for continuous routed-model response-body raw-byte inactivity
   * during a web-search turn. Default 200000. Must be an integer from 1 through 2147483647.
   */
  routedModelStallTimeoutMs?: number;
  /**
   * Stream the routed model's leading output (text/thinking deltas) live instead of buffering the
   * whole iteration. Live delivery stops at the first tool-call boundary so web_search interception
   * stays atomic. Tradeoff: text the model emits BEFORE deciding to search — which buffered mode
   * silently drops — becomes visible to the client and may partially repeat in the post-search
   * answer. Default: false (buffered, previous behavior).
   */
  streamRoutedModelOutput?: boolean;
}
