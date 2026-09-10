import { join } from "node:path";
import { DEFAULT_SUBAGENT_MODELS, SUBAGENT_MODELS_VERSION } from "./subagent-models";
import { MULTI_AGENT_SURFACE_ADVISORY_VERSION } from "./multi-agent-surface";
import { DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES } from "../lib/app-owned-memory";
import { describeProxyForLog, readWindowsSystemProxy, type WindowsProxyRegistryReader } from "../lib/windows-system-proxy";
import { OPENAI_PROVIDER_TIER_VERSION, type OcxConfig } from "../types";
import type { OcxRuntimeRole } from "../types/config";

export function codexAutoStartEnabled(config: Pick<OcxConfig, "codexAutoStart">): boolean {
  return config.codexAutoStart !== false;
}

export const CODEX_SHIM_AUTO_RESTORE_ENV = "OPENCODEX_CODEX_SHIM_AUTO_RESTORE";

export function codexShimAutoRestoreEnabled(
  config: Pick<OcxConfig, "codexShimAutoRestore">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return config.codexShimAutoRestore !== false && env[CODEX_SHIM_AUTO_RESTORE_ENV] !== "0";
}

export function multiAgentGuidanceEnabled(
  config: Pick<OcxConfig, "multiAgentGuidanceEnabled">,
): boolean {
  return config.multiAgentGuidanceEnabled !== false;
}

export function runtimeRole(config: Pick<OcxConfig, "runtimeRole">): OcxRuntimeRole {
  return config.runtimeRole ?? "standalone";
}

export function getDefaultConfig(): OcxConfig {
  // Fresh-install default: works out of the box with Codex's ChatGPT OAuth (no API key).
  // gpt-* requests forward the caller's incoming OAuth headers to the ChatGPT backend.
  // Adding extra providers (e.g. opencode-go) and switching defaultProvider is a user/runtime choice.
  return {
    port: 10100,
    emptyCompletionRetry: false,
    dropCodexSafetyBuffering: false,
    fastRows: true,
    managementUsageMaxReadBytes: 64 * 1024 * 1024,
    appOwnedMemoryBudgetMb: DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES / (1024 * 1024),
    // Fresh/re-initialized configs are already written in the current three-tier
    // OpenAI shape. Mark them as such so startup does not mistake them for a
    // legacy config and collide with an immutable backup from an earlier setup.
    openaiProviderTierVersion: OPENAI_PROVIDER_TIER_VERSION,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    defaultProvider: "openai",
    subagentModels: [...DEFAULT_SUBAGENT_MODELS],
    subagentModelsVersion: SUBAGENT_MODELS_VERSION,
    // v1 is the shipped surface while a v2 native-to-routed task is undeliverable
    // ciphertext. Written explicitly rather than left absent, because an absent key
    // means base everywhere else. A fresh install starts already acknowledged: there is
    // nothing to advise an operator who is on the recommended surface.
    multiAgentMode: "v1",
    multiAgentSurfaceAdvisoryVersion: MULTI_AGENT_SURFACE_ADVISORY_VERSION,
    multiAgentGuidanceEnabled: true,
    websockets: false,
    codexAutoStart: true,
    codexShimAutoRestore: true,
  };
}

export function resolveEnvValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\$\{(\w+)\}$/);
  if (match) return process.env[match[1]];
  if (value.startsWith("$")) return process.env[value.slice(1)];
  return value;
}

const warnedProxyConfigDiscards = new Set<"proxy" | "noProxy" | "noProxyElements">();

function warnProxyConfigDiscardOnce(kind: "proxy" | "noProxy" | "noProxyElements"): void {
  if (warnedProxyConfigDiscards.has(kind)) return;
  warnedProxyConfigDiscards.add(kind);
  if (kind === "proxy") {
    console.warn(
      "⚠️  config.json proxy was discarded because it is not a non-empty resolved string — configured proxy routing is disabled; existing proxy environment variables remain authoritative, otherwise outbound requests use direct egress",
    );
  } else if (kind === "noProxy") {
    console.warn(
      "⚠️  config.json noProxy was discarded because it is not a string, string array, or resolved environment reference — existing NO_PROXY and loopback bypasses remain",
    );
  } else {
    console.warn(
      "⚠️  config.json noProxy contains invalid elements — invalid elements were ignored; valid entries, existing NO_PROXY, and loopback bypasses remain",
    );
  }
}

/**
 * Mirror `config.proxy` into HTTP(S)_PROXY env vars. Bun fetch consumes them natively; transports
 * such as the ChatGPT upstream WebSocket select the same environment explicitly. User-set HTTP(S)_PROXY
 * variables win; config fills missing scheme proxies, which take precedence over ALL_PROXY for WS.
 * localhost/127.0.0.1 are appended to NO_PROXY so the CLI's own health checks and
 * running-proxy API calls stay direct. Call once per process entry that makes outbound provider
 * requests (server start, catalog sync).
 */
export function applyProxyEnv(config: OcxConfig): void {
  applyProxyEnvWith(config);
}

/** Test seam for `proxy: "auto"`: the registry reader and platform are injectable. */
export function applyProxyEnvWith(
  config: OcxConfig,
  auto: { reader?: WindowsProxyRegistryReader; platform?: NodeJS.Platform } = {},
): void {
  // `proxy` and `noProxy` are not declared in the top-level schema, which ends in
  // `.passthrough()`, so whatever is on disk arrives here verbatim. A non-string value
  // reached string-only methods and threw out of this function, and it runs once per
  // process entry point — the failure was a startup crash, not a degraded proxy. Ignore
  // malformed values with a privacy-safe warning instead: they cannot express a routing
  // intent, and refusing to start is a worse answer than starting without them.
  const rawProxy = config.proxy;
  let proxy = typeof rawProxy === "string" ? resolveEnvValue(rawProxy) : undefined;
  if (!proxy) {
    if (rawProxy !== undefined) warnProxyConfigDiscardOnce("proxy");
    return;
  }
  if (proxy.trim().toLowerCase() === "auto") {
    // #1525 slice 1: one startup read of the Windows static proxy. Never copy the literal
    // "auto" into HTTP_PROXY; every non-proxy outcome leaves outbound routing as it was.
    if (process.env.HTTP_PROXY?.trim() || process.env.http_proxy?.trim()
      || process.env.HTTPS_PROXY?.trim() || process.env.https_proxy?.trim()) {
      console.log("[opencodex] proxy \"auto\": existing HTTP_PROXY/HTTPS_PROXY environment wins; system proxy not consulted");
      proxy = undefined;
    } else {
      const found = readWindowsSystemProxy(auto.reader, auto.platform);
      if (found.kind === "proxy") {
        console.log(`[opencodex] proxy "auto": using Windows system proxy ${describeProxyForLog(found.url)}`);
        proxy = found.url;
      } else {
        const reason = found.kind === "unsupported"
          ? "only Windows system proxy discovery is supported; using direct egress on this OS"
          : found.kind === "disabled"
            ? "Windows system proxy is disabled; using direct egress"
            : found.kind === "socks-only"
              ? "Windows system proxy is SOCKS-only, which HTTP_PROXY cannot express; using direct egress"
              : "Windows proxy settings could not be read; using direct egress";
        console.log(`[opencodex] proxy "auto": ${reason}`);
        proxy = undefined;
      }
    }
  }
  if (proxy) {
  if (!process.env.HTTP_PROXY?.trim() && !process.env.http_proxy?.trim()) process.env.HTTP_PROXY = proxy;
  if (!process.env.HTTPS_PROXY?.trim() && !process.env.https_proxy?.trim()) process.env.HTTPS_PROXY = proxy;
  }
  const existing = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  const entries = existing.split(",").map(s => s.trim()).filter(Boolean);
  const seen = new Set(entries.map(e => e.toLowerCase()));
  // Configured entries first, then loopback: loopback is unconditional, so appending it last
  // keeps it present even when the operator lists a loopback host themselves.
  const raw = config.noProxy;
  let configuredEntries: string[];
  if (Array.isArray(raw)) {
    // One unusable element must not discard the operator's other entries.
    if (raw.some(entry => typeof entry !== "string")) warnProxyConfigDiscardOnce("noProxyElements");
    configuredEntries = raw.filter((entry): entry is string => typeof entry === "string");
  } else if (typeof raw === "string") {
    const resolved = resolveEnvValue(raw);
    if (raw && resolved === undefined) warnProxyConfigDiscardOnce("noProxy");
    configuredEntries = (resolved ?? "").split(",");
  } else {
    if (raw !== undefined) warnProxyConfigDiscardOnce("noProxy");
    configuredEntries = [];
  }
  const configured = configuredEntries
    .map(entry => entry.trim())
    .filter(Boolean);
  for (const host of [...configured, "localhost", "127.0.0.1", "::1", "[::1]"]) {
    const key = host.toLowerCase();
    if (!seen.has(key)) {
      entries.push(host);
      seen.add(key);
    }
  }
  process.env.NO_PROXY = entries.join(",");
}

