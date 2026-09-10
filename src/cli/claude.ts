/**
 * `ocx claude [claude args...]` — launch Claude Code through the local proxy,
 * or natively when Claude routing is explicitly disabled.
 *
 * Mirrors `ccr code` UX (devlog/260711_claude_inbound/020, 003 E1/E2/E5/G1):
 * ensures the proxy is running, injects the Anthropic env slots, then execs the
 * `claude` CLI with stdio inherited. User-exported env wins except when a stale
 * loopback opencodex base URL points at a different proxy port.
 */
import { spawn } from "node:child_process";
import { loadConfig } from "../config";
import { injectClaudeAgentDefs } from "../claude/agents-inject";
import { CLAUDE_ALIAS_PREFIX_V1, CLAUDE_ALIAS_PREFIX_V2 } from "../claude/alias";
import { effectiveModelEnv, resolveAutoContext } from "../claude/context-windows";
import { claudeConfigDir, refreshGatewayModelCacheFromProxy } from "../claude/gateway-cache";
import { commandInvocation } from "../lib/win-exec";
import { isProxyAdmissionSecret } from "../server/auth-cors";
import { findLiveProxy } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";
import { configuredAdminToken } from "../lib/admin-secrets";
import { localAdmissionToken, localInferenceDestination, localLoopbackInferencePorts, localManagementOrigin } from "../lib/local-destinations";
import { PROXY_MARKER, ownAdmissionTokens, defaultAuthDetectDeps, detectClaudeAuth, type AuthDetectDeps } from "../claude/auth-detect";
import { resolveClaudeAuthMode } from "../claude/auth-mode";
import { withProcessRuntimeProvenance } from "../lib/bun-runtime";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { ANTHROPIC_PARENT_ENV_SLOTS, trustedNodeLauncherContext, type AnthropicParentEnvSlot } from "./launcher-context";
import { readClientConnectionState, type ClientConnectionState } from "../client/state";
import { resolveHubState } from "../client/hub-state";
import { readServiceApiTokenState, type ServiceApiTokenState } from "../lib/service-secrets";
import { DEFAULT_CATALOG_PATH } from "../codex/paths";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aliasForNative, aliasForRoute } from "../claude/alias";
import { desktop3pAlias } from "../claude/desktop-3p";

export interface ClaudeLaunchEnv {
  [key: string]: string | undefined;
}

export interface ClaudeRoutingTarget {
  baseUrl: string;
  admissionToken: string;
}

/**
 * Injectable IO for tests. `env` is deliberately NOT injectable: it is bound to the
 * launch base so detection and the spawned process can never disagree (audit R3-3).
 */
export type ClaudeEnvDeps = {
  authDetect?: Omit<Partial<AuthDetectDeps>, "env" | "ownTokens">;
  /** Test seam; production uses the authenticated Node-launcher context. */
  preBunAnthropicSlots?: readonly AnthropicParentEnvSlot[] | null;
  /** Explicit unsafe opt-in from a root `--dangerously-skip-permissions` launch. */
  allowRootSkipPermissions?: boolean;
};

function deleteUntrustedAnthropicSlots(env: ClaudeLaunchEnv, deps: ClaudeEnvDeps): void {
  const explicitSlots = deps.preBunAnthropicSlots;
  const trustedSlots = explicitSlots === undefined
    ? trustedNodeLauncherContext()?.anthropicEnvSlots ?? []
    : explicitSlots ?? [];
  const exported = new Set<AnthropicParentEnvSlot>(trustedSlots);
  for (const name of ANTHROPIC_PARENT_ENV_SLOTS) {
    const value = env[name];
    if (value !== undefined && value !== "" && !exported.has(name)) delete env[name];
  }
  delete env.OCX_PRE_BUN_ANTHROPIC_ENV;
  delete env.OCX_NODE_LAUNCH_CONTEXT;
}

/**
 * Read Claude Code's own persisted `/model` picker default.
 *
 * An absent `settings.json` is the ordinary fresh-install case and stays silent. A
 * present-but-unparseable one is not: swallowing it would drop the "saved model requires
 * the proxy" warning exactly when the file is broken, so the native session would start
 * on a model the user never chose with no explanation. Name the file, never its contents.
 */
export function readPickerDefaultModel(configDir: string): string | null {
  const file = join(configDir, "settings.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) { // no-excuse-ok: catch -- an absent picker settings file is the default install state.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`⚠ Could not read Claude Code settings at ${file}; the saved model check is skipped this run.`);
    }
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.model === "string" && parsed.model.trim() !== "" ? parsed.model.trim() : null;
  } catch { // no-excuse-ok: catch -- a corrupt picker file must warn, not abort the launch.
    console.warn(`⚠ Claude Code settings at ${file} are not valid JSON; the saved model check is skipped this run.`);
    return null;
  }
}

function isClaudeLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "[::1]";
}

/**
 * Is this base URL one of OURS?
 *
 * Two ways to be ours (#4236), because a hub has two shapes of local destination:
 *
 *  - a SET of loopback ports, not one port: with an unauthenticated loopback listener the
 *    public port and the listener's port are both addresses this proxy answers on at
 *    127.0.0.1, so a URL naming either of them was written by us. Treating the one this launch
 *    did not pick as a foreign proxy would strip our own admission token out of the
 *    environment. On a tailnet bind with no listener that set is EMPTY, so a leftover
 *    `http://127.0.0.1:<port>` is correctly seen as stale rather than as ours.
 *  - the resolved destination origin itself, which on such a bind is the bind address. Without
 *    this arm the launch would write a base URL and then refuse to recognize it one line later.
 */
function targetsLocalClaudeProxy(
  value: string | undefined,
  ports: readonly number[],
  ownOrigin?: string,
): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    if (parsed.username !== "" || parsed.password !== "") return false;
    if (ownOrigin !== undefined && parsed.origin === ownOrigin) return true;
    const effectivePort = parsed.port === "" ? 80 : Number(parsed.port);
    return parsed.protocol === "http:"
      && isClaudeLoopbackHostname(parsed.hostname)
      && ports.includes(effectivePort);
  } catch {
    return false;
  }
}

function targetsClaudeRoutingTarget(value: string | undefined, target: ClaudeRoutingTarget): boolean {
  if (!value) return false;
  try {
    const actual = new URL(value);
    const expected = new URL(target.baseUrl);
    return actual.origin === expected.origin
      && (actual.pathname === "/" || actual.pathname === "")
      && !actual.username
      && !actual.password;
  } catch {
    return false;
  }
}

/**
 * Pure env assembly (unit-tested): never sets ANTHROPIC_API_KEY (setting both
 * token vars triggers Claude Code's auth-conflict warning, 003 E1), and never
 * preserves Anthropic variables proven to exist in the parent Node launcher,
 * apart from stale loopback ANTHROPIC_BASE_URL values owned by a previous
 * opencodex launch. Unproven ambient values fail closed as project dotenv.
 */
export function buildClaudeEnv(
  config: OcxConfig,
  portOrTarget: number | ClaudeRoutingTarget,
  base: ClaudeLaunchEnv,
  contextWindows: Record<string, number> = {},
  deps: ClaudeEnvDeps = {},
): ClaudeLaunchEnv {
  const explicitTarget = typeof portOrTarget === "number" ? null : portOrTarget;
  const port = typeof portOrTarget === "number" ? portOrTarget : null;
  // A local launch dials the unauthenticated loopback listener whenever one is enabled — the
  // only credential-free local socket a tailnet-bound hub has (#4236). With the listener OFF
  // the destination is the BIND address, which is reachable but demands data-plane admission;
  // the resolver says which of the two this is instead of every caller guessing.
  const destination = port === null ? null : localInferenceDestination(config, port);
  const managedBaseUrl = explicitTarget
    ? new URL(explicitTarget.baseUrl).origin
    : destination!.origin;
  // Every port this proxy answers on at 127.0.0.1, so a base URL naming any of them is ours.
  const ownLocalPorts = port === null ? [] : localLoopbackInferencePorts(config, port);
  const env: ClaudeLaunchEnv = { ...base };
  // Step 1 — strip OUR OWN dummy from the inherited environment before anything reads
  // or writes the token slot. setDefault below preserves any non-empty value, so a
  // stale marker left in place would suppress the admission key and then be removed,
  // leaving the child with no token at all (audit R2-1). It is opencodex state, never
  // user auth, so dropping it unconditionally is safe.
  if (env.ANTHROPIC_AUTH_TOKEN?.trim() === PROXY_MARKER) delete env.ANTHROPIC_AUTH_TOKEN;
  // Step 1b — drop Anthropic credentials AND destinations that Bun may have synthesized
  // from a project `.env`/`.env.local`. The plain-Node launcher records genuine parent
  // exports before Bun starts and pairs that context with an argv proof, so with a
  // trusted context we know exactly which slots the user really exported.
  //
  // Without a trusted context all three slots are treated as project-controlled. An
  // earlier revision of this branch preserved credentials here, reasoning that the
  // destination is pinned below so a dotenv key would only ever reach the local proxy.
  // That reasoning is wrong, and review caught it: `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`
  // is only set when we own an auth token (see below, and #253 for why asserting it
  // otherwise logs a subscriber out), so on a subscription launch Claude Code's
  // settings.env merge can still replace `ANTHROPIC_BASE_URL` after we return. A
  // preserved key then travels to that host. The repository documents that residual for
  // subscription mode; it must not be widened into a credential leak.
  //
  // Direct `bun src/cli/index.ts` therefore loses ambient Anthropic values. That is a
  // real cost to a documented entry point, and the escape hatch is the launcher: run
  // through `ocx` (the published bin) and genuine shell exports are preserved by proof.
  deleteUntrustedAnthropicSlots(env, deps);
  const setDefault = (name: string, value: string | undefined) => {
    if (value === undefined || value.length === 0) return;
    if (env[name] !== undefined && env[name] !== "") return; // user wins
    env[name] = value;
  };
  if (deps.allowRootSkipPermissions === true) {
    setDefault("IS_SANDBOX", "1");
  }
  setDefault("ANTHROPIC_BASE_URL", managedBaseUrl);
  const existingBaseUrl = env.ANTHROPIC_BASE_URL;
  if (existingBaseUrl && port !== null) {
    try {
      const parsed = new URL(existingBaseUrl);
      const effectivePort = parsed.port === "" ? 80 : Number(parsed.port);
      // Stale means "a port no live local listener of ours owns". With a loopback listener
      // enabled that is two ports, and rewriting one of them into the other would reject a
      // destination we wrote ourselves.
      if (parsed.protocol === "http:"
        && isClaudeLoopbackHostname(parsed.hostname)
        && !ownLocalPorts.includes(effectivePort)
        && parsed.origin !== managedBaseUrl) {
        const replacement = managedBaseUrl;
        console.error(`⚠ Replacing stale opencodex ANTHROPIC_BASE_URL ${parsed.origin} with ${replacement}.`);
        env.ANTHROPIC_BASE_URL = replacement;
        // The credentials in this environment were paired with the destination we just
        // replaced. An admission secret minted by that other proxy is not valid here, and
        // leaving it in place makes Claude Code authenticate as a host-managed provider
        // instead of using its own subscription OAuth — the launch then bypasses the
        // subscription-preserving default below. Only OUR OWN admission forms are dropped:
        // a genuine user `sk-ant-` credential is upstream auth that native passthrough
        // needs (server/claude-messages.ts), so it must survive the destination rewrite.
        for (const slot of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const) {
          const value = env[slot]?.trim();
          if (!value) continue;
          if (value === PROXY_MARKER || isProxyAdmissionSecret(value, config)) delete env[slot];
        }
      }
    } catch {
      // Preserve user-provided values that are not parseable URLs.
    }
  }
  // Subscription-preserving default (teamclaude --no-mitm / Vercel gateway pattern):
  // setting ANTHROPIC_AUTH_TOKEN/API_KEY disables claude.ai connectors and overrides
  // the user's Claude login. Resolve the mode before adding any proxy-owned credential:
  // subscription launches must keep their OAuth, while proxy launches may use the
  // admission key or dummy marker (see server/claude-messages.ts).
  // A bind that demands admission needs a credential the machine can actually present, which
  // is wider than `config.apiKeys`: the service installs its data-plane secret as
  // `OPENCODEX_API_AUTH_TOKEN` / the hardened token file, and that is the ladder the Codex
  // provider table already uses. Never the admin token (reviewer constraint on #4236).
  const hostAdmissionToken = destination?.requiresAdmissionToken === true
    ? localAdmissionToken(config)
    : undefined;
  const ownTokens = explicitTarget
    ? [explicitTarget.admissionToken]
    : [...new Set([...(hostAdmissionToken ? [hostAdmissionToken] : []), ...ownAdmissionTokens(config)])];
  const targetsLocalProxy = explicitTarget
    ? targetsClaudeRoutingTarget(env.ANTHROPIC_BASE_URL, explicitTarget)
    : targetsLocalClaudeProxy(env.ANTHROPIC_BASE_URL, ownLocalPorts, managedBaseUrl);
  const isOwnAdmissionToken = (value: string): boolean =>
    ownTokens.includes(value) || isProxyAdmissionSecret(value, config);
  const inheritedApiKey = env.ANTHROPIC_API_KEY;
  if (typeof inheritedApiKey === "string" && isOwnAdmissionToken(inheritedApiKey)) {
    delete env.ANTHROPIC_API_KEY;
  }
  const hasUserApiKey = Boolean(env.ANTHROPIC_API_KEY?.trim());
  const inheritedAuthToken = env.ANTHROPIC_AUTH_TOKEN;
  const inheritedTokenIsOurs = typeof inheritedAuthToken === "string"
    && isOwnAdmissionToken(inheritedAuthToken);
  // system-env may have injected the proxy's admission key into the parent. A
  // proof-bound external BASE_URL is still user-owned, so never let our inherited
  // key follow it. A user API key also wins on a local launch; remove only the token
  // values recognized by the shared proxy-admission contract and preserve every
  // other token.
  if (inheritedTokenIsOurs && (!targetsLocalProxy || hasUserApiKey)) {
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  // Detection reads the sanitized launch env before proxy-owned credentials are added.
  // The provenance strip above removed dotenv-only credentials, and ownTokens keeps a
  // configured admission key from being mistaken for user auth (#701 audit round 2).
  const resolved = resolveClaudeAuthMode(config, detectClaudeAuth({
    ...defaultAuthDetectDeps(env as NodeJS.ProcessEnv),
    ...(deps.authDetect ?? {}),
    env: () => env as NodeJS.ProcessEnv,
    ownTokens,
  }));
  // An explicit connected target is not a subscription launch. The caller named a hub and
  // handed us the client admission token for it, so auth-mode detection - which reads the
  // local environment - has no bearing on whether that token belongs in the child env.
  // Without this, a machine whose environment reads as subscription strips the very
  // credential the connected launch was constructed with (#3148 carry).
  if (resolved.markerMode === "subscription" && !explicitTarget) {
    // A prior system-env snapshot may have left our admission key in the inherited
    // environment. It belongs to the proxy data plane, not Claude subscription OAuth.
    const token = env.ANTHROPIC_AUTH_TOKEN?.trim();
    if (token && (token === PROXY_MARKER || isProxyAdmissionSecret(token, config))) {
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
  } else if (targetsLocalProxy && !hasUserApiKey && ownTokens.length > 0) {
    setDefault("ANTHROPIC_AUTH_TOKEN", ownTokens[0]);
  }
  if (!env.ANTHROPIC_AUTH_TOKEN && !hasUserApiKey && targetsLocalProxy && resolved.markerMode === "proxy") {
    env.ANTHROPIC_AUTH_TOKEN = PROXY_MARKER;
  }
  // Degrade out loud rather than hand Claude Code a destination that 401s (#4236). A
  // subscription launch deliberately carries no host token — asserting one logs a claude.ai
  // subscriber out (#253) — so on a bind that demands admission the honest outcome is a
  // warning naming the two fixes, not a silent refusal at the first request.
  if (destination?.requiresAdmissionToken === true && targetsLocalProxy) {
    const carried = env.ANTHROPIC_AUTH_TOKEN?.trim();
    if (!hasUserApiKey && (!carried || carried === PROXY_MARKER)) {
      console.error(
        `⚠ ${managedBaseUrl} requires an opencodex data-plane credential and this launch carries none — `
        + "requests will be refused. Enable `unauthenticatedLoopbackListener` or bind the proxy to loopback.",
      );
    }
  }
  const finalAuthToken = env.ANTHROPIC_AUTH_TOKEN;
  const hostOwnsAuthentication = targetsLocalProxy
    && !hasUserApiKey
    && typeof finalAuthToken === "string"
    && (
      finalAuthToken.trim() === PROXY_MARKER
      || isOwnAdmissionToken(finalAuthToken)
    );
  if (resolved.origin === "auto-unknown") {
    console.error("⚠ Claude 인증을 확인하지 못했습니다 — 구독 방식으로 진행합니다. GUI에서 인증 모드를 직접 지정하면 이 판단을 덮어쓸 수 있습니다.");
  }
  // NOTE: do NOT set _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL here. While it enables
  // Design/Remote Control, it DISABLES gateway model discovery (Claude Code's eligibility
  // check returns false when isFirstPartyBaseUrl() is true). Model routing through the
  // proxy is essential; Design/Remote Control are secondary features.
  // Connectors still work because they check OAuth state ($o()), not base URL (Gd()).
  // Native /model picker discovery ("From gateway", Claude Code >= 2.1.129).
  setDefault("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "1");
  // Host-managed routing guard (devlog 260720_claude_authmode_persist/020): with
  // this flag in the spawn env, Claude Code strips provider-managed vars
  // (ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY, model slots) from settings-sourced
  // env (managedEnv.ts), so a leftover cc-switch/CCR ~/.claude/settings.json
  // env block cannot silently hijack proxy routing away from opencodex.
  // setDefault: an explicit user export (e.g. =0, isEnvTruthy-false) still wins.
  // Intentional contract change: settings.env model slots are also stripped in
  // ocx claude runs — use the top-level settings "model" field or opt out.
  // Claude Code 2.1.206+ also treats this as a host-auth assertion. Injecting it
  // without a host token makes a valid claude.ai subscription look logged out,
  // so the guard is only safe when opencodex actually owns authentication.
  if (hostOwnsAuthentication) {
    setDefault("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "1");
  }
  // Opt-in effort forcing (devlog 136 B6): opus-shaped aliases already carry
  // output_config.effort, so this is OFF unless the user enables it in config.
  if (config.claudeCode?.alwaysEnableEffort === true) {
    setDefault("CLAUDE_CODE_ALWAYS_ENABLE_EFFORT", "1");
  }
  // Context-window override: the official pair — MAX_CONTEXT_TOKENS alone is ignored
  // for recognized claude-shaped ids unless DISABLE_COMPACT=1 rides along (devlog 135).
  const maxCtx = config.claudeCode?.maxContextTokens;
  if (typeof maxCtx === "number" && Number.isFinite(maxCtx) && maxCtx > 0) {
    setDefault("CLAUDE_CODE_MAX_CONTEXT_TOKENS", String(Math.floor(maxCtx)));
    setDefault("DISABLE_COMPACT", "1");
  }
  // Auto-context (devlog 260712 020): min(believed window, env) inside the CLI means
  // one global env acts as a per-model floor — [1m]-marked models compact here while
  // unmarked (200k-accounted) models keep their default behavior. Inert when the
  // legacy maxContextTokens pair above is set (resolveAutoContext handles that).
  // A user-exported value drives the marking predicate too (audit 021 #2) so the
  // [1m] marker and the compaction threshold can never separate.
  const userAutoCompact = typeof base.CLAUDE_CODE_AUTO_COMPACT_WINDOW === "string" && base.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== ""
    ? base.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    : undefined;
  const auto = resolveAutoContext(config.claudeCode, userAutoCompact);
  if (auto.enabled) {
    setDefault("CLAUDE_CODE_AUTO_COMPACT_WINDOW", String(auto.compactWindow));
  }
  // Model slots (devlog 260712 B2): default + four tier defaults + legacy small-fast,
  // with automatic [1m] context-variant marking when the slot's target model has an
  // authoritative >=1M window (Claude Code then accounts 1M, compaction preserved).
  for (const [name, value] of Object.entries(effectiveModelEnv(config.claudeCode, contextWindows, auto))) {
    setDefault(name, value);
  }
  return env;
}

/**
 * Context-window map from the RUNNING proxy's management API (warm TTL cache; the
 * daemon registers every selector form — audit R3#1). 3s bound + management auth header.
 * (no [1m] marking, conservative).
 *
 * This is the MANAGEMENT destination, not the inference one (#4236): `/api/claude-code` is
 * never served by the unauthenticated loopback listener, so it resolves through
 * `localManagementOrigin` — a hub's loopback management ingress when it has one, otherwise the
 * public bind — and keeps sending the local admin token. `enabled: false` is how `ocx claude`
 * decides to launch natively, so a wrong destination here silently downgrades every launch.
 */
export interface ClaudeCodeLiveState {
  contextWindows: Record<string, number>;
  enabled?: boolean;
}

export async function fetchClaudeCodeState(config: OcxConfig, port: number, timeoutMs = 3_000): Promise<ClaudeCodeLiveState> {
  try {
    const headers = new Headers();
    const token = configuredAdminToken();
    if (token) headers.set("x-opencodex-api-key", token);
    const res = await fetch(`${localManagementOrigin(config, port)}/api/claude-code`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { contextWindows: {} };
    const body = await res.json() as { contextWindows?: Record<string, number>; enabled?: boolean };
    return {
      contextWindows: body.contextWindows && typeof body.contextWindows === "object" ? body.contextWindows : {},
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    };
  } catch {
    console.error("⚠ 모델 컨텍스트 정보를 불러오지 못했습니다 — 1M 자동 표시는 이번 실행에서 생략됩니다.");
    return { contextWindows: {} };
  }
}

export async function fetchClaudeContextWindows(config: OcxConfig, port: number, timeoutMs = 3_000): Promise<Record<string, number>> {
  return (await fetchClaudeCodeState(config, port, timeoutMs)).contextWindows;
}

export function readConnectedClaudeContextWindows(path = DEFAULT_CATALOG_PATH): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return {};
    const out: Record<string, number> = {};
    const put = (key: string, value: number) => { if (out[key] === undefined) out[key] = value; };
    for (const row of parsed.models) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const entry = row as Record<string, unknown>;
      const slug = typeof entry.slug === "string" ? entry.slug : "";
      const contextWindow = typeof entry.context_window === "number" && entry.context_window > 0
        ? entry.context_window
        : undefined;
      if (!slug || contextWindow === undefined) continue;
      put(slug, contextWindow);
      const slash = slug.indexOf("/");
      if (slash > 0 && slash < slug.length - 1) {
        const provider = slug.slice(0, slash);
        const id = slug.slice(slash + 1);
        const routeAlias = aliasForRoute(provider, id);
        if (routeAlias) put(routeAlias, contextWindow);
        put(desktop3pAlias(provider, id), contextWindow);
      } else {
        const nativeAlias = aliasForNative(slug);
        if (nativeAlias) put(nativeAlias, contextWindow);
        put(desktop3pAlias("native", slug), contextWindow);
      }
    }
    return out;
  } catch {
    return {};
  }
}

export type ClaudeProxyEnsureDeps = {
  findLiveProxy?: typeof findLiveProxy;
};

export async function ensureProxyForClaude(deps: ClaudeProxyEnsureDeps = {}): Promise<number | null> {
  // A proxy that has only just bound can miss a single probe while its event loop
  // is still settling startup work — the same just-started race the stop paths
  // already retry for (#764, SERVICE_STOP_LIVENESS). Only the attempts budget is
  // borrowed here; the probe timeout remains DEFAULT_PROBE_TIMEOUT_MS (750 ms).
  // Without this, `ocx claude` can spawn a second proxy while the first is serving.
  const live = await (deps.findLiveProxy ?? findLiveProxy)({ attempts: 3 });
  if (live) return live.port;
  const cfgPort = loadConfig().port;
  const pinPort = typeof cfgPort === "number" && cfgPort > 0 ? cfgPort : 10100;
  const child = spawn(process.execPath, selfLaunchArgv(["start", "--port", String(pinPort)]), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: withProcessRuntimeProvenance({ ...process.env, OCX_SERVICE: "1" }),
  });
  child.unref();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const started = await findLiveProxy();
    if (started) return started.port;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

export const CLAUDE_NATIVE_ROUTING_OFF =
  "ℹ️ Claude Code routing is disabled in OpenCodex. Launching Claude Code natively. Enable Claude routing to use the proxy again.";

export const CLAUDE_NATIVE_LIVE_DISABLED =
  "ℹ️ The running OpenCodex proxy has Claude Code routing disabled. Launching Claude Code natively. Restart the service after enabling routing.";

export type ClaudeLaunchPlan =
  | { kind: "routed" }
  | { kind: "native"; notice: string };

export function claudeLaunchPlan(
  configuredEnabled: boolean,
  liveEnabled: boolean | undefined,
): ClaudeLaunchPlan {
  if (!configuredEnabled) return { kind: "native", notice: CLAUDE_NATIVE_ROUTING_OFF };
  if (liveEnabled === false) return { kind: "native", notice: CLAUDE_NATIVE_LIVE_DISABLED };
  return { kind: "routed" };
}

export type ClaudeLaunchPreflight =
  | { kind: "continue" }
  | { kind: "native"; notice: string }
  | { kind: "error"; message: string };

/** Validate connected-client ownership before any native fallback can run. */
export function claudeLaunchPreflight(
  configuredEnabled: boolean,
  clientState: ClientConnectionState,
  tokenState?: ServiceApiTokenState,
): ClaudeLaunchPreflight {
  if (clientState.kind === "invalid" || clientState.kind === "mismatched") {
    return { kind: "error", message: `Client state is ${clientState.kind}: ${clientState.reason}` };
  }
  if (clientState.kind === "connected") {
    if (!clientState.value.selectedClients.includes("claude")) {
      return { kind: "error", message: "Claude is not selected for this remote hub connection." };
    }
    if (tokenState?.kind !== "present" || tokenState.fingerprint !== clientState.value.tokenFingerprint) {
      return {
        kind: "error",
        message: tokenState?.kind === "absent"
          ? "Connected service token is missing."
          : "Connected service token ownership changed.",
      };
    }
  }
  return configuredEnabled
    ? { kind: "continue" }
    : { kind: "native", notice: CLAUDE_NATIVE_ROUTING_OFF };
}

const NATIVE_STRIPPED_LEVERS = [
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
  "DISABLE_COMPACT",
] as const;

const MODEL_ENV_SLOT_NAMES = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
] as const;

const DESKTOP_3P_ALIAS = /^claude-opus-4(?:-8)?-[a-z][0-9a-z]{2}$/;

export function isProxyOnlyModelId(value: string, providerNames: readonly string[] = []): boolean {
  const id = value.trim().replace(/\[1m\]$/, "");
  if (!id) return false;
  if (id.startsWith(CLAUDE_ALIAS_PREFIX_V1) || id.startsWith(CLAUDE_ALIAS_PREFIX_V2) || DESKTOP_3P_ALIAS.test(id)) {
    return true;
  }
  const slash = id.indexOf("/");
  return slash > 0 && providerNames.includes(id.slice(0, slash));
}

export function buildNativeClaudeEnv(
  config: OcxConfig,
  base: ClaudeLaunchEnv,
  deps: ClaudeEnvDeps = {},
): ClaudeLaunchEnv {
  const env: ClaudeLaunchEnv = { ...base };
  deleteUntrustedAnthropicSlots(env, deps);

  const admissionSlots = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
  const hasOwnedAdmission = admissionSlots.some(name => {
    const value = env[name]?.trim();
    return Boolean(value && (value === PROXY_MARKER || isProxyAdmissionSecret(value, config)));
  });
  const baseUrl = env.ANTHROPIC_BASE_URL;
  // Shedding asks a DIFFERENT question than the stale-replacement branch above, so it uses a
  // wider set (#4236). There the question is "is this inherited URL a live destination of
  // ours?" and a port nothing answers on must be rewritten. Here it is "could we have written
  // this?" — and the answer is yes for the public port on any topology, because an earlier
  // config on this machine may have been loopback-bound. Leaving such a URL in place with its
  // admission token stripped (the loop below always strips it) would point a native launch at a
  // dead socket with no credential, which is strictly worse than shedding one port too many.
  const nativeLocalPorts = [...new Set([config.port, ...localLoopbackInferencePorts(config, config.port)])];
  const nativeOwnOrigin = localInferenceDestination(config, config.port).origin;
  if (hasOwnedAdmission && targetsLocalClaudeProxy(baseUrl, nativeLocalPorts, nativeOwnOrigin)) {
    delete env.ANTHROPIC_BASE_URL;
  }
  for (const name of admissionSlots) {
    const value = env[name]?.trim();
    if (value && (value === PROXY_MARKER || isProxyAdmissionSecret(value, config))) delete env[name];
  }

  for (const name of NATIVE_STRIPPED_LEVERS) delete env[name];
  const providerNames = Object.keys(config.providers);
  for (const name of MODEL_ENV_SLOT_NAMES) {
    const value = env[name];
    if (value && isProxyOnlyModelId(value, providerNames)) delete env[name];
  }
  if (deps.allowRootSkipPermissions === true && !env.IS_SANDBOX) env.IS_SANDBOX = "1";
  return env;
}

export function nativeModelOverride(
  pickedModel: string | null,
  configuredModel: string | undefined,
  args: readonly string[],
  providerNames: readonly string[] = [],
): { flag?: string[]; warning?: string } {
  if (!pickedModel || !isProxyOnlyModelId(pickedModel, providerNames)) return {};
  if (args.some(arg => arg === "--model" || arg.startsWith("--model="))) return {};
  const fallback = configuredModel?.trim();
  if (fallback && !isProxyOnlyModelId(fallback, providerNames)) {
    return {
      flag: ["--model", fallback],
      warning: `ℹ️ The saved model (${pickedModel}) requires the proxy. This native session will use ${fallback}.`,
    };
  }
  return {
    warning: `⚠ The saved model (${pickedModel}) requires the proxy. Use \`--model <Anthropic model>\` or select a native model in this session.`,
  };
}

const CLAUDE_INSTALL_HINT = "❌ `claude` CLI not found. Install it first: npm install -g @anthropic-ai/claude-code";

/**
 * cmd.exe reports command-not-found as exit 9009 (the win32 launcher routes `.cmd`
 * shims through cmd.exe, so ENOENT never fires there). Signal exits are not hints.
 * Devlog 260715_cross_platform_audit/020.
 */
export function claudeNotFoundHint(
  code: number | null,
  signal: NodeJS.Signals | null,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return platform === "win32" && code === 9009 && !signal ? CLAUDE_INSTALL_HINT : null;
}

export function shouldAllowRootSkipPermissions(
  args: readonly string[],
  getuid: (() => number) | null | undefined = process.getuid,
): boolean {
  return args.includes("--dangerously-skip-permissions")
    && typeof getuid === "function"
    && getuid() === 0;
}

export function rootSkipPermissionsNotice(env: ClaudeLaunchEnv): string {
  if (env.IS_SANDBOX === "1") {
    return "⚠ Root --dangerously-skip-permissions requested: OpenCodex set IS_SANDBOX=1 to bypass Claude Code's root guard. OpenCodex did not create an OS sandbox; prefer running as a non-root user.";
  }
  return `⚠ Root --dangerously-skip-permissions requested: preserving user IS_SANDBOX=${env.IS_SANDBOX}; Claude Code's root guard remains in control.`;
}

/**
 * The hub's featured subagent roster, or undefined to fall back to local `subagentModels`.
 *
 * Best-effort by design: a launch must not fail because the hub is slow or old. But the
 * fallback is ANNOUNCED (#4236) — a silently local roster is exactly how an operator came to
 * believe a hub that serves grok could only delegate to five native models.
 *
 * An empty hub roster is honoured as empty, not treated as "no answer": an operator who cleared
 * the hub's featured list meant it.
 */
export async function resolveHubRosterForClaude(
  connection: { serverUrl: string; apiKeyId: string; connectedAt: string },
  token: string,
  deps: { resolve?: typeof resolveHubState; warn?: (message: string) => void } = {},
): Promise<readonly string[] | undefined> {
  const warn = deps.warn ?? (message => console.error(message));
  const resolve = deps.resolve ?? resolveHubState;
  try {
    const resolved = await resolve({
      owner: { serverUrl: connection.serverUrl, apiKeyId: connection.apiKeyId, connectedAt: connection.connectedAt },
      token,
    });
    if (!resolved.state) {
      warn(`⚠ Hub roster unavailable (${resolved.reason ?? "unknown reason"}); using this machine's local subagentModels instead. The delegable agents below may not be what the hub can route.`);
      return undefined;
    }
    if (resolved.stateSource === "cache") {
      warn(`⚠ Hub roster came from a cached read ${resolved.ageSeconds ?? "?"}s old (${resolved.reason ?? "live read failed"}).`);
    }
    return resolved.state.subagentModels;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`⚠ Hub roster could not be read (${message}); using this machine's local subagentModels instead.`);
    return undefined;
  }
}

export async function cmdClaude(args: string[]): Promise<number> {
  const config = loadConfig();
  const clientState = readClientConnectionState();
  const tokenState = clientState.kind === "connected" ? readServiceApiTokenState() : undefined;
  const preflight = claudeLaunchPreflight(config.claudeCode?.enabled !== false, clientState, tokenState);
  if (preflight.kind === "error") {
    console.error(preflight.message);
    return 1;
  }
  if (preflight.kind === "native") return launchNativeClaude(config, args, preflight.notice);
  let route: number | ClaudeRoutingTarget;
  let contextWindows: Record<string, number>;
  /** The hub's featured roster on a connected client; undefined means "use local config". */
  let hubRoster: readonly string[] | undefined;
  if (clientState.kind === "connected") {
    if (tokenState?.kind !== "present") return 1;
    route = { baseUrl: clientState.value.serverUrl, admissionToken: tokenState.token };
    contextWindows = readConnectedClaudeContextWindows();
    hubRoster = await resolveHubRosterForClaude(clientState.value, tokenState.token);
  } else {
    const port = await ensureProxyForClaude();
    if (!port) {
      console.error("❌ Proxy did not become healthy after starting.");
      return 1;
    }
    const liveState = await fetchClaudeCodeState(config, port);
    const plan = claudeLaunchPlan(true, liveState.enabled);
    if (plan.kind === "native") return launchNativeClaude(config, args, plan.notice);
    route = port;
    contextWindows = liveState.contextWindows;
  }
  const allowRootSkipPermissions = shouldAllowRootSkipPermissions(args);
  const env = buildClaudeEnv(config, route, process.env, contextWindows, { allowRootSkipPermissions });
  if (allowRootSkipPermissions) {
    console.error(rootSkipPermissionsNotice(env));
  }
  // Pre-write the CLI's gateway-model cache (devlog 030): without a token the CLI
  // never refreshes it, so the picker would keep showing yesterday's aliases.
  try {
    const cachePath = typeof route === "number"
      ? await refreshGatewayModelCacheFromProxy(route, { admissionConfig: config })
      : await refreshGatewayModelCacheFromProxy(route, { admissionConfig: config });
    if (cachePath === null) {
      console.error("⚠ Gateway model cache could not be refreshed; the model picker may be stale.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`⚠ Gateway model cache could not be refreshed: ${message}`);
  }
  // Sync roster agents (devlog 070): subagentModels + self -> ~/.claude/agents/ocx-*.md.
  //
  // This used to run only when `route` was a number — i.e. never on a connected client, where
  // `route` is a ClaudeRoutingTarget (#4236). So `~/.claude/agents/ocx-*.md` on a client stayed
  // whatever a previous standalone run had left, and the five delegable agents an operator saw
  // were a frozen snapshot of a machine that no longer does the routing. Nothing in the output
  // said so; the roster simply looked like the answer.
  //
  // On a client the roster comes from the hub, because the local `subagentModels` list is the
  // one this machine had before it joined. The five-row cap stays: it is a Claude Code picker
  // constraint, not the defect — sourcing the five from the wrong machine was.
  try {
    const written = injectClaudeAgentDefs(config, contextWindows, undefined, hubRoster);
    if (written === null) {
      console.error("⚠ Claude agent definitions could not be synced; check ~/.claude/agents permissions.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`⚠ Claude agent definitions could not be synced: ${message}`);
  }
  return spawnClaude(args, env);
}

async function launchNativeClaude(config: OcxConfig, args: string[], notice: string): Promise<number> {
  console.error(notice);
  const providerNames = Object.keys(config.providers);
  const override = nativeModelOverride(
    readPickerDefaultModel(claudeConfigDir()),
    config.claudeCode?.model,
    args,
    providerNames,
  );
  if (override.warning) console.error(override.warning);
  const allowRootSkipPermissions = shouldAllowRootSkipPermissions(args);
  const env = buildNativeClaudeEnv(config, process.env, { allowRootSkipPermissions });
  if (allowRootSkipPermissions) console.error(rootSkipPermissionsNotice(env));
  return spawnClaude([...(override.flag ?? []), ...args], env);
}

function spawnClaude(args: string[], env: ClaudeLaunchEnv): Promise<number> {
  return new Promise<number>(resolve => {
    const inv = commandInvocation("claude", args);
    const child = spawn(inv.file, inv.args, { stdio: "inherit", env: env as NodeJS.ProcessEnv, ...inv.options });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        console.error(CLAUDE_INSTALL_HINT);
      } else {
        console.error(`❌ Failed to launch claude: ${err.message}`);
      }
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      const hint = claudeNotFoundHint(code, signal);
      if (hint) console.error(hint);
      resolve(signal ? 1 : code ?? 0);
    });
  });
}
