/**
 * `ocx doctor` - read-only environment diagnostics.
 *
 * Explains WHY ChatGPT quota may never populate (and thus why account
 * auto-switch can appear stuck), especially on WSL2 where outbound fetch to
 * chatgpt.com can be blocked by NAT/DNS/VPN/proxy differences. Observe-only:
 * it never sets proxy env, relocates state dirs, mutates quota, or changes
 * networking. See devlog/_plan/260630_wsl-account-autoswitch/30_*.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandUserPath, getConfigDir, getConfigPath, readConfigDiagnostics, readPid, resolveEnvValue } from "./config";
import { readCodexTokens } from "./codex-auth-collision";

const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const PROBE_TIMEOUT_MS = 8000;

export type PathRow = { label: string; path: string; exists: boolean };

export function resolveCodexHomeDir(): string {
  const raw = process.env["CODEX_HOME"]?.trim();
  // `~` parity with the hardened runtime paths (codex-paths.ts) — a literal "~/..." here
  // would report every Codex file as missing while the runtime happily uses the real dir.
  return raw ? resolve(expandUserPath(raw)) : join(homedir(), ".codex");
}

export function collectPaths(): PathRow[] {
  const codexHome = resolveCodexHomeDir();
  const opencodexHome = getConfigDir();
  return [
    { label: "CODEX_HOME", path: codexHome, exists: existsSync(codexHome) },
    { label: "CODEX_HOME/auth.json", path: join(codexHome, "auth.json"), exists: existsSync(join(codexHome, "auth.json")) },
    { label: "OPENCODEX_HOME", path: opencodexHome, exists: existsSync(opencodexHome) },
    { label: "OPENCODEX_HOME/config.json", path: getConfigPath(), exists: existsSync(getConfigPath()) },
  ];
}

export type FsTypeInfo = { fstype: string; mount: string; isDrvfs: boolean; isMntDrive: boolean };

/**
 * Parse `/proc/mounts`-shaped content and return the longest mount-point prefix
 * covering `path`. `mountsContent` is injectable for testing; in production the
 * caller passes the real file (or null off-Linux -> "n/a").
 */
export function detectFsType(path: string, mountsContent: string | null): FsTypeInfo {
  const isMntDrive = /^\/mnt\/[a-z]\//i.test(path) || /^\/mnt\/[a-z]$/i.test(path);
  if (!mountsContent) {
    return { fstype: "n/a", mount: "", isDrvfs: false, isMntDrive };
  }
  let best: { mount: string; fstype: string } | null = null;
  for (const line of mountsContent.split("\n")) {
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const mount = parts[1]!;
    const fstype = parts[2]!;
    if (path === mount || path.startsWith(mount.endsWith("/") ? mount : `${mount}/`) || mount === "/") {
      if (!best || mount.length > best.mount.length) best = { mount, fstype };
    }
  }
  const fstype = best?.fstype ?? "unknown";
  return {
    fstype,
    mount: best?.mount ?? "",
    isDrvfs: fstype === "drvfs" || fstype === "9p",
    isMntDrive,
  };
}

function readMounts(): string | null {
  try {
    return process.platform === "linux" ? readFileSync("/proc/mounts", "utf-8") : null;
  } catch {
    return null;
  }
}

const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const;

export type ProxyEnvRow = { key: string; present: boolean };
export type EnvMap = Record<string, string | undefined>;

/** Report only presence/absence of proxy env vars - never the value (it may
 * embed credentials). Checks both upper- and lower-case forms. */
export function collectProxyEnv(env: EnvMap = process.env): ProxyEnvRow[] {
  return PROXY_KEYS.map(key => ({
    key,
    present: !!(env[key]?.trim() || env[key.toLowerCase()]?.trim()),
  }));
}

export type ConfiguredProxyDiagnostic = {
  key: "config.proxy";
  present: boolean;
  configured: boolean;
  source: "default" | "file" | "fallback";
  detail: string;
};

function envReferenceName(value: string): string | null {
  const braced = value.match(/^\$\{(\w+)\}$/);
  if (braced) return braced[1]!;
  const bare = value.match(/^\$(\w+)$/);
  return bare ? bare[1]! : null;
}

export function collectConfiguredProxy(): ConfiguredProxyDiagnostic {
  const diagnostics = readConfigDiagnostics();
  const rawProxy = typeof diagnostics.config.proxy === "string" ? diagnostics.config.proxy.trim() : "";
  if (diagnostics.error) {
    return {
      key: "config.proxy",
      present: false,
      configured: false,
      source: diagnostics.source,
      detail: `config unreadable (${diagnostics.error})`,
    };
  }
  if (!rawProxy) {
    return {
      key: "config.proxy",
      present: false,
      configured: false,
      source: diagnostics.source,
      detail: "not configured",
    };
  }

  const envName = envReferenceName(rawProxy);
  const resolved = resolveEnvValue(rawProxy);
  if (resolved?.trim()) {
    return {
      key: "config.proxy",
      present: true,
      configured: true,
      source: diagnostics.source,
      detail: envName ? `env reference ${envName} resolved` : "value hidden",
    };
  }

  return {
    key: "config.proxy",
    present: false,
    configured: true,
    source: diagnostics.source,
    detail: envName ? `env reference ${envName} is unset` : "empty after resolution",
  };
}

export function parseProcessEnvBlock(content: string): EnvMap {
  const env: EnvMap = {};
  for (const entry of content.split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return env;
}

export type RunningProxyEnvDiagnostic =
  | { status: "not_running"; rows: ProxyEnvRow[] }
  | { status: "ok"; pid: number; rows: ProxyEnvRow[] }
  | { status: "unavailable"; pid: number; reason: string; rows: ProxyEnvRow[] };

type RunningProxyEnvDeps = {
  readPidFn?: () => number | null;
  readEnvironFn?: (pid: number) => string | null;
  platform?: NodeJS.Platform | string;
};

function readProcessEnviron(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf-8");
  } catch {
    return null;
  }
}

/*
 * [Decision Log]
 * - Purpose: Make `ocx doctor` distinguish the current shell env from the already-running proxy process env.
 * - Alternatives: Rename the old section only; parse service-manager env for each OS; read the recorded proxy PID's env presence.
 * - Rationale: PID env presence is the narrowest useful diagnostic on Linux/WSL, avoids secret value output, and keeps unsupported platforms explicit.
 */
export function collectRunningProxyEnv(deps: RunningProxyEnvDeps = {}): RunningProxyEnvDiagnostic {
  const rowsWhenEmpty = () => collectProxyEnv({});
  const pid = (deps.readPidFn ?? readPid)();
  if (!pid) return { status: "not_running", rows: rowsWhenEmpty() };

  const platform = deps.platform ?? process.platform;
  if (platform !== "linux" && !deps.readEnvironFn) {
    return {
      status: "unavailable",
      pid,
      reason: "process env inspection is only supported on Linux",
      rows: rowsWhenEmpty(),
    };
  }

  const content = (deps.readEnvironFn ?? readProcessEnviron)(pid);
  if (content === null) {
    return {
      status: "unavailable",
      pid,
      reason: "could not read process environment",
      rows: rowsWhenEmpty(),
    };
  }

  return {
    status: "ok",
    pid,
    rows: collectProxyEnv(parseProcessEnvBlock(content)),
  };
}

export type WhamProbeResult = {
  ok: boolean;
  status: number | null;
  durationMs: number;
  classification: "ok" | "timeout" | "connect_error" | string;
  authenticated: boolean;
};

/**
 * Replicate the runtime WHAM fetch shape (same URL, 8s timeout, main-token
 * headers when present) so the probe fails exactly where the real path fails.
 * `fetchImpl` is injectable for testing.
 */
export async function probeWham(fetchImpl: typeof fetch = fetch): Promise<WhamProbeResult> {
  const tokens = readCodexTokens();
  const headers: Record<string, string> = {};
  if (tokens) {
    headers.Authorization = `Bearer ${tokens.access_token}`;
    headers["ChatGPT-Account-Id"] = tokens.account_id;
  }
  const start = performance.now();
  try {
    const resp = await fetchImpl(WHAM_USAGE_URL, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const durationMs = Math.round(performance.now() - start);
    return {
      ok: resp.ok,
      status: resp.status,
      durationMs,
      classification: resp.ok ? "ok" : `http_${resp.status}`,
      authenticated: !!tokens,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const name = err instanceof Error ? err.name : String(err);
    const classification = name === "TimeoutError" || name === "AbortError"
      ? "timeout"
      : "connect_error";
    return { ok: false, status: null, durationMs, classification, authenticated: !!tokens };
  }
}

export async function runDoctor(): Promise<void> {
  console.log("opencodex doctor\n");

  const paths = collectPaths();
  const mounts = readMounts();
  console.log("Paths");
  for (const row of paths) {
    const fs = detectFsType(row.path, mounts);
    const flags = [fs.fstype !== "n/a" ? `fs=${fs.fstype}` : null, fs.isDrvfs || fs.isMntDrive ? "WSL /mnt drive" : null]
      .filter(Boolean).join(", ");
    console.log(`  ${row.exists ? "ok " : "-- "} ${row.label}: ${row.path}${flags ? `  (${flags})` : ""}`);
  }

  const currentProxyEnv = collectProxyEnv();
  const configuredProxy = collectConfiguredProxy();
  const runningProxyEnv = collectRunningProxyEnv();

  console.log("\nCurrent doctor process proxy env (presence only)");
  for (const row of currentProxyEnv) {
    console.log(`  ${row.present ? "set    " : "unset  "} ${row.key}`);
  }

  console.log("\nConfigured proxy (value hidden)");
  console.log(`  ${configuredProxy.present ? "set    " : "unset  "} ${configuredProxy.key} (${configuredProxy.source}; ${configuredProxy.detail})`);

  console.log("\nRunning proxy process proxy env (presence only)");
  if (runningProxyEnv.status === "not_running") {
    console.log("  --     no running ocx proxy process found");
  } else if (runningProxyEnv.status === "unavailable") {
    console.log(`  --     pid ${runningProxyEnv.pid}: ${runningProxyEnv.reason}`);
  } else {
    console.log(`  ok     pid ${runningProxyEnv.pid}`);
    for (const row of runningProxyEnv.rows) {
      console.log(`  ${row.present ? "set    " : "unset  "} ${row.key}`);
    }
  }

  console.log("\nWHAM reachability");
  const probe = await probeWham();
  const detail = probe.status !== null ? `status=${probe.status}` : `error=${probe.classification}`;
  console.log(`  ${probe.ok ? "ok " : "-- "} ${WHAM_USAGE_URL}`);
  console.log(`       ${detail}, ${probe.durationMs}ms, ${probe.authenticated ? "authenticated" : "unauthenticated"}`);

  // Hints, not fixes.
  const hints: string[] = [];
  const anyDrvfs = paths.some(p => detectFsType(p.path, mounts).isDrvfs || detectFsType(p.path, mounts).isMntDrive);
  const noProxy = currentProxyEnv.every(p => !p.present) && !configuredProxy.present;
  if (anyDrvfs) {
    hints.push("State dir is on a Windows-mounted (/mnt) drive. Prefer the Linux home (~) under WSL for token/lock reliability.");
  }
  if (!probe.ok) {
    if (probe.classification === "timeout" || probe.classification === "connect_error") {
      hints.push("WHAM probe could not reach chatgpt.com. On WSL2 this is often NAT/DNS/VPN. Quota cannot prime, so auto-switch stays on unknown scores.");
      if (noProxy) {
        hints.push("No proxy is visible to this doctor process and config.proxy is unset or unresolved. If Windows uses a proxy/VPN, set config.proxy or start ocx from a shell with HTTP(S)_PROXY.");
      }
    }
  }
  if (hints.length > 0) {
    console.log("\nHints");
    for (const h of hints) console.log(`  - ${h}`);
  }
}
