/**
 * MiniMax client launchers.
 *
 * `ocx mcode` uses the managed `custom_provider.opencodex` block written by the
 * existing file-integration subsystem. `ocx mmx` is intentionally text-only:
 * the official platform CLI's text commands speak Anthropic Messages, while its
 * image/video/speech/music/search/quota endpoints are MiniMax-specific APIs that
 * OpenCodex does not claim to implement.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientPathError, mcodeConfigPath, LOOPBACK_API_KEY_PLACEHOLDER } from "../clients/config-export";
import { loadConfig } from "../config";
import { clearableDeadline } from "../lib/abort";
import { withProcessRuntimeProvenance } from "../lib/bun-runtime";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { commandInvocation } from "../lib/win-exec";
import { isLoopbackHostname } from "../server/auth-cors";
import { findLiveProxy, probeHostname, type LiveProxy } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";
import { opencodeProxyStartEnv } from "./opencode";

export interface MinimaxLaunchEnv {
  [key: string]: string | undefined;
}

export interface MmxTextBridge {
  baseUrl: string;
  port: number;
  stop(): Promise<void>;
}

export interface MmxTextBridgeOptions {
  /** Optional outer guard; production delegates timeout policy to `/v1/messages`. */
  headerTimeoutMs?: number;
}

export interface MmxTerminationTarget {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface MmxTerminationDeps {
  platform?: NodeJS.Platform;
  killWindowsTree?: (pid: number) => void;
}

export interface MmxSignalHost {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface MmxTerminationHandlersOptions {
  getChild: () => MmxTerminationTarget | null;
  cleanup: () => Promise<void>;
  host?: MmxSignalHost;
  now?: () => number;
  terminationDeps?: MmxTerminationDeps;
  onCleanupError?: (error: unknown) => void;
}

const MMX_TERMINATION_DUPLICATE_WINDOW_MS = 500;

const MMX_CHILD_OWNED_ENV_KEYS = new Set([
  "MMX_CONFIG_DIR",
  "MINIMAX_BASE_URL",
  "MINIMAX_REGION",
  "MINIMAX_API_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
]);

const MMX_GLOBAL_BOOLEAN_FLAGS = new Set([
  "--quiet",
  "--verbose",
  "--no-color",
  "--dry-run",
  "--non-interactive",
  "--yes",
  "--async",
  "--stream",
  "--no-stream",
  "--no-wait",
  "--help",
  "--version",
]);

/** Mirrors the official mmx command scanner's global-flag skipping behavior. */
export function mmxCommandPath(argv: readonly string[]): string[] {
  const path: string[] = [];
  for (let index = 0; index < argv.length;) {
    const arg = argv[index]!;
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals >= 0 ? arg.slice(0, equals) : arg;
      index += equals < 0 && !MMX_GLOBAL_BOOLEAN_FLAGS.has(name) ? 2 : 1;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    path.push(arg);
    index += 1;
  }
  return path;
}

/** Caller credentials and destinations may never override the proxy wrapper. */
export function mmxUnsafeOverride(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (arg === "--api-key" || arg.startsWith("--api-key=")) return "--api-key";
    if (arg === "--base-url" || arg.startsWith("--base-url=")) return "--base-url";
    if (arg === "--region" || arg.startsWith("--region=")) return "--region";
  }
  return null;
}

export function buildMmxEnv(
  live: Pick<LiveProxy, "hostname" | "port">,
  configDir: string,
  base: MinimaxLaunchEnv = process.env,
): MinimaxLaunchEnv {
  const env: MinimaxLaunchEnv = { ...base };
  // The official MMX client installs one ProxyAgent whenever any proxy variable
  // is present and does not apply NO_PROXY. Its OpenCodex destination is always
  // loopback, so carrying these variables could send the request off-machine.
  // Windows environment names are case-insensitive; strip every inherited
  // spelling before installing the wrapper-owned values below.
  for (const key of Object.keys(env)) {
    if (MMX_CHILD_OWNED_ENV_KEYS.has(key.toUpperCase())) delete env[key];
  }
  env.MMX_CONFIG_DIR = configDir;
  env.MINIMAX_BASE_URL = `http://${probeHostname(live.hostname)}:${live.port}`;
  // Prevent a parent-shell region from triggering key detection against the
  // official MiniMax hosts. The base URL above remains authoritative.
  env.MINIMAX_REGION = "global";
  return env;
}

/**
 * MMX hard-codes `/anthropic/v1/messages` below its configured base URL while
 * OpenCodex already exposes the canonical Anthropic data plane at
 * `/v1/messages`. Keep that client-specific path adaptation inside the checked
 * launcher instead of widening the proxy server's authentication surface.
 */
export function startMmxTextBridge(
  live: Pick<LiveProxy, "hostname" | "port">,
  options: MmxTextBridgeOptions = {},
): MmxTextBridge {
  const upstreamOrigin = `http://${probeHostname(live.hostname)}:${live.port}`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const incoming = new URL(req.url);
      const canonicalPath = incoming.pathname === "/anthropic/v1/messages"
        ? "/v1/messages"
        : incoming.pathname === "/anthropic/v1/messages/count_tokens"
          ? "/v1/messages/count_tokens"
          : null;
      if (req.method !== "POST" || !canonicalPath) {
        return Response.json({
          type: "error",
          error: { type: "not_found_error", message: "unsupported MMX bridge route" },
        }, { status: 404 });
      }

      const target = new URL(canonicalPath, `${upstreamOrigin}/`);
      target.search = incoming.search;
      const headers = new Headers(req.headers);
      // The bridge is loopback-only and OpenCodex does not require a real key
      // there. Pin the public placeholder even if a future MMX release loads a
      // credential from somewhere outside the isolated config directory.
      headers.delete("authorization");
      headers.delete("x-opencodex-api-key");
      headers.set("x-api-key", LOOPBACK_API_KEY_PLACEHOLDER);
      headers.delete("host");
      headers.delete("content-length");
      // The canonical data plane owns its configured response-header, retry,
      // and stream-stall budgets. An extra default here would cut off valid
      // non-streaming or failover completions before their real response.
      const headerDeadline = options.headerTimeoutMs === undefined
        ? null
        : clearableDeadline(options.headerTimeoutMs, req.signal);
      try {
        const upstreamRequest = new Request(target, {
          method: "POST",
          headers,
          body: req.body,
          signal: headerDeadline?.signal ?? req.signal,
        });
        return await fetch(upstreamRequest, {
          // Override HTTP(S)_PROXY with the loopback listener itself. Bun sends
          // the HTTP proxy-form request directly to this exact origin, so the
          // hop cannot leave the machine even when the parent has proxy vars.
          proxy: { url: upstreamOrigin },
        });
      } catch {
        return Response.json({
          type: "error",
          error: { type: "api_error", message: "OpenCodex proxy unavailable" },
        }, { status: 502 });
      } finally {
        // Once response headers arrive, streaming body cancellation remains
        // linked to the client while this response-header timer is disarmed.
        headerDeadline?.clear();
      }
    },
  });
  const bridgePort = server.port;
  if (bridgePort === undefined) {
    void server.stop(true);
    throw new Error("MMX text bridge did not receive a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${bridgePort}`,
    port: bridgePort,
    stop: () => server.stop(true),
  };
}

function normalizedMcodeBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.username
      || url.password
      || (url.pathname !== "" && url.pathname !== "/")
      || url.search
      || url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Read only the provider destination; never return or log the persisted key. */
export function mcodeOpenCodexBaseUrl(text: string): string | null {
  try {
    const parsed = Bun.YAML.parse(text) as {
      custom_provider?: { opencodex?: { options?: { baseURL?: unknown } } };
    };
    const baseURL = parsed?.custom_provider?.opencodex?.options?.baseURL;
    return typeof baseURL === "string" ? baseURL : null;
  } catch {
    return null;
  }
}

/** Reject stale runtime metadata that points a loopback-only launcher off-machine. */
export function usableMinimaxLiveProxy(live: LiveProxy | null): LiveProxy | null {
  if (!live) return null;
  return isLoopbackHostname(probeHostname(live.hostname)) ? live : null;
}

async function ensureProxy(config: OcxConfig): Promise<LiveProxy | null> {
  const live = usableMinimaxLiveProxy(await findLiveProxy());
  if (live) return live;
  const pinPort = typeof config.port === "number" && config.port > 0 ? config.port : 10100;
  const child = spawn(process.execPath, selfLaunchArgv(["start", "--port", String(pinPort)]), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    // Reuse the established service-token lookup so a detached start works
    // when admission lives in the hardened token file rather than this shell.
    env: withProcessRuntimeProvenance(opencodeProxyStartEnv(process.env) as NodeJS.ProcessEnv),
  });
  child.on("error", () => { /* the bounded health poll reports failure */ });
  child.unref();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const started = usableMinimaxLiveProxy(await findLiveProxy());
    if (started) return started;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

/** Only a root-level, single-token info request may bypass proxy isolation. */
export function isStandaloneInformationalInvocation(
  argv: readonly string[],
  client: "mcode" | "mmx",
): boolean {
  if (argv.length !== 1) return false;
  const arg = argv[0];
  if (arg === "--help" || arg === "-h" || arg === "--version") return true;
  // MMX 1.0.19 implements -v for version and does not implement -V. Preserve
  // MCode's established -V passthrough separately.
  return client === "mmx" ? arg === "-v" : arg === "-v" || arg === "-V";
}

/** Forward wrapper termination only while the MMX child is still live. */
export function forwardMmxTerminationSignal(
  child: MmxTerminationTarget,
  signal: "SIGINT" | "SIGTERM",
  deps: MmxTerminationDeps = {},
): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    if ((deps.platform ?? process.platform) === "win32") {
      if (!Number.isInteger(child.pid) || child.pid === undefined || child.pid <= 0) return false;
      const killWindowsTree = deps.killWindowsTree ?? (pid => {
        const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
        execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      });
      killWindowsTree(child.pid);
      return true;
    }
    return child.kill(signal);
  } catch {
    return false;
  }
}

/** Install persistent, duplicate-aware wrapper signal handlers. */
export function installMmxTerminationHandlers(
  options: MmxTerminationHandlersOptions,
): () => void {
  const host = options.host ?? process;
  const now = options.now ?? Date.now;
  let lastTerminationSignalAt: number | null = null;
  const onTerminationSignal = (signal: "SIGINT" | "SIGTERM") => {
    const receivedAt = now();
    // Ctrl-C reaches the foreground Bun process directly and is also
    // forwarded by bin/ocx.mjs. Keep the listener installed and coalesce the
    // near-simultaneous duplicate so async cleanup cannot be interrupted by
    // the default signal action after a once-listener disappears.
    if (
      lastTerminationSignalAt !== null
      && receivedAt - lastTerminationSignalAt < MMX_TERMINATION_DUPLICATE_WINDOW_MS
    ) return;
    lastTerminationSignalAt = receivedAt;
    const child = options.getChild();
    if (child) forwardMmxTerminationSignal(child, signal, options.terminationDeps);
    try {
      void options.cleanup().catch(error => { options.onCleanupError?.(error); });
    } catch (error) {
      options.onCleanupError?.(error);
    }
  };
  const onSigint = () => onTerminationSignal("SIGINT");
  const onSigterm = () => onTerminationSignal("SIGTERM");
  host.on("SIGINT", onSigint);
  host.on("SIGTERM", onSigterm);
  return () => {
    host.off("SIGINT", onSigint);
    host.off("SIGTERM", onSigterm);
  };
}

/** Keep signal handlers active until asynchronous bridge cleanup has settled. */
export async function finishMmxClientCleanup(
  cleanup: () => Promise<void>,
  removeTerminationHandlers: () => void,
): Promise<void> {
  try {
    await cleanup();
  } finally {
    removeTerminationHandlers();
  }
}

function spawnClient(
  command: "mcode" | "mmx",
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  installHint: string,
  onSpawn?: (child: ChildProcess) => void,
): Promise<number> {
  return new Promise(resolve => {
    const inv = commandInvocation(command, [...args]);
    const child = spawn(inv.file, inv.args, { stdio: "inherit", env, ...inv.options });
    onSpawn?.(child);
    child.on("error", (error: NodeJS.ErrnoException) => {
      console.error(error.code === "ENOENT" ? installHint : `❌ Failed to launch ${command}: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (process.platform === "win32" && code === 9009 && !signal) console.error(installHint);
      resolve(signal ? 1 : code ?? 0);
    });
  });
}

const MCODE_INSTALL_HINT = "❌ `mcode` CLI not found. Install MiniMax Code first: https://github.com/MiniMax-AI/minimax-code";
const MMX_INSTALL_HINT = "❌ `mmx` CLI not found. Install it first: npm install -g mmx-cli";

export async function cmdMcode(args: string[]): Promise<number> {
  if (isStandaloneInformationalInvocation(args, "mcode")) return spawnClient("mcode", args, process.env, MCODE_INSTALL_HINT);
  const config = loadConfig();
  if (!isLoopbackHostname(config.hostname)) {
    console.error("❌ MiniMax Code integration is loopback-only; its config cannot carry OpenCodex's dedicated remote-admission header.");
    return 2;
  }
  const live = await ensureProxy(config);
  if (!live) {
    console.error("❌ Proxy did not become healthy after starting.");
    return 1;
  }
  let configuredBase: string | null = null;
  try {
    configuredBase = mcodeOpenCodexBaseUrl(readFileSync(mcodeConfigPath(process.env), "utf8"));
  } catch (error) {
    // Missing or unreadable is reported as not connected below. An unstable
    // relative override needs its own message because re-enabling cannot fix it.
    if (error instanceof ClientPathError) {
      console.error(`❌ ${error.message}`);
      return 2;
    }
  }
  if (!configuredBase) {
    console.error("❌ MiniMax Code is not connected. Run: ocx integration client enable --client mcode");
    return 2;
  }
  const expected = `http://${probeHostname(live.hostname)}:${live.port}`;
  if (normalizedMcodeBaseUrl(configuredBase) !== normalizedMcodeBaseUrl(expected)) {
    console.error("❌ MiniMax Code's OpenCodex provider points at a stale proxy address. Re-run: ocx integration client enable --client mcode");
    return 2;
  }
  console.error(`✅ MiniMax Code wired to ${expected}; select custom_provider:opencodex/<model> in MCode.`);
  return spawnClient("mcode", args, process.env, MCODE_INSTALL_HINT);
}

export async function cmdMmx(args: string[]): Promise<number> {
  if (isStandaloneInformationalInvocation(args, "mmx")) return spawnClient("mmx", args, process.env, MMX_INSTALL_HINT);
  const unsafe = mmxUnsafeOverride(args);
  if (unsafe) {
    console.error(`❌ ${unsafe} is not accepted by ocx mmx because it could bypass the proxy or expose a caller credential.`);
    return 2;
  }
  const commandPath = mmxCommandPath(args);
  if (commandPath[0] !== "text") {
    console.error("❌ ocx mmx supports only `mmx text` commands. Use plain `mmx` for MiniMax image, video, speech, music, vision, search, quota, auth, config, file, and update APIs.");
    return 2;
  }
  const config = loadConfig();
  if (!isLoopbackHostname(config.hostname)) {
    console.error("❌ ocx mmx is loopback-only; MMX has no field for OpenCodex's dedicated remote-admission header.");
    return 2;
  }
  const live = await ensureProxy(config);
  if (!live) {
    console.error("❌ Proxy did not become healthy after starting.");
    return 1;
  }

  const configDir = mkdtempSync(join(tmpdir(), "opencodex-mmx-"));
  let bridge: MmxTextBridge | null = null;
  let mmxChild: ChildProcess | null = null;
  let cleanupPromise: Promise<void> | null = null;
  let removeTerminationHandlers = () => {};
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      const activeBridge = bridge;
      bridge = null;
      try {
        if (activeBridge) await activeBridge.stop();
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    })();
    return cleanupPromise;
  };
  try {
    // Isolate MMX from ~/.mmx OAuth/API-key state. The only credential in this
    // temporary file is a public loopback placeholder, and the directory is
    // removed as soon as the child exits.
    writeFileSync(join(configDir, "config.json"), `${JSON.stringify({
      api_key: LOOPBACK_API_KEY_PLACEHOLDER,
      region: "global",
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    bridge = startMmxTextBridge(live);
    const env = buildMmxEnv({ hostname: "127.0.0.1", port: bridge.port }, configDir, process.env) as NodeJS.ProcessEnv;
    console.error(`✅ MiniMax CLI text bridged to http://${probeHostname(live.hostname)}:${live.port}/v1/messages.`);
    removeTerminationHandlers = installMmxTerminationHandlers({
      getChild: () => mmxChild,
      cleanup,
      onCleanupError: error => {
        console.error(`❌ Failed to clean up the MMX bridge after a termination signal: ${String(error)}`);
      },
    });
    return await spawnClient("mmx", args, env, MMX_INSTALL_HINT, child => { mmxChild = child; });
  } finally {
    await finishMmxClientCleanup(cleanup, removeTerminationHandlers);
  }
}
