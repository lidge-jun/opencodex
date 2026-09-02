/**
 * `ocx claude [claude args...]` — launch Claude Code wired to the local proxy.
 *
 * Mirrors `ccr code` UX (devlog/260711_claude_inbound/020, 003 E1/E2/E5/G1):
 * ensures the proxy is running, injects the Anthropic env slots, then execs the
 * `claude` CLI with stdio inherited. User-exported env wins except when a stale
 * loopback opencodex base URL points at a different proxy port.
 */
import { spawn } from "node:child_process";
import { loadConfig } from "../config";
import { injectClaudeAgentDefs } from "../claude/agents-inject";
import { effectiveModelEnv, resolveAutoContext } from "../claude/context-windows";
import { refreshGatewayModelCacheFromProxy } from "../claude/gateway-cache";
import { commandInvocation } from "../lib/win-exec";
import { isProxyAdmissionSecret } from "../server/auth-cors";
import { findLiveProxy } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";
import { configuredAdminToken } from "../lib/admin-secrets";
import { PROXY_MARKER, ownAdmissionTokens, defaultAuthDetectDeps, detectClaudeAuth, type AuthDetectDeps } from "../claude/auth-detect";
import { resolveClaudeAuthMode } from "../claude/auth-mode";
import { withProcessRuntimeProvenance } from "../lib/bun-runtime";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { ANTHROPIC_PARENT_ENV_SLOTS, trustedNodeLauncherContext, type AnthropicParentEnvSlot } from "./launcher-context";
import { readClientConnectionState } from "../client/state";
import { readServiceApiTokenState } from "../lib/service-secrets";
import { DEFAULT_CATALOG_PATH } from "../codex/paths";
import { readFileSync } from "node:fs";
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

function isClaudeLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "[::1]";
}

function targetsLocalClaudeProxy(value: string | undefined, port: number): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const effectivePort = parsed.port === "" ? 80 : Number(parsed.port);
    return parsed.protocol === "http:"
      && isClaudeLoopbackHostname(parsed.hostname)
      && effectivePort === port
      && parsed.username === ""
      && parsed.password === "";
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
  const managedBaseUrl = explicitTarget ? new URL(explicitTarget.baseUrl).origin : `http://127.0.0.1:${port}`;
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
  const explicitSlots = deps.preBunAnthropicSlots;
  const trustedSlots = explicitSlots === undefined
    ? trustedNodeLauncherContext()?.anthropicEnvSlots ?? []
    : explicitSlots ?? [];
  const exported = new Set<AnthropicParentEnvSlot>(trustedSlots);
  for (const name of ANTHROPIC_PARENT_ENV_SLOTS) {
    const value = env[name];
    if (value !== undefined && value !== "" && !exported.has(name)) delete env[name];
  }
  // Never forward old or current provenance seams to Claude Code.
  delete env.OCX_PRE_BUN_ANTHROPIC_ENV;
  delete env.OCX_NODE_LAUNCH_CONTEXT;
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
      if (parsed.protocol === "http:"
        && isClaudeLoopbackHostname(parsed.hostname)
        && effectivePort !== port) {
        const replacement = `http://127.0.0.1:${port}`;
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
  const ownTokens = explicitTarget ? [explicitTarget.admissionToken] : ownAdmissionTokens(config);
  const targetsLocalProxy = explicitTarget
    ? targetsClaudeRoutingTarget(env.ANTHROPIC_BASE_URL, explicitTarget)
    : targetsLocalClaudeProxy(env.ANTHROPIC_BASE_URL, port!);
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
 */
export async function fetchClaudeContextWindows(config: OcxConfig, port: number, timeoutMs = 3_000): Promise<Record<string, number>> {
  try {
    const headers = new Headers();
    const token = configuredAdminToken();
    if (token) headers.set("x-opencodex-api-key", token);
    const res = await fetch(`http://127.0.0.1:${port}/api/claude-code`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return {};
    const body = await res.json() as { contextWindows?: Record<string, number> };
    return body.contextWindows && typeof body.contextWindows === "object" ? body.contextWindows : {};
  } catch {
    console.error("⚠ 모델 컨텍스트 정보를 불러오지 못했습니다 — 1M 자동 표시는 이번 실행에서 생략됩니다.");
    return {};
  }
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

export async function cmdClaude(args: string[]): Promise<number> {
  const config = loadConfig();
  if (config.claudeCode?.enabled === false) {
    console.error("Claude inbound is disabled (config.claudeCode.enabled=false — flip the Claude ON toggle in the GUI or edit config).");
    return 1;
  }
  const clientState = readClientConnectionState();
  if (clientState.kind === "invalid" || clientState.kind === "mismatched") {
    console.error(`Client state is ${clientState.kind}: ${clientState.reason}`);
    return 1;
  }
  let route: number | ClaudeRoutingTarget;
  let contextWindows: Record<string, number>;
  if (clientState.kind === "connected") {
    if (!clientState.value.selectedClients.includes("claude")) {
      console.error("Claude is not selected for this remote hub connection.");
      return 1;
    }
    const token = readServiceApiTokenState();
    if (token.kind !== "present" || token.fingerprint !== clientState.value.tokenFingerprint) {
      console.error(token.kind === "absent" ? "Connected service token is missing." : "Connected service token ownership changed.");
      return 1;
    }
    route = { baseUrl: clientState.value.serverUrl, admissionToken: token.token };
    contextWindows = readConnectedClaudeContextWindows();
  } else {
    const port = await ensureProxyForClaude();
    if (!port) {
      console.error("❌ Proxy did not become healthy after starting.");
      return 1;
    }
    route = port;
    contextWindows = await fetchClaudeContextWindows(config, port);
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
  if (typeof route === "number") {
    try {
      const written = injectClaudeAgentDefs(config, contextWindows);
      if (written === null) {
        console.error("⚠ Claude agent definitions could not be synced; check ~/.claude/agents permissions.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`⚠ Claude agent definitions could not be synced: ${message}`);
    }
  }
  return await new Promise<number>(resolve => {
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
