import { win32 } from "node:path";
import { loadConfig } from "../config";
import { serviceApiTokenFilePath } from "../lib/service-secrets";
import { PROXY_ENV_KEYS } from "../lib/proxy-env";
import { proxyIdentityAt } from "../server/proxy-liveness";
import { launchdListenPort } from "./launchd";
import { serviceLogPath } from "./state";
import { systemdListenPort } from "./systemd";
import { windowsListenPort, winswListenPort } from "./windows-ops";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Listen port baked into service wrappers / WinSW XML.
 * Priority: explicit override → OCX_BAKE_PORT (update restart) → config.port → 10100.
 * `config.port === 0` means ephemeral for interactive start; services need a stable pin,
 * so treat 0 / invalid like unset (default 10100) instead of baking `--port 0`.
 */
export function resolveServiceListenPort(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0 && override <= 65535) {
    return Math.trunc(override);
  }
  const baked = process.env.OCX_BAKE_PORT?.trim();
  if (baked && /^\d+$/.test(baked)) {
    const n = Number(baked);
    if (n > 0 && n <= 65535) return n;
  }
  const configured = loadConfig().port;
  if (typeof configured === "number" && configured > 0 && configured <= 65535) return configured;
  return 10100;
}

export function buildServiceShellCommand(bun: string, cli: string, port = resolveServiceListenPort()): string {
  const tokenFile = serviceApiTokenFilePath();
  return `if [ -f ${shellQuote(tokenFile)} ]; then OPENCODEX_API_AUTH_TOKEN="$(cat ${shellQuote(tokenFile)})"; export OPENCODEX_API_AUTH_TOKEN; fi; exec ${shellQuote(bun)} ${shellQuote(cli)} start --port ${port}`;
}

/**
 * The same command shape, launched through a stable `ocx` executable instead of an
 * explicit Bun + CLI pair. The token-file preamble is identical and deliberately shared
 * in form: the service still reads the token from disk at start and never carries it in
 * the unit.
 */
export function buildServiceLauncherShellCommand(launcher: string, port = resolveServiceListenPort()): string {
  const tokenFile = serviceApiTokenFilePath();
  return `if [ -f ${shellQuote(tokenFile)} ]; then OPENCODEX_API_AUTH_TOKEN="$(cat ${shellQuote(tokenFile)})"; export OPENCODEX_API_AUTH_TOKEN; fi; exec ${shellQuote(launcher)} start --port ${port}`;
}

/**
 * Shared tail parser for the baked `--port <n>`.
 *
 * Terminators cover all three artifact shapes: whitespace (batch wrapper, systemd
 * unit), `"` (systemd's quoted ExecStart), `<` (WinSW's `</arguments>`), and `&` (an
 * XML-escaped quote). Matched LAST because every artifact carries the Bun and CLI
 * paths ahead of the argument, and a path containing the literal must not shadow it.
 */
export function parseBakedListenPort(read: () => string): number | null {
  try {
    const last = [...read().matchAll(/start --port (\d{1,5})(?:\s|"|&|<|$)/gm)].at(-1);
    if (!last) return null;
    const n = Number(last[1]);
    return n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}

/**
 * The listen port of the INSTALLED service artifact, falling back to the configured
 * one. Each reader returns null off its own platform, so the chain needs no platform
 * branch — and on Windows both return null, preserving today's behavior.
 */
export function installedServiceListenPort(): number {
  return launchdListenPort()
    ?? systemdListenPort()
    ?? windowsListenPort()
    ?? winswListenPort()
    ?? resolveServiceListenPort();
}

export const SERVICE_INSTALL_HEALTH_MS = 20_000;

/**
 * Windows gets a longer budget because its cold start does more before the
 * listener exists: NTFS ACL hardening and previous-session journal recovery
 * both run first, and #3009 recorded a service that bound a few seconds past
 * the 20s deadline and then stayed healthy. Reporting that as a terminal
 * repair failure is worse than waiting — the caller's fallback is to start a
 * second proxy against a port that is about to be taken.
 */
export const SERVICE_INSTALL_HEALTH_WINDOWS_MS = 45_000;

/** The health budget for the platform this is running on. */
export function serviceInstallHealthMs(
  platform: NodeJS.Platform = process.platform,
): number {
  return platform === "win32" ? SERVICE_INSTALL_HEALTH_WINDOWS_MS : SERVICE_INSTALL_HEALTH_MS;
}

/**
 * Whether a proxy actually answers on the port this install/start just produced.
 *
 * Registration is not service: `launchctl list` reports a job that never bound, and
 * `systemctl is-active` reports a process that bound nothing. Probing is the only
 * thing that answers the question the user is actually asking.
 *
 * Probes the BAKED target rather than resolving one. `findLiveProxy` resolves through
 * pidfile -> runtime-port -> config.port, and a service reinstall has just invalidated
 * the first two while `resolveServiceListenPort` (OCX_BAKE_PORT precedence, config.port
 * === 0 normalization) can disagree with the third.
 *
 * Soft: returns the outcome, never throws; the caller chooses between a checkmark and
 * an actionable warning.
 */
export async function confirmServiceServing(
  deps: {
    port?: number;
    hostname?: string;
    probe?: (port: number, hostname: string) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
  } = {},
): Promise<{ ok: true; port: number } | { ok: false; port: number }> {
  const port = deps.port ?? installedServiceListenPort();
  const hostname = deps.hostname ?? loadConfig().hostname ?? "127.0.0.1";
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const probe = deps.probe ?? (async (p, h) => !!(await proxyIdentityAt(p, { hostname: h })));
  const deadline = now() + (deps.timeoutMs ?? serviceInstallHealthMs());
  let waited = false;
  for (;;) {
    if (await probe(port, hostname)) return { ok: true, port };
    if (now() >= deadline) break;
    await sleep(500);
    waited = true;
  }
  // The probe that ran last started before the deadline, so a service that binds
  // during it is reported as dead (#3009). Knock once more after a short grace
  // before calling it a failure. A zero budget means the caller asked not to
  // wait, so it gets exactly the single probe it asked for and nothing more.
  if (waited) {
    await sleep(500);
    if (await probe(port, hostname)) return { ok: true, port };
  }
  return { ok: false, port };
}

/**
 * Print the outcome of `install` / `start` / `repair` in terms of what the user cares
 * about — is it serving? — instead of whether the manager accepted the registration.
 *
 * Sets `process.exitCode = 1` when nothing answers. That is deliberate: the GUI update
 * worker reads the child's exit status, so a registered-but-silent service now makes it
 * fall back to a direct proxy start rather than reporting a successful update over a
 * dead port.
 */
export async function reportServiceServing(
  verb: "installed" | "started" | "repaired" | "restarted",
  deps: Parameters<typeof confirmServiceServing>[0] = {},
): Promise<void> {
  const healthBudgetMs = deps.timeoutMs ?? serviceInstallHealthMs();
  // Timed here rather than reported from the budget. confirmServiceServing knocks once
  // more after a grace sleep whenever it waited at all, so the real wait is the budget
  // plus that grace — and printing the budget states a number the run did not spend.
  // What the reader is deciding is whether the service was still coming up, which is a
  // judgement about elapsed time (#3009).
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const serving = await confirmServiceServing({ ...deps, timeoutMs: healthBudgetMs });
  const waitedMs = Math.max(0, now() - startedAt);
  if (serving.ok) {
    console.log(`✅ opencodex service ${verb} and serving on port ${serving.port}.`);
    return;
  }
  console.error(
    `⚠️  Service ${verb}, but no proxy answered on port ${serving.port} after `
    + `${Math.round(waitedMs / 1000)}s.\n`
    + `   The manager registered the job; that is not the same as serving.\n`
    + `   Log:       ${serviceLogPath()}\n`
    + `   Meanwhile: ocx start   (serves in the foreground)`,
  );
  process.exitCode = 1;
}

/**
 * The command that repairs the CURRENTLY INSTALLED backend without switching it.
 *
 * `ocx service repair` reads the recorded backend itself, so it cannot silently switch a
 * WinSW install to Task Scheduler the way a plain `ocx service install` would. A healthy
 * scheduler definition needs no elevation; a stale definition can be re-registered and prompt.
 */
export function serviceRepairCommand(): string {
  return "ocx service repair";
}

/**
 * Outbound proxy settings the installing shell had, resolved for baking into a service
 * definition.
 *
 * A service manager does not inherit the environment of the shell that installed it, and
 * `ExecStart=/bin/sh -lc` is dash on Ubuntu/WSL — login dash reads `.profile`, not
 * `.bashrc`, which is where proxy exports usually live. So a user who needs a proxy to
 * reach the upstream got a service that dialed direct: the socket was reset, the retry
 * budget drained, and the request surfaced as `502 Provider unreachable` (#2107). The
 * same install driven through `ocx codex-shim` worked, because that path spawns with
 * `{ ...process.env }`.
 *
 * Lower-case variants are honored because curl-style tooling sets them and the runtime's
 * own `applyProxyEnv` already treats both cases as equivalent. Only the canonical
 * upper-case name is baked, so a definition never carries two spellings of one setting.
 */
export function resolvedProxyEnv(env: NodeJS.ProcessEnv = process.env): { name: string; value: string }[] {
  const resolved: { name: string; value: string }[] = [];
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key]?.trim() || env[key.toLowerCase()]?.trim();
    if (value) resolved.push({ name: key, value });
  }
  return resolved;
}
