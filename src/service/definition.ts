/**
 * The shape of a service definition: the shell command both Unix backends bake into
 * their unit/plist, the port they pin into it, and the proxy environment it carries.
 *
 * Leaf module. It reads config and the token-file path, and asks nothing of the
 * backends that consume it — importing it from `launchd.ts`/`systemd.ts` cannot
 * route back through them (see `installedServiceListenPort` in `health.ts`, which
 * intentionally stays behind because it asks every backend).
 */
import { loadConfig } from "../config";
import { serviceApiTokenFilePath } from "../lib/service-secrets";
import { PROXY_ENV_KEYS } from "../lib/proxy-env";

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

export function buildServiceShellCommand(bun: string, cli: string | null, port = resolveServiceListenPort()): string {
  const tokenFile = serviceApiTokenFilePath();
  const args = cli ? `${shellQuote(cli)} start` : "start";
  return `if [ -f ${shellQuote(tokenFile)} ]; then OPENCODEX_API_AUTH_TOKEN="$(cat ${shellQuote(tokenFile)})"; export OPENCODEX_API_AUTH_TOKEN; fi; exec ${shellQuote(bun)} ${args} --port ${port}`;
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
