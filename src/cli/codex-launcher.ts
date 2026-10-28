/**
 * `ocx codex [codex args...]` — launch Codex wired to the local proxy's routing,
 * passing through untouched when Codex routing is disabled or foreign.
 *
 * Mirrors `ocx claude` (src/cli/claude.ts) and `ocx opencode` (src/cli/opencode.ts):
 * ensures the proxy is running, then execs the client with stdio inherited. The wiring
 * channel differs again — Codex routing is config-owned (the injected `openai_base_url`
 * and model catalog in `~/.codex/config.toml`), so a launch never rewrites a config
 * file. What the launcher owns instead is the two add-ons `plain codex` lacks:
 *
 *  - launch-time autostart: the same detached `ocx start` + health poll that
 *    `ocx ensure` gives service- and shim-less setups, attempted before every routed launch;
 *  - an honest route verdict before exec: native and foreign-gateway configs are
 *    announced (and NOT ensured) instead of silently benefiting or fighting them,
 *    reusing the routing classification the shim and doctor share
 *    (src/codex/inject/routing-classify.ts).
 *
 * The admission token is re-exported from `~/.opencodex/service-api-token` when the
 * environment does not carry it — the same injection the generated Codex autostart
 * shim performs (src/codex/shim-templates.ts), whose argv fast-path grammar
 * (--help/-h, --version/-V, internal subcommands, global options with values) is
 * mirrored here so both `codex` entry points behave identically for the same argv.
 */
import { spawn } from "node:child_process";
import { loadConfig } from "../config";
import { getCodexRoutingKind, type CodexRoutingKind } from "../codex/inject";
import { inspectCodexShimBackingForCommand } from "../codex/shim";
import { CODEX_GLOBAL_OPTIONS_WITH_VALUE, CODEX_INTERNAL_COMMANDS, CODEX_SHIM_ENSURE_FAILED_DIAGNOSTIC } from "../codex/shim-templates";
import { withoutSiblingMarker } from "../codex/sibling-start";
import { withProcessRuntimeProvenance } from "../lib/bun-runtime";
import { tokenCollidesWithAdmin } from "../lib/admin-secrets";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { loadServiceTokenFromFile, serviceApiTokenFilePath } from "../lib/service-secrets";
import { commandInvocation } from "../lib/win-exec";
import { findExecutableOnPath } from "../remote-control/workspace-executable";
import { findLiveProxy, type LiveProxy } from "../server/proxy-liveness";
import { codexCredentialDestinationIsTrusted, resolveCodexLaunchHome } from "./codex-launch-auth";
import { codexCommandCanBypass, CODEX_UNVERIFIED_SHIM } from "./codex-launch-command";
import { codexTokenArgsAreSafe, codexTokenEnvironmentIsSafe } from "./codex-launch-policy";
import { codexTokenWithheldDiagnostic, type CodexTokenRefusal, type CodexTokenRefusalReporter } from "./codex-launch-diagnostics";

export interface CodexLaunchEnv {
  [key: string]: string | undefined;
}

type FastPathReason = "help" | "version" | "internal";

/**
 * Mirrors the generated shim wrapper's argv grammar (src/codex/shim-templates.ts):
 * an invocation whose first positional operand is a Codex-internal subcommand, or
 * which only asks for help/version, never needs the proxy. The shell scanners
 * inline these sets — the exported constants here are the single source they are
 * read from — while the option-value rules (`--model x`, `-c k=v`, ...) stay in
 * this scanner in sync with the same templates.
 */
export function codexFastPathReason(args: readonly string[]): FastPathReason | null {
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) { skipNext = false; continue; }
    if (arg === "--") return null; // the shim's `break`: rest is operands, ensure runs
    const options = CODEX_GLOBAL_OPTIONS_WITH_VALUE;
    if (options.includes(arg)) { skipNext = true; continue; }
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--version" || arg === "-V") return "version";
    if (arg.startsWith("-")) continue;
    const value = arg;
    return (CODEX_INTERNAL_COMMANDS.includes(value)) ? "internal" : null;
  }
  return null;
}

export const CODEX_ROUTING_NATIVE_NOTICE =
  "ℹ️ Codex does not route through OpenCodex (no injected routing in ~/.codex/config.toml). Launching `codex` unchanged. Run `ocx ensure` to start the proxy and sync Codex config.";

export const CODEX_ROUTING_UNKNOWN_NOTICE =
  "⚠️ Codex routing could not be verified. Ensuring the proxy is up, but the launch may not be redirected; run `ocx doctor` before relying on it.";

export const CODEX_ROUTING_CUSTOM_LOCAL_NOTICE =
  "⚠️ Codex routes through a user-owned local gateway. OpenCodex does not own that route; launching `codex` unchanged. Run `ocx doctor` to verify that gateway.";

export const CODEX_ROUTING_CUSTOM_REMOTE_NOTICE =
  "⚠️ Codex routes through a remote gateway. OpenCodex does not own that route; launching `codex` unchanged.";

export type CodexLaunchPlan =
  | { kind: "routed" }
  | { kind: "passthrough"; notice?: string; ensureProxy: boolean };

/**
 * Pure launch decision from the shared routing classification:
 *
 *  - `opencodex-local` → ensure + exec (the config this launcher exists for);
 *  - `native` / `custom-*` → exec unchanged, no proxy side effects;
 *  - `unknown` (unreadable/ambiguous config) → name it out loud and still attempt
 *    the ensure, because a routed session that starts without its proxy hits the
 *    configured URL's dead port and every request fails.
 */
export function codexLaunchPlan(routingKind: CodexRoutingKind): CodexLaunchPlan {
  switch (routingKind) {
    case "opencodex-local":
      return { kind: "routed" };
    case "native":
      return { kind: "passthrough", ensureProxy: false, notice: CODEX_ROUTING_NATIVE_NOTICE };
    case "custom-local":
      return { kind: "passthrough", ensureProxy: false, notice: CODEX_ROUTING_CUSTOM_LOCAL_NOTICE };
    case "custom-remote":
      return { kind: "passthrough", ensureProxy: false, notice: CODEX_ROUTING_CUSTOM_REMOTE_NOTICE };
    case "unknown":
      return { kind: "passthrough", ensureProxy: true, notice: CODEX_ROUTING_UNKNOWN_NOTICE };
  }
}

/** Env the detached `ocx start` child inherits (service-owned admission ladder). */
export function codexProxyStartEnv(base: CodexLaunchEnv = process.env): CodexLaunchEnv {
  const stripped = withoutSiblingMarker(base) as CodexLaunchEnv;
  const withTokenFile = stripped.OPENCODEX_API_AUTH_TOKEN?.trim()
    ? stripped
    : { ...stripped, OCX_API_TOKEN_FILE: serviceApiTokenFilePath() };
  return { ...withTokenFile, OCX_SERVICE: "1" } as CodexLaunchEnv;
}

export type CodexProxyEnsureDeps = {
  findLiveProxy?: typeof findLiveProxy;
};

/**
 * Mirrors ensureProxyForClaude (src/cli/claude.ts) — the same borrowed liveness
 * retry budget (#764), detached `ocx start` on the configured port, 8 s health
 * poll — so all `ocx`-launched clients share one autostart contract.
 */
export async function ensureProxyForCodex(deps: CodexProxyEnsureDeps = {}): Promise<LiveProxy | null> {
  const probe = deps.findLiveProxy ?? findLiveProxy;
  const live = await probe({ attempts: 3 });
  if (live) return live;
  const cfgPort = loadConfig().port;
  const pinPort = typeof cfgPort === "number" && cfgPort > 0 ? cfgPort : 10100;
  const child = spawn(process.execPath, selfLaunchArgv(["start", "--port", String(pinPort)]), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    // An ordinary owner: a stray sibling marker would otherwise mark it before any probe.
    env: withProcessRuntimeProvenance(codexProxyStartEnv(process.env) as NodeJS.ProcessEnv),
  });
  // Without a listener an 'error' (bad argv[1], EMFILE, AV denial) throws synchronously
  // and kills this process; the health poll below already reports the failure properly.
  child.on("error", () => { /* handled by the deadline loop returning null */ });
  child.unref();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const started = await probe();
    if (started) return started;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

export type CodexLaunchEnvDeps = {
  routingKind?: CodexRoutingKind;
  args?: readonly string[];
  /** Test seam; production reads the hardened service token file. */
  serviceToken?: (base: CodexLaunchEnv) => string | null;
  credentialDestination?: (home: string, report?: CodexTokenRefusalReporter) => boolean;
};

/** Read the client admission credential from this installation's service-token file. */
const defaultServiceToken = (base: CodexLaunchEnv): string | null =>
  loadServiceTokenFromFile({ ...base, OCX_API_TOKEN_FILE: serviceApiTokenFilePath() });

/**
 * Launch env for a routed exec. The one injection is the shim's own: a missing
 * OPENCODEX_API_AUTH_TOKEN is re-exported from the hardened service token file, so
 * `ocx codex` from a shell without the system-env snapshot authenticates to the
 * loopback proxy like a shimmed launch does. Fresh credentials require explicit
 * argv/env/config allowlists, an exclusive managed provider and protected home/system
 * configuration namespaces. User exports always win.
 */
export function buildCodexLaunchEnv(
  base: CodexLaunchEnv = process.env,
  deps: CodexLaunchEnvDeps = {},
): CodexLaunchEnv {
  const env = { ...base };
  if (deps.routingKind !== undefined && deps.routingKind !== "opencodex-local") return env;
  if (!env.OPENCODEX_API_AUTH_TOKEN?.trim()) {
    const withhold = (reason: CodexTokenRefusal): CodexLaunchEnv => {
      console.error(codexTokenWithheldDiagnostic(reason));
      return env;
    };
    if (!codexTokenArgsAreSafe(deps.args ?? [])) return withhold("args");
    if (!codexTokenEnvironmentIsSafe(env)) return withhold("environment");
    // NO_PROXY parsing and precedence vary across native HTTP/WebSocket transports.
    // Without proving bypass, preserve the user's transport but never load a secret.
    const home = resolveCodexLaunchHome(env);
    if (!home) return withhold("home");
    let refusal: CodexTokenRefusal = "destination";
    const report: CodexTokenRefusalReporter = reason => { refusal = reason; };
    const trusted = deps.credentialDestination
      ? deps.credentialDestination(home, report)
      : codexCredentialDestinationIsTrusted(home, undefined, report);
    if (!trusted) return withhold(refusal);
    const token = (deps.serviceToken ?? defaultServiceToken)(env);
    if (!token) return withhold("credential");
    if (tokenCollidesWithAdmin(token, env)) return withhold("collision");
    // Reqwest's default transport can discover OS proxies even without proxy
    // env. Bind both bypass spellings to the allowed loopback hosts, preserving
    // existing entries and removing conflicting case aliases before handoff.
    const bypass = ["127.0.0.1", "::1"];
    for (const key of Object.keys(env)) if (/^no_proxy$/i.test(key)) {
      if (env[key]) bypass.push(env[key]!);
      delete env[key];
    }
    env.NO_PROXY = env.no_proxy = bypass.join(",");
    env.CODEX_HOME = home;
    env.OPENCODEX_API_AUTH_TOKEN = token;
  }
  return env;
}

const CODEX_INSTALL_HINT = "❌ `codex` CLI not found. Install it first: npm install -g @openai/codex";
class CodexNotFoundError extends Error {}

/**
 * cmd.exe reports command-not-found as exit 9009 (the win32 launcher routes `.cmd`
 * shims through cmd.exe, so ENOENT never fires there). Signal exits are not hints.
 * Same contract as claudeNotFoundHint (devlog 260715_cross_platform_audit/020).
 */
export function codexNotFoundHint(
  code: number | null,
  signal: NodeJS.Signals | null,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return platform === "win32" && code === 9009 && !signal ? CODEX_INSTALL_HINT : null;
}

export type CodexLaunchCommandDeps = {
  findOnPath?: (name: string) => string | null;
  inspectShim?: typeof inspectCodexShimBackingForCommand;
  verifyBypass?: typeof codexCommandCanBypass;
};

export type CodexLaunchCommand = { command: string; env: CodexLaunchEnv };

/**
 * The launcher has already made the ensure decision, so the generated autostart shim
 * must not make it again: on a passthrough plan it would start the proxy and load the
 * admission token anyway. When `codex` resolves to a recorded shim wrapper, exec its
 * backing Codex directly. Unknown state requires a separate bypass-content check;
 * obsolete or unverifiable Windows wrappers fail closed before starting any child.
 */
export function resolveCodexLaunchCommand(
  env: CodexLaunchEnv,
  deps: CodexLaunchCommandDeps = {},
): CodexLaunchCommand {
  try {
    const selected = (deps.findOnPath ?? findExecutableOnPath)("codex");
    if (!selected) throw new CodexNotFoundError(CODEX_INSTALL_HINT);
    let shim: ReturnType<typeof inspectCodexShimBackingForCommand>;
    try { shim = (deps.inspectShim ?? inspectCodexShimBackingForCommand)(selected); }
    catch { shim = { status: "unknown", reason: "binding_unavailable" }; }
    if (shim.status === "matched" && shim.selectedRole === "wrapper") return { command: shim.backingPath, env };
    if (shim.status !== "unknown") return { command: selected, env };
    if (!(deps.verifyBypass ?? codexCommandCanBypass)(selected, env)) throw new Error(CODEX_UNVERIFIED_SHIM);
    return { command: selected, env: { ...env, OCX_SHIM_BYPASS: "1" } };
  } catch (error) {
    if (error instanceof CodexNotFoundError) throw error;
    throw new Error(CODEX_UNVERIFIED_SHIM);
  }
}

/** Launch the selected Codex command with inherited IO and preserve its exit status. */
function spawnCodex(args: readonly string[], env: CodexLaunchEnv): Promise<number> {
  return new Promise<number>(resolve => {
    let launch: CodexLaunchCommand;
    try { launch = resolveCodexLaunchCommand(env); }
    catch (error) { console.error(error instanceof CodexNotFoundError ? CODEX_INSTALL_HINT : CODEX_UNVERIFIED_SHIM); resolve(1); return; }
    const inv = commandInvocation(launch.command, args);
    const child = spawn(inv.file, inv.args, { stdio: "inherit", env: launch.env as NodeJS.ProcessEnv, ...inv.options });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        console.error(CODEX_INSTALL_HINT);
      } else {
        console.error(`❌ Failed to launch codex: ${err.message}`);
      }
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      const hint = codexNotFoundHint(code, signal);
      if (hint) console.error(hint);
      resolve(signal ? 1 : code ?? 0);
    });
  });
}

/** Apply the argument/routing plan, then hand the original arguments to Codex. */
export async function cmdCodex(args: string[]): Promise<number> {
  if (codexFastPathReason(args) !== null) return spawnCodex(args, { ...process.env });
  const routingKind = getCodexRoutingKind();
  const plan = codexLaunchPlan(routingKind);
  const notice = plan.kind === "passthrough" ? plan.notice : undefined;
  if (notice) console.error(notice);
  const needsProxy = plan.kind === "routed"
    || (plan.kind === "passthrough" && plan.ensureProxy);
  if (!needsProxy) return spawnCodex(args, { ...process.env });
  const live = await ensureProxyForCodex();
  if (!live) {
    // A failed ensure warns and continues, subject to executable verification.
    // The already-injected config decides
    // what the session does next; `ocx doctor` names the autostart failure.
    console.error(CODEX_SHIM_ENSURE_FAILED_DIAGNOSTIC);
  }
  return spawnCodex(args, buildCodexLaunchEnv(process.env, { routingKind, args }));
}
