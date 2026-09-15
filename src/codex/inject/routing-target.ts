import { subagentDefaultSyncEffective } from "../../config";
import {
  effectiveLoopbackListenerPort,
  isLoopbackHostname,
  shouldInjectApiAuthHeader,
} from "../loopback-target";
import type { ManagedSubagentDefaults } from "../subagent-defaults";
import type { OcxConfig } from "../../types";

export interface CodexRoutingTarget {
  baseUrl: string;
  requiresAdmissionToken: boolean;
  tokenEnv: "OPENCODEX_API_AUTH_TOKEN";
  /**
   * Opt-in authless Codex Desktop mode (#1107): inject the dedicated provider table with
   * `requires_openai_auth = false` so Desktop skips the ChatGPT login gate. Only ever true for
   * loopback targets that need no admission token; non-loopback admission is a separate layer
   * and is never weakened by this flag.
   */
  desktopAuthless?: boolean;
  /** Select the dedicated provider identity so Codex owns compaction locally. */
  clientCompaction?: boolean;
}

export function validateCodexRoutingTarget(target: CodexRoutingTarget): CodexRoutingTarget {
  let parsed: URL;
  try {
    parsed = new URL(target.baseUrl);
  } catch {
    throw new TypeError("Codex routing target must be an absolute HTTP(S) /v1 URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/v1"
    || parsed.search
    || parsed.hash
    || target.tokenEnv !== "OPENCODEX_API_AUTH_TOKEN"
  ) {
    throw new TypeError("Codex routing target must be a canonical HTTP(S) /v1 URL without credentials, query, or fragment");
  }
  return { ...target, baseUrl: `${parsed.origin}/v1` };
}

/** Provider-table form is used when auth, admission, or compaction policy needs a dedicated provider. */
export function usesProviderTable(target: CodexRoutingTarget): boolean {
  return target.requiresAdmissionToken
    || target.desktopAuthless === true
    || target.clientCompaction === true;
}

export function standaloneCodexRoutingTarget(
  port: number,
  config?: Pick<
    OcxConfig,
    "hostname" | "unauthenticatedLoopbackListener" | "codexDesktopAuthless" | "codexClientCompaction"
  >,
): CodexRoutingTarget {
  // An enabled listener with no `port` is the companion form: it answers on `port` itself,
  // bound to 127.0.0.1 (#4236). Resolving it through the shared helper is what makes the
  // one-port hub work without every writer repeating `?? port`.
  const loopback = config?.unauthenticatedLoopbackListener;
  const effectivePort = effectiveLoopbackListenerPort(config, port) ?? port;
  const hostname = loopback?.enabled ? undefined : config?.hostname;
  const requiresAdmissionToken = loopback?.enabled ? false : shouldInjectApiAuthHeader(config);
  return {
    baseUrl: `http://${providerBaseHost(hostname)}:${effectivePort}/v1`,
    requiresAdmissionToken,
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    ...(config?.codexDesktopAuthless === true && !requiresAdmissionToken
      ? { desktopAuthless: true }
      : {}),
    ...(config?.codexClientCompaction === true && !requiresAdmissionToken
      ? { clientCompaction: true }
      : {}),
  };
}

export function routingTargetOrigin(target: CodexRoutingTarget): string {
  return target.baseUrl.slice(0, -3);
}

export function configuredManagedSubagentDefaults(
  config:
    | Pick<
        OcxConfig,
        "injectionModel" | "injectionEffort" | "syncCodexSubagentDefaults"
      >
    | undefined,
): ManagedSubagentDefaults | null {
  if (!subagentDefaultSyncEffective(config ?? {})) return null;
  return {
    model: config!.injectionModel!.trim(),
    ...(config!.injectionEffort?.trim()
      ? { reasoningEffort: config!.injectionEffort.trim() }
      : {}),
  };
}

/**
 * The `[model_providers.opencodex]` TABLE only. A table is position-independent in TOML, so it is
 * safe to append at EOF. The bare root key `model_provider = "opencodex"` is NOT included here —
 * it must live at the document root (before any table header) and is set separately by
 * setRootModelProvider(). Appending the bare key at EOF was the original bug: it nested under
 * whatever `[table]` happened to be open last (e.g. `[plugins."chrome@openai-bundled"]`), so Codex
 * never saw a global model_provider and silently fell back to the `openai` (ChatGPT) provider.
 */
export function providerBaseHost(hostname: string | undefined): string {
  const trimmed = (hostname ?? "127.0.0.1").trim();
  const lower = trimmed.toLowerCase();
  // Match what the server actually binds. Writing "localhost" while binding IPv4-only
  // 127.0.0.1 breaks on Windows, where localhost commonly resolves to ::1 first.
  if (lower === "::1" || lower === "[::1]") return "[::1]";
  if (
    isLoopbackHostname(trimmed) ||
    trimmed === "0.0.0.0" ||
    trimmed === "::" ||
    trimmed === "[::]"
  )
    return "127.0.0.1";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

