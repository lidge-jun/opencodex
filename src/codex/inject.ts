import { existsSync, readFileSync, unlinkSync } from "node:fs";
import {
  atomicWriteFile,
  loadConfig,
  observeConfigGeneration,
  readConfigAdmissionSnapshot,
  subagentDefaultSyncEffective,
  websocketsEnabled,
} from "../config";
import { CodexWriteLockSkipped, withCodexWriteLock } from "./codex-write-lock";
import { shouldSyncCodexOnStart } from "./desired-state";
import { resolveCodexHistoryTransition } from "./history-transition";
import {
  buildInjectWitness,
  captureCodexPreImages,
  codexInjectLockOutcome,
  codexWriteCoordinationEligibility,
  CodexPartialWriteError,
  CodexWriteConflictError,
  DEFAULT_INJECT_LOCK_TIMEOUT_MS,
  recomputeInjectWitness,
  recordCodexNativeTransactionProvenance,
  restoreCodexPreImages,
} from "./inject-coordination";
import { readIntegrationRecord } from "./integration-record";
import { classifyNativeRoutedResidue } from "./native-residue";
import { inspectNativeCodexOwnership } from "../integrations/native/ownership-preflight";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "./user-identity";
import {
  markJournalInjectedState,
  journaledInjectedOpenaiBaseUrl,
  journaledInjectedRealtimeWsBaseUrl,
  journaledInjectedCatalogPath,
  removeJournal,
  restoreJournalState,
  writeJournal,
} from "./journal";
import { withCatalogWriteSerialization } from "./catalog-write-serialization";
import { restoreCodexCatalogWithPermit } from "./catalog/sync";
import { syncCodexHistoryProvider, type CodexHistoryFailureReason } from "./history-provider";
import {
  describeHistoryJobFailure,
  deriveCodexHistoryOperation,
  resolveCodexHistoryJobTarget,
  runCodexHistoryJob,
  type CodexHistoryJobOutcome,
} from "./history-job";
import {
  OCX_SECTION_MARKER,
  REALTIME_WS_BASE_URL_KEY,
  hasInjectedCodexRouting,
  hasInjectedOpenaiBaseUrl,
  isRootOpenaiBaseUrlLine,
  isRootRealtimeWsBaseUrlLine,
  providerTableStart,
  providerTableString,
  rootTomlString,
  stripJournaledOpenaiBaseUrl,
  tomlStringPattern,
} from "./injected-marker";
import {
  CODEX_CONFIG_PATH,
  CODEX_PROFILE_PATH,
  DEFAULT_CATALOG_PATH,
  getCodexHome,
  parseTomlString,
  readRootTomlString,
  resolveCodexConfigPath,
  tomlString,
} from "./paths";
import { resolveEffectiveProjectModelProvider } from "./project-config-warnings";
import {
  transformManagedSubagentDefaults,
  type ManagedSubagentDefaults,
} from "./subagent-defaults";
import type { OcxConfig } from "../types";

// Ownership predicates live in `./injected-marker` so `journal.ts` can reach them
// without importing this module back. Re-exported for existing external callers.
export { hasInjectedCodexRouting, hasInjectedOpenaiBaseUrl };

export function externalCodexModelProvider(content: string): string | null {
  const provider = resolveEffectiveProjectModelProvider(content).provider;
  return provider && provider !== "openai" && provider !== "opencodex"
    ? provider
    : null;
}

export function currentExternalCodexModelProvider(): string | null {
  if (!existsSync(CODEX_CONFIG_PATH)) return null;
  return externalCodexModelProvider(readFileSync(CODEX_CONFIG_PATH, "utf8"));
}

/**
 * Detect the file's dominant line ending. Every transform in this module is LF-pure
 * (split("\n") + hard "\n" joins), so CRLF configs (Windows-edited config.toml) are
 * normalized to LF at the pipeline boundary and converted back on write — otherwise a
 * single inject would leave a mixed-EOL file.
 */
export function dominantEol(content: string): "\r\n" | "\n" {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return "\n";
  const bareLf = (content.match(/\n/g) ?? []).length - crlf;
  return crlf >= bareLf ? "\r\n" : "\n";
}

/** Normalize all line endings to `eol` (CRLF first collapsed to LF, then expanded). */
export function applyEol(content: string, eol: "\r\n" | "\n"): string {
  const lf = content.replace(/\r\n/g, "\n");
  return eol === "\n" ? lf : lf.replace(/\n/g, "\r\n");
}

/**
 * Design B (2026-07-06): loopback installs no longer re-tag the provider. Instead of
 * `model_provider = "opencodex"` + a `[model_providers.opencodex]` table, we set the official
 * built-in override `openai_base_url` (codex-rs config_toml.rs) so codex's own `openai`
 * provider points at the proxy. Threads keep `model_provider = "openai"`, so history never
 * needs remapping or restore. Non-loopback binds keep the legacy table injection because the
 * built-in provider cannot carry the `x-opencodex-api-key` env header.
 */

export interface InjectCodexOptions {
  /**
   * Absolute or CODEX_HOME-relative catalog path to advertise to Codex. Pass `null` only when the
   * opencodex catalog could not be materialized; Codex will then keep its native catalog instead of
   * failing on a missing model_catalog_json file.
   */
  catalogPath?: string | null;
  /**
   * How long to wait for the Codex write lock before reporting contention.
   *
   * Bounded by default so a stuck holder cannot wedge `ocx start`; an explicit
   * caller that is willing to wait can raise it.
   */
  lockTimeoutMs?: number;
  /**
   * Validate the same config transformations and write-coordination eligibility without
   * changing the journal, config, profile, catalog, cache, or history. Sync uses this before
   * provider discovery so a deterministic config refusal cannot degrade an existing catalog.
   */
  validateOnly?: boolean;
  /** Explicit remote routing target. Absence preserves byte-compatible standalone output. */
  routingTarget?: CodexRoutingTarget;
  journalOwner?: { kind: "process" } | { kind: "client"; apiKeyId: string };
}

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
}

function validateCodexRoutingTarget(target: CodexRoutingTarget): CodexRoutingTarget {
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

/** Provider-table form is used for non-loopback admission and for the authless Desktop opt-in. */
function usesProviderTable(target: CodexRoutingTarget): boolean {
  return target.requiresAdmissionToken || target.desktopAuthless === true;
}

export function standaloneCodexRoutingTarget(
  port: number,
  config?: Pick<OcxConfig, "hostname" | "unauthenticatedLoopbackListener" | "codexDesktopAuthless">,
): CodexRoutingTarget {
  const loopback = config?.unauthenticatedLoopbackListener;
  const effectivePort = loopback?.enabled ? loopback.port : port;
  const hostname = loopback?.enabled ? undefined : config?.hostname;
  const requiresAdmissionToken = loopback?.enabled ? false : shouldInjectApiAuthHeader(config);
  return {
    baseUrl: `http://${providerBaseHost(hostname)}:${effectivePort}/v1`,
    requiresAdmissionToken,
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    ...(config?.codexDesktopAuthless === true && !requiresAdmissionToken
      ? { desktopAuthless: true }
      : {}),
  };
}

function routingTargetOrigin(target: CodexRoutingTarget): string {
  return target.baseUrl.slice(0, -3);
}

function configuredManagedSubagentDefaults(
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
/**
 * True only for hostnames that bind loopback ONLY. Wildcard binds ("0.0.0.0", "::") are NOT
 * loopback: they expose the proxy on every interface and therefore require the admission token.
 * Do not use `providerBaseHost` for this decision — it folds wildcards to 127.0.0.1 because it
 * answers "what address do I dial", which is a different question from "is this exposed".
 */
export function isLoopbackHostname(hostname: string | undefined): boolean {
  const normalized = (hostname ?? "127.0.0.1").trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

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

export function shouldInjectApiAuthHeader(
  config: Pick<OcxConfig, "hostname" | "unauthenticatedLoopbackListener"> | undefined,
): boolean {
  // The unauthenticated loopback listener is a loopback bind, so it admits without a
  // credential (#1102). Emitting the env header anyway would be worse than useless: the
  // directly-spawned app-server this exists for has no OPENCODEX_API_AUTH_TOKEN in its
  // environment, and Codex would send an empty header value.
  if (config?.unauthenticatedLoopbackListener?.enabled) return false;
  return !isLoopbackHostname(config?.hostname);
}

export function buildProviderTableBlock(
  port: number,
  supportsWebsockets?: boolean,
  includeApiAuthHeader?: boolean,
  hostname?: string,
): string;
export function buildProviderTableBlock(
  target: CodexRoutingTarget,
  supportsWebsockets?: boolean,
): string;
export function buildProviderTableBlock(
  portOrTarget: number | CodexRoutingTarget,
  supportsWebsockets = false,
  includeApiAuthHeader = false,
  hostname?: string,
): string {
  const target = typeof portOrTarget === "number"
    ? validateCodexRoutingTarget({
        baseUrl: `http://${providerBaseHost(hostname)}:${portOrTarget}/v1`,
        requiresAdmissionToken: includeApiAuthHeader,
        tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
      })
    : validateCodexRoutingTarget(portOrTarget);
  return buildProviderTableBlockForTarget(target, supportsWebsockets);
}

function buildProviderTableBlockForTarget(
  target: CodexRoutingTarget,
  supportsWebsockets = false,
): string {
  const lines = [
    "",
    OCX_SECTION_MARKER,
    "[model_providers.opencodex]",
    'name = "OpenCodex Proxy"',
    `base_url = ${tomlString(target.baseUrl)}`,
    'wire_api = "responses"',
    // false only in the authless Desktop opt-in (#1107); true keeps the App/TUI account gate.
    `requires_openai_auth = ${target.desktopAuthless === true ? "false" : "true"}`,
  ];
  if (target.requiresAdmissionToken) {
    // codex-cli 0.146+ contract (#2073): env_key sends Authorization: Bearer $VAR and
    // hard-errors on a missing/empty variable instead of silently omitting auth. It
    // coexists with requires_openai_auth (env_key wins wire auth; the flag keeps the
    // login/account UX), and the server substitutes stored main auth for our admission
    // bearer (#1686), so the modern form is strictly better than the legacy
    // env_http_headers table this line used to emit.
    lines.push(`env_key = ${tomlString(target.tokenEnv)}`);
  }
  if (supportsWebsockets) lines.push("supports_websockets = true");
  return lines.join("\n") + "\n";
}

export function buildOpenaiBaseUrlLine(
  port: number,
  hostname?: string,
): string;
export function buildOpenaiBaseUrlLine(target: CodexRoutingTarget): string;
export function buildOpenaiBaseUrlLine(
  portOrTarget: number | CodexRoutingTarget,
  hostname?: string,
): string {
  return typeof portOrTarget === "number"
    ? `openai_base_url = "http://${providerBaseHost(hostname)}:${portOrTarget}/v1"`
    : buildOpenaiBaseUrlLineForTarget(validateCodexRoutingTarget(portOrTarget));
}

function buildOpenaiBaseUrlLineForTarget(target: CodexRoutingTarget): string {
  return `openai_base_url = ${tomlString(target.baseUrl)}`;
}

/**
 * Realtime sideband override (codex-rs `experimental_realtime_ws_base_url`), written with the
 * SAME value as `openai_base_url`. Desktop voice creates its WebRTC call through the proxy
 * (`POST /v1/live`, answered under the Pool account the proxy selects) but, since openai/codex
 * 438c9e98d (#35830), joins the sideband at `wss://api.openai.com/v1/live/{callId}` with the
 * app's own login unless this key redirects it. Two accounts, one call: the join 404s. Pointing
 * the key at the proxy sends the join through `GET /v1/live/{callId}` (src/server/live.ts),
 * where the same Pool account is reused. codex-rs turns `http` into `ws` and appends
 * `/live/{callId}` itself; the value must stay the canonical `/v1` root.
 */
export function buildRealtimeWsBaseUrlLine(target: CodexRoutingTarget): string {
  return `${REALTIME_WS_BASE_URL_KEY} = ${tomlString(target.baseUrl)}`;
}

/**
 * Design B root-key injection: place `OCX_SECTION_MARKER` + `openai_base_url` at the document
 * ROOT (before the first table header). Idempotent: an existing marker-owned line is rewritten
 * in place. A user's OWN root `openai_base_url` (no marker above it) is respected — we keep it
 * and inject nothing, reporting `keptUserBaseUrl` so the caller can surface it.
 */
export function setRootOpenaiBaseUrl(
  content: string,
  port: number,
  hostname?: string,
): { content: string; keptUserBaseUrl: boolean };
export function setRootOpenaiBaseUrl(
  content: string,
  target: CodexRoutingTarget,
): { content: string; keptUserBaseUrl: boolean };
export function setRootOpenaiBaseUrl(
  content: string,
  portOrTarget: number | CodexRoutingTarget,
  hostname?: string,
): { content: string; keptUserBaseUrl: boolean } {
  if (typeof portOrTarget !== "number") {
    return setRootOpenaiBaseUrlForTarget(content, validateCodexRoutingTarget(portOrTarget));
  }
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const key = buildOpenaiBaseUrlLine(portOrTarget, hostname);

  for (let i = 0; i < rootEnd; i++) {
    if (!isRootOpenaiBaseUrlLine(lines[i])) continue;
    const markerOwned = i > 0 && lines[i - 1].includes(OCX_SECTION_MARKER);
    if (!markerOwned) return { content, keptUserBaseUrl: true };
    lines[i] = key;
    return { content: lines.join("\n"), keptUserBaseUrl: false };
  }

  if (firstTable === -1) {
    return {
      content:
        content.replace(/\n+$/, "") +
        "\n" +
        OCX_SECTION_MARKER +
        "\n" +
        key +
        "\n",
      keptUserBaseUrl: false,
    };
  }
  let insertAt = firstTable;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, OCX_SECTION_MARKER, key);
  return { content: lines.join("\n"), keptUserBaseUrl: false };
}

function setRootOpenaiBaseUrlForTarget(
  content: string,
  target: CodexRoutingTarget,
): { content: string; keptUserBaseUrl: boolean } {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const key = buildOpenaiBaseUrlLineForTarget(target);
  for (let index = 0; index < rootEnd; index += 1) {
    if (!isRootOpenaiBaseUrlLine(lines[index])) continue;
    const markerOwned = index > 0 && lines[index - 1].includes(OCX_SECTION_MARKER);
    if (!markerOwned) return { content, keptUserBaseUrl: true };
    lines[index] = key;
    return { content: lines.join("\n"), keptUserBaseUrl: false };
  }
  if (firstTable === -1) {
    return {
      content: `${content.replace(/\n+$/, "")}\n${OCX_SECTION_MARKER}\n${key}\n`,
      keptUserBaseUrl: false,
    };
  }
  let insertAt = firstTable;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt -= 1;
  lines.splice(insertAt, 0, OCX_SECTION_MARKER, key);
  return { content: lines.join("\n"), keptUserBaseUrl: false };
}

/**
 * Companion to `setRootOpenaiBaseUrlForTarget` for the realtime sideband override. Same
 * ownership rule, applied per key: the line is ours only when the marker sits directly
 * above it; a user's own line (no marker above it) is kept and nothing is injected. The
 * key gets its OWN marker line rather than sharing the routing override's, so a user line
 * that happens to sit right under our `openai_base_url` is never mistaken for ours.
 * Placement: directly after the marker-owned `openai_base_url` pair. Only ever called on
 * the Design B (loopback) path right after the routing override was written — the legacy
 * provider-table form needs the admission-token header, which the sideband cannot carry.
 */
export function setRootRealtimeWsBaseUrl(
  content: string,
  target: CodexRoutingTarget,
): { content: string; keptUserRealtimeWsBaseUrl: boolean } {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const key = buildRealtimeWsBaseUrlLine(validateCodexRoutingTarget(target));
  for (let index = 0; index < rootEnd; index += 1) {
    if (!isRootRealtimeWsBaseUrlLine(lines[index])) continue;
    const markerOwned = index > 0 && lines[index - 1].includes(OCX_SECTION_MARKER);
    if (!markerOwned) return { content, keptUserRealtimeWsBaseUrl: true };
    lines[index] = key;
    return { content: lines.join("\n"), keptUserRealtimeWsBaseUrl: false };
  }
  for (let index = 0; index < rootEnd; index += 1) {
    if (!isRootOpenaiBaseUrlLine(lines[index])) continue;
    if (!(index > 0 && lines[index - 1].includes(OCX_SECTION_MARKER))) continue;
    lines.splice(index + 1, 0, OCX_SECTION_MARKER, key);
    return { content: lines.join("\n"), keptUserRealtimeWsBaseUrl: false };
  }
  // No marker-owned routing override to attach to: the override has no owner, so inject nothing.
  return { content, keptUserRealtimeWsBaseUrl: false };
}

/**
 * Remove the marker-owned root `openai_base_url` (marker line + the key line right after it).
 * A user's own root override (no marker) survives; an orphaned marker with no key line after
 * it is dropped too so repeated strip/inject cycles cannot accumulate marker comments.
 * A marker-owned `experimental_realtime_ws_base_url` pair is removed by the same rule.
 */
export function stripInjectedOpenaiBaseUrl(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const drop = new Set<number>();
  for (let i = 0; i < rootEnd; i++) {
    if (!lines[i].includes(OCX_SECTION_MARKER)) continue;
    if (i + 1 < rootEnd && (isRootOpenaiBaseUrlLine(lines[i + 1]) || isRootRealtimeWsBaseUrlLine(lines[i + 1]))) {
      drop.add(i);
      drop.add(i + 1);
    } else if (i + 1 >= rootEnd || lines[i + 1].trim() === "") {
      drop.add(i); // orphaned marker at root
    }
  }
  if (drop.size === 0) return content;
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}

export type CodexRoutingKind =
  "native" | "opencodex-local" | "custom-local" | "custom-remote" | "unknown";

type RoutingEndpointKind = "local" | "remote" | "unknown";

function ipv4Octets(hostname: string): number[] | null {
  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (dotted) {
    const octets = dotted.slice(1).map(Number);
    return octets.some((octet) => octet > 255) ? null : octets;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(hostname);
  if (!mapped) return null;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff];
}

function classifyRoutingEndpoint(value: string): RoutingEndpointKind {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "unknown";
    const hostname = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
    if (!hostname) return "unknown";
    if (hostname === "localhost" || hostname.endsWith(".localhost"))
      return "local";
    if (hostname === "::" || hostname === "::1" || hostname === "0.0.0.0")
      return "local";
    const octets = ipv4Octets(hostname);
    if (octets) {
      if (octets.every((octet) => octet === 0)) return "local";
      if (octets[0] === 127) return "local";
      return "remote";
    }
    if (/^::ffff:/i.test(hostname)) return "unknown";
    return "remote";
  } catch {
    return "unknown";
  }
}

/** Classify actual routing dependency separately from opencodex ownership. */
export function classifyCodexRouting(content: string): CodexRoutingKind {
  const rootBaseUrl = rootTomlString(content, "openai_base_url");
  if (rootBaseUrl) {
    const endpoint = classifyRoutingEndpoint(rootBaseUrl);
    if (endpoint === "unknown") return "unknown";
    if (hasInjectedOpenaiBaseUrl(content)) return "opencodex-local";
    return endpoint === "local" ? "custom-local" : "custom-remote";
  }
  const rootProvider = rootTomlString(content, "model_provider");
  if (rootProvider) {
    const providerTableExists =
      providerTableStart(content.split("\n"), rootProvider) !== -1;
    const providerBaseUrl = providerTableString(
      content,
      rootProvider,
      "base_url",
    );
    if (providerBaseUrl) {
      const endpoint = classifyRoutingEndpoint(providerBaseUrl);
      if (endpoint === "unknown") return "unknown";
      if (rootProvider === "opencodex") return "opencodex-local";
      return endpoint === "local" ? "custom-local" : "custom-remote";
    }
    if (
      rootProvider === "opencodex" ||
      providerTableExists ||
      rootProvider !== "openai"
    )
      return "unknown";
  }
  return "native";
}

/** Read-only probe used by status, doctor, and the dashboard. */
export function isCodexRoutingInjected(): boolean {
  const path = CODEX_CONFIG_PATH;
  if (!existsSync(path)) return false;
  try {
    return hasInjectedCodexRouting(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

export function getCodexRoutingKind(): CodexRoutingKind {
  const path = CODEX_CONFIG_PATH;
  if (!existsSync(path)) return "native";
  try {
    return classifyCodexRouting(readFileSync(path, "utf8"));
  } catch {
    return "unknown";
  }
}

/**
 * Strip every existing `model_provider` line that we must not duplicate: any line set to
 * "opencodex" (wherever it sits — including a previously mis-nested one under a table), plus any
 * ROOT-level model_provider (before the first table) of any value, since we override the global.
 * A `model_provider` legitimately inside a user table/profile with a non-opencodex value is left
 * untouched.
 */
function stripExistingModelProvider(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (/^\s*model_provider\s*=/.test(line)) {
      const isOurs = /^\s*model_provider\s*=\s*"opencodex"\s*$/.test(line);
      const isRoot = firstTable === -1 || i < firstTable;
      if (isOurs || isRoot) return; // drop it
    }
    out.push(line);
  });
  return out.join("\n");
}

/**
 * Drop ROOT-level `model_context_window` overrides (keys before the first table header). Codex
 * treats this root key as a global override that wins over the per-model catalog values, so a stale
 * `model_context_window = 1000000` makes every model (e.g. gpt-5.5) report a 1M window. User-owned
 * compaction limits do not alter the advertised context window and must survive reinjection.
 */
export function stripRootContextWindowOverrides(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  return lines
    .filter((line, i) => {
      const isRoot = firstTable === -1 || i < firstTable;
      return !isRoot || !/^\s*model_context_window\s*=/.test(line);
    })
    .join("\n");
}

function stripRootRoutedModel(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  return lines
    .filter((line, i) => {
      const isRoot = firstTable === -1 || i < firstTable;
      if (!isRoot) return true;
      const m = line.match(/^\s*model\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*$/);
      if (!m) return true;
      const model = parseTomlString(m[1]);
      return !model?.includes("/");
    })
    .join("\n");
}

/**
 * Insert `model_provider = "opencodex"` at the document ROOT — immediately before the first table
 * header (TOML root keys must precede all tables). If there are no tables, append it to the root body.
 */
function setRootModelProvider(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const key = 'model_provider = "opencodex"';
  if (firstTable === -1) {
    return content.replace(/\n+$/, "") + "\n" + key + "\n";
  }
  let insertAt = firstTable;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, key);
  return lines.join("\n");
}

function readRootModelCatalogPath(content: string): string | null {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const modelCatalogAssignment = tomlStringPattern("model_catalog_json");
  let ownedCatalogPath: string | null = null;
  for (let index = 0; index < rootEnd; index += 1) {
    const match = modelCatalogAssignment.exec(lines[index]);
    if (!match) continue;
    const catalogPath = parseTomlString(match[1]);
    if (!isOpencodexCatalogPath(catalogPath)) return catalogPath;
    ownedCatalogPath ??= catalogPath;
  }
  return ownedCatalogPath;
}

function setRootModelCatalogPath(content: string, catalogPath: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const key = `model_catalog_json = ${tomlString(catalogPath)}`;
  const modelCatalogAssignment = tomlStringPattern("model_catalog_json");
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const ownedAssignments: number[] = [];
  let hasUserAssignment = false;
  for (let i = 0; i < rootEnd; i++) {
    const m = modelCatalogAssignment.exec(lines[i]);
    if (!m) continue;
    const existing = parseTomlString(m[1]);
    if (isOpencodexCatalogPath(existing)) {
      ownedAssignments.push(i);
    } else {
      hasUserAssignment = true;
    }
  }
  if (hasUserAssignment) {
    const owned = new Set(ownedAssignments);
    return lines.filter((_, index) => !owned.has(index)).join("\n");
  }
  if (ownedAssignments.length > 0) {
    lines[ownedAssignments[0]] = key;
    const duplicates = new Set(ownedAssignments.slice(1));
    return lines.filter((_, index) => !duplicates.has(index)).join("\n");
  }
  if (firstTable === -1) {
    return content.replace(/\n+$/, "") + "\n" + key + "\n";
  }
  let insertAt = firstTable;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, key);
  return lines.join("\n");
}

function removeProfileSection(content: string): string {
  const lines = content.split("\n");
  const filtered: string[] = [];
  let inProfile = false;
  for (const line of lines) {
    if (line.trim() === "[profiles.opencodex]") {
      inProfile = true;
      continue;
    }
    if (inProfile) {
      if (/^\s*\[/.test(line) && line.trim() !== "[profiles.opencodex]") {
        inProfile = false;
        filtered.push(line);
      }
      continue;
    }
    filtered.push(line);
  }
  return (
    filtered
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

function normalizeServiceTier(content: string): string {
  return content.replace(
    /^(\s*service_tier\s*=\s*)["']priority["']\s*$/gm,
    '$1"fast"',
  );
}

function ensureFastModeFeature(content: string, fastMode?: boolean): string {
  // Tri-state fast mode (see OcxConfig.fastMode): true forces `fast_mode = true`,
  // false forces `fast_mode = false`, and undefined leaves the user's config
  // untouched (no [features] table is added and an existing fast_mode line is
  // preserved as-is). Table and key matching accept the valid TOML spellings
  // `[features] # comment`, `["features"]` / `['features']`, and quoted keys.
  const lines = content.split("\n");
  const featuresHeader = /^\s*\[(["']?)\s*features\s*\1\]\s*(?:#.*)?$/;
  const fastModeKey = /^\s*(?:"fast_mode"|'fast_mode'|fast_mode)\s*=/;
  const featuresStart = lines.findIndex(line => featuresHeader.test(line));
  if (featuresStart === -1) {
    if (fastMode === undefined) return content;
    return content.trimEnd() + "\n\n[features]\nfast_mode = " + (fastMode ? "true" : "false") + "\n";
  }

  const nextTable = lines.findIndex(
    (line, index) => index > featuresStart && /^\s*\[/.test(line),
  );
  const featuresEnd = nextTable === -1 ? lines.length : nextTable;
  for (let i = featuresStart + 1; i < featuresEnd; i++) {
    if (fastModeKey.test(lines[i])) {
      if (fastMode === undefined) return lines.join("\n");
      lines[i] = lines[i].replace(/^(\s*)(?:"fast_mode"|'fast_mode'|fast_mode)\s*=.*$/, `$1fast_mode = ${fastMode ? "true" : "false"}`);
      return lines.join("\n");
    }
  }

  if (fastMode === undefined) return lines.join("\n");
  let insertAt = featuresEnd;
  while (insertAt > featuresStart + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, `fast_mode = ${fastMode ? "true" : "false"}`);
  return lines.join("\n");
}

function isOpencodexCatalogPath(path: string): boolean {
  return path.replace(/\\/g, "/").split("/").pop() === "opencodex-catalog.json";
}

function stripOpencodexCatalogPath(content: string): string {
  const modelCatalogAssignment = tomlStringPattern("model_catalog_json");
  const lines = content.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  return lines
    .filter((line, index) => {
      if (index >= rootEnd) return true;
      const m = modelCatalogAssignment.exec(line);
      return !m || !isOpencodexCatalogPath(parseTomlString(m[1]));
    })
    .join("\n");
}

export function buildProfileFile(port: number, catalogPath?: string | null, supportsWebsockets?: boolean, includeApiAuthHeader?: boolean, hostname?: string, fastMode?: boolean): string;
export function buildProfileFile(target: CodexRoutingTarget, catalogPath?: string | null, supportsWebsockets?: boolean, fastMode?: boolean): string;
export function buildProfileFile(
  portOrTarget: number | CodexRoutingTarget,
  catalogPath?: string | null,
  supportsWebsockets = false,
  includeApiAuthHeaderOrFastMode?: boolean,
  hostname?: string,
  fastMode?: boolean,
): string {
  const target = typeof portOrTarget === "number"
    ? validateCodexRoutingTarget({
        baseUrl: `http://${providerBaseHost(hostname)}:${portOrTarget}/v1`,
        requiresAdmissionToken: includeApiAuthHeaderOrFastMode === true,
        tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
      })
    : validateCodexRoutingTarget(portOrTarget);
  return buildProfileFileForTarget(
    target,
    catalogPath,
    supportsWebsockets,
    typeof portOrTarget === "number" ? fastMode : includeApiAuthHeaderOrFastMode,
  );
}

function buildProfileFileForTarget(
  target: CodexRoutingTarget,
  catalogPath?: string | null,
  supportsWebsockets = false,
  fastMode?: boolean,
): string {
  const origin = routingTargetOrigin(target);
  const host = new URL(origin).host;
  // Design B (loopback): the reference/fallback file documents the root override form.
  // Non-loopback keeps the legacy provider-table shape (built-in provider cannot carry
  // the x-opencodex-api-key env header); the authless Desktop opt-in shares that shape.
  if (!usesProviderTable(target)) {
    const lines = [
      "# OpenCodex proxy fallback config (Design B)",
      `# Root override that points Codex's built-in openai provider at the proxy on ${host}.`,
      "# Merge these root keys into ~/.codex/config.toml manually if auto-injection was removed.",
      buildOpenaiBaseUrlLineForTarget(target),
    ];
    if (catalogPath) lines.push(`model_catalog_json = ${tomlString(catalogPath)}`);
    if (fastMode !== undefined) lines.push("", "[features]", `fast_mode = ${fastMode ? "true" : "false"}`, "");
    return lines.join("\n");
  }
  const lines = [
    "# OpenCodex proxy profile — use with: codex --profile opencodex",
    `# Routes all model requests through the opencodex proxy at ${host}`,
    'model_provider = "opencodex"',
  ];
  if (catalogPath) lines.push(`model_catalog_json = ${tomlString(catalogPath)}`);
  if (fastMode !== undefined) lines.push("", "[features]", `fast_mode = ${fastMode ? "true" : "false"}`);
  lines.push(buildProviderTableBlockForTarget(target, supportsWebsockets).trimEnd(), "");
  return lines.join("\n");
}

export function chooseCatalogPathForInjection(
  content: string,
  requested?: string | null,
): string | null {
  if (requested !== undefined) return requested;

  const existing = readRootModelCatalogPath(content);
  if (existing) {
    const resolved = resolveCodexConfigPath(existing);
    if (!isOpencodexCatalogPath(resolved) || existsSync(resolved))
      return existing;
  }

  return existsSync(DEFAULT_CATALOG_PATH) ? DEFAULT_CATALOG_PATH : null;
}

export interface CodexInjectResult {
  success: boolean;
  message: string;
  status?: "skipped";
  skippedReason?: "desired_disabled" | "desired_enabled";
  nativeSubagentDefaultsWarning?: string;
}

export async function injectCodexConfig(
  port: number,
  config?: OcxConfig,
  options: InjectCodexOptions = {},
): Promise<CodexInjectResult> {
  // Point Codex at the unauthenticated loopback listener when it is enabled (#1102).
  //
  // Resolved here rather than at the call sites because every caller already passes the proxy
  // port and the config together: startup sync, `ocx sync`, and the ensure path would each
  // need the same two-line change, and a caller that missed it would silently emit a base_url
  // requiring a credential the directly-spawned app-server does not have.
  //
  // The listener port is fixed in config, never OS-assigned, so this value survives restarts
  // and matches what an already-running app-server read at startup.
  let routingTarget: CodexRoutingTarget;
  try {
    routingTarget = options.routingTarget
      ? validateCodexRoutingTarget(options.routingTarget)
      : standaloneCodexRoutingTarget(port, config);
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Invalid Codex routing target" };
  }
  if (!existsSync(CODEX_CONFIG_PATH)) {
    return {
      success: false,
      message: `Codex config not found at ${CODEX_CONFIG_PATH}. Is Codex installed?`,
    };
  }

  const rawContent = readFileSync(CODEX_CONFIG_PATH, "utf-8");
  const activeProvider = externalCodexModelProvider(rawContent);
  if (activeProvider) {
    // A launcher may have journaled before the provider manager took ownership. Never let shutdown
    // replay that stale snapshot over externally managed config.
    if (!options.validateOnly) removeJournal();
    const nativeSubagentDefaultsWarning = configuredManagedSubagentDefaults(
      config,
    )
      ? `Native Codex sub-agent defaults were not injected: external model_provider ${tomlString(activeProvider)} owns config.toml.`
      : undefined;
    return {
      success: true,
      ...(nativeSubagentDefaultsWarning
        ? { nativeSubagentDefaultsWarning }
        : {}),
      message:
        `⚠️ Codex routing NOT injected: config.toml selects the external model_provider ${tomlString(activeProvider)}.\n` +
        `  OpenCodex preserves external provider configuration so existing ${tomlString(activeProvider)} session history stays visible.\n` +
        `  Configure that provider for Responses passthrough at ${routingTarget.baseUrl}` +
        `${routingTarget.requiresAdmissionToken ? ` with x-opencodex-api-key from ${routingTarget.tokenEnv}` : ""}.\n` +
        `  For direct injection, switch to the built-in openai provider, remove any user-owned root openai_base_url, and rerun 'ocx start'.`,
    };
  }

  // Marker-owned native defaults are OpenCodex residue, never part of the
  // user's journal baseline. Clean them before either snapshotting or adding a
  // root routing key: inserting that key ahead of a marker-owned first table
  // would otherwise separate the table marker from its header. Ambiguous
  // markers fail closed without writing config, profile, or journal state.
  const nativeDefaultsBaseline = transformManagedSubagentDefaults(
    rawContent,
    null,
  );
  if (!nativeDefaultsBaseline.ok) {
    return {
      success: false,
      message:
        `Codex config injection refused: existing OpenCodex-managed native sub-agent defaults are ambiguous: ${nativeDefaultsBaseline.error}. ` +
        `No files were changed; inspect ${CODEX_CONFIG_PATH}.`,
    };
  }
  const baselineContent = nativeDefaultsBaseline.content;

  /*
   * The journal write used to happen HERE, before the transforms. It now happens
   * inside the write lock further down, and the transforms were hoisted above it
   * rather than the lock being narrowed to the three file writes.
   *
   * Why: the lock's witness hashes the CANDIDATE BYTES, and those are not final
   * until `profileContent` and the EOL-applied `content` exist. Opening the lock
   * before them would leave nothing to hash; keeping the journal outside the
   * lock would leave the first artifact-creating write unserialized, which is
   * the hole this edge exists to close.
   *
   * The move is safe because the region between here and the writes performs no
   * filesystem mutation — its only touch is `existsSync` on the catalog paths
   * (`chooseCatalogPathForInjection`) — and because `writeJournal` is called
   * with `configContent`, so it snapshots the baseline it is handed rather than
   * rereading `config.toml` underneath the transforms.
   */
  // EOL boundary: transforms below are LF-pure; preserve the file's dominant ending on write.
  const eol = dominantEol(rawContent);
  let content = applyEol(baselineContent, "\n");

  // Idempotent clean-up of any prior injection: drop the provider table (marker-based) and every
  // stray/mis-nested model_provider line, so re-injecting can't duplicate keys or leave the buggy
  // table-nested key behind.
  // Design B form FIRST: removeOcxSection also keys on the marker line, so a root-level
  // marker + openai_base_url pair must be gone before it scans or it would swallow root keys.
  content = stripInjectedOpenaiBaseUrl(content);
  // #1798: after a Codex app rewrite the markers are gone but the values we recorded writing
  // are still ours. Consume them by value here, BEFORE the routing form is chosen, so a
  // Design B -> provider-table transition (hostname change, authless opt-in) cannot leave our
  // own root URLs behind as if they were the user's, and so re-inject never journals them as
  // not-ours (which would make them unrestorable).
  content = stripJournaledOpenaiBaseUrl(
    content,
    journaledInjectedOpenaiBaseUrl(),
    journaledInjectedRealtimeWsBaseUrl(),
  );
  if (hasOcxProviderTable(content)) {
    content = removeOcxSection(content);
  }
  content = removeProfileSection(content);
  content = stripExistingModelProvider(content);
  content = stripRootContextWindowOverrides(content);
  content = normalizeServiceTier(content);
  content = ensureFastModeFeature(content, config?.fastMode);

  const catalogPath = chooseCatalogPathForInjection(
    content,
    options.catalogPath,
  );
  content = catalogPath
    ? setRootModelCatalogPath(content, catalogPath)
    : stripOpencodexCatalogPath(content);

  // Provider-table form: non-loopback admission (legacy) or the authless Desktop opt-in (#1107).
  const legacyMode = usesProviderTable(routingTarget);
  let keptUserBaseUrl = false;
  let keptUserRealtimeWsBaseUrl = false;
  if (legacyMode) {
    // Legacy (non-loopback) injection: the built-in openai provider cannot carry the
    // x-opencodex-api-key env header, so keep the opencodex provider table + root re-tag.
    // The authless opt-in needs the same table because only a dedicated provider can carry
    // requires_openai_auth = false.
    // 1) Root key BEFORE the first table header (must be a global, not nested under a table).
    content = setRootModelProvider(content);
    // 2) Provider table appended at EOF (position-independent).
    content =
      content.trimEnd() +
      "\n" +
      buildProviderTableBlockForTarget(routingTarget, websocketsEnabled(config ?? {}));
  } else {
    // Design B (loopback): a single root override; codex keeps its native `openai` provider id
    // so thread history is never remapped. Any legacy form was already stripped above.
    content = stripInjectedOpenaiBaseUrl(content); // normalize before idempotent re-insert
    const result = setRootOpenaiBaseUrlForTarget(content, routingTarget);
    content = result.content;
    keptUserBaseUrl = result.keptUserBaseUrl;
    // Voice sideband override rides on the routing override: same value, same ownership rule,
    // and never when the user owns the routing line (we inject nothing in that case).
    if (!keptUserBaseUrl) {
      const realtime = setRootRealtimeWsBaseUrl(content, routingTarget);
      content = realtime.content;
      keptUserRealtimeWsBaseUrl = realtime.keptUserRealtimeWsBaseUrl;
    }
  }

  const desiredSubagentDefaults = configuredManagedSubagentDefaults(config);
  const routingOwnershipWarning =
    keptUserBaseUrl && desiredSubagentDefaults
      ? "Native Codex sub-agent defaults were not injected: a user-owned root openai_base_url prevents OpenCodex from managing active Codex routing."
      : undefined;
  const managedDefaults = transformManagedSubagentDefaults(
    content,
    keptUserBaseUrl ? null : desiredSubagentDefaults,
  );
  let nativeSubagentDefaultsWarning = routingOwnershipWarning;
  let managedDefaultsMessage = routingOwnershipWarning
    ? `  ⚠️ ${routingOwnershipWarning}\n`
    : "";
  if (managedDefaults.ok) {
    content = managedDefaults.content;
    if (desiredSubagentDefaults && managedDefaults.conflicts.length > 0) {
      const keys = managedDefaults.conflicts
        .map((conflict) => `agents.${conflict.key}`)
        .join(", ");
      nativeSubagentDefaultsWarning = `Native Codex sub-agent defaults were not injected: user-owned ${keys} preserved.`;
      managedDefaultsMessage = `  ⚠️ ${nativeSubagentDefaultsWarning}\n`;
    }
  } else {
    const action =
      desiredSubagentDefaults && !keptUserBaseUrl
        ? "were not injected"
        : "could not be safely removed";
    nativeSubagentDefaultsWarning = `Native Codex sub-agent defaults ${action}: ${managedDefaults.error}.`;
    managedDefaultsMessage = `  ⚠️ ${nativeSubagentDefaultsWarning}\n`;
  }

  const profileContent = buildProfileFileForTarget(
    routingTarget,
    catalogPath,
    websocketsEnabled(config ?? {}),
    config?.fastMode,
  );
  content = applyEol(content, eol);

  /*
   * The witness, built from the FINAL bytes. Everything it hashes is either the
   * output about to be written or evidence that can be re-read under the lock;
   * ownership rides along as recorded context because it is not re-observed
   * there — see `write-coordination.ts`.
   */
  const persisted = readConfigAdmissionSnapshot();
  const persistedIdentity =
    persisted.kind === "read" ? persisted.contentSha256 : "unreadable";
  const observedGeneration = observeConfigGeneration();
  const generation =
    observedGeneration.kind === "ready"
      ? { present: true, value: observedGeneration.generation.value }
      : { present: false, value: 0 };
  const candidate = {
    configBytes: content,
    profileBytes: profileContent,
    catalogPath,
  };
  const witness = buildInjectWitness(
    candidate,
    rawContent,
    persistedIdentity,
    generation,
    "unknown",
  );

  /*
   * THE COORDINATED SECTION.
   *
   * This is the write lock's first production caller. Everything above is
   * classification and pure transformation; everything from here to the end of
   * the callback replaces files, and two processes doing it at once is the
   * interruption hazard this substrate exists to close.
   *
   * The witness hashes the bytes about to be written rather than the inputs that
   * produced them, so two operations intending different output cannot share an
   * id no matter which input differed.
   */
  /*
   * Eligibility BEFORE acquisition, never "try and fall back".
   *
   * A home routed before this substrate existed cannot have its first
   * coordinator row created — the guard that refuses is correct — and that
   * describes every pre-substrate install. Attempting the lock there would enter
   * a refusal path on the entire installed base, so the decision happens first
   * and those homes keep the write sequence they have always used.
   */
  const eligibility = codexWriteCoordinationEligibility({
    coordinatorPath: () =>
      resolveCodexCoordinatorDatabasePath(
        resolveEffectiveUserIdentity(),
        getCodexHome(),
      ),
    residue: () => classifyNativeRoutedResidue(),
    integrationRecord: () => readIntegrationRecord(),
  });
  if (eligibility.kind === "refused") {
    return {
      success: false,
      message: `Codex configuration was not written: ${eligibility.reason}.`,
    };
  }

  if (options.validateOnly) {
    return {
      success: true,
      message: "Codex config injection preflight passed; no files were changed.",
    };
  }

  const applyNativeArtifacts = (): void => {
    // #1798 again: a Codex app rewrite keeps values and drops the ownership comments, so
    // marker evidence alone would classify our own routed config as the user's native
    // baseline and replace the real original snapshot. Value evidence from the journal
    // (the URLs the last injection recorded writing) blocks that misclassification.
    const journaledBaseUrl = journaledInjectedOpenaiBaseUrl();
    const journaledRealtimeWsBaseUrl = journaledInjectedRealtimeWsBaseUrl();
    const looksInjectedByValue =
      (journaledBaseUrl !== null && rootTomlString(rawContent, "openai_base_url") === journaledBaseUrl)
      || (journaledRealtimeWsBaseUrl !== null
        && rootTomlString(rawContent, REALTIME_WS_BASE_URL_KEY) === journaledRealtimeWsBaseUrl);
    writeJournal({
      currentStateIsNative: !hasInjectedCodexRouting(rawContent) && !looksInjectedByValue,
      configContent: baselineContent,
      owner: options.journalOwner,
    });
    atomicWriteFile(CODEX_CONFIG_PATH, content);
    atomicWriteFile(CODEX_PROFILE_PATH, profileContent);
    markJournalInjectedState(content, profileContent, {
      // A root override is ours only in loopback Design B when no user-owned value won.
      injectedOpenaiBaseUrl: legacyMode || keptUserBaseUrl
        ? null
        : rootTomlString(content, "openai_base_url"),
      // The sideband override is ours only when we wrote it this pass (never in legacy mode,
      // never when the user owns either key).
      injectedRealtimeWsBaseUrl: legacyMode || keptUserBaseUrl || keptUserRealtimeWsBaseUrl
        ? null
        : rootTomlString(content, REALTIME_WS_BASE_URL_KEY),
      // This is the catalog artifact selected for this injection, even when config.toml
      // already points at that path and therefore needs no textual rewrite.
      injectedCatalogPath: catalogPath,
    });
  };

  /*
   * Set only on the coordinated path: the generation/txId the transition just
   * committed. The terminal history update CASes against this, so a job that
   * was overtaken cannot overwrite the winner. Stays undefined for a
   * legacy-uncoordinated home, which publishes no transition to resolve.
   */
  let transitionReceipt: { nativeGeneration: number; currentTxId: string } | undefined;

  if (eligibility.kind === "legacy-uncoordinated") {
    // Unchanged behavior for homes the coordinator cannot yet adopt. Stated
    // rather than implied: this is the boundary, and adoption is its own phase.
    if (!shouldSyncCodexOnStart(loadConfig())) {
      return {
        success: true,
        status: "skipped",
        skippedReason: "desired_disabled",
        message: "Codex integration is OFF; no Codex config, catalog, cache, or history was changed.",
      };
    }
    applyNativeArtifacts();
  } else {
    const coordinated = await withCodexWriteLock(
      {
        timeoutMs: options.lockTimeoutMs ?? DEFAULT_INJECT_LOCK_TIMEOUT_MS,
        ...(eligibility.kind === "adopt" ? { adoption: { direction: "apply" as const } } : {}),
        admitted: { authoritySnapshotId: witness.comparisonId },
        readAdmissionUnderLock: () => ({
          authoritySnapshotId: recomputeInjectWitness({
            candidate: witness.candidate,
            canonicalTargets: witness.evidence.canonicalTargets,
            persistedIdentity,
            generation,
            observedOwnership: witness.observedOwnership,
          }).comparisonId,
        }),
      },
      (ctx) => {
        if (!shouldSyncCodexOnStart(loadConfig())) {
          throw new CodexWriteLockSkipped("desired_disabled");
        }
        /*
         * Publish BEFORE touching the filesystem. `assertPublished` runs after this
         * callback returns and throws unless a transition was recorded, so writing
         * first would replace every file and only then fail — with SQLite rolling
         * back and the filesystem staying changed.
         *
         * `beginTransition` returns a conflict rather than throwing, so its result
         * is checked here; ignoring it would reach the same failure by a slower
         * route.
         */
        const published = ctx.coordinator.beginTransition(
          {
            nativeGeneration: ctx.expectation.nativeBefore,
            currentTxId: ctx.currentTxId,
          },
          {
            txId: ctx.expectation.txId,
            direction: "apply",
            authoritySnapshotId: ctx.admission.authoritySnapshotId,
            nextRetryAt: new Date().toISOString(),
          },
        );
        if (published.kind !== "updated") {
          throw new CodexWriteConflictError(
            `The Codex transition could not be published: ${published.kind}.`,
          );
        }

        /*
         * Exact pre-images, captured under the lock and used for compensation.
         *
         * A rolled-back coordinator row is not a rolled-back filesystem: each
         * `atomicWriteFile` is atomic alone, never across the three together, so a
         * failure partway leaves earlier replacements in place. `restoreJournalState`
         * cannot be the undo — it restores whichever journal occupies the path,
         * which need not be the one this operation wrote.
         */
        const preImages = captureCodexPreImages();
        try {
          applyNativeArtifacts();
        } catch (error) {
          // Compensate, then ALWAYS throw. Returning a partial result would let the
          // lock commit a row describing an apply that did not finish.
          const restored = restoreCodexPreImages(preImages);
          if (!restored.complete) {
            throw new CodexPartialWriteError(restored.unrestored);
          }
          throw error;
        }
        return {
          kind: "applied" as const,
          preImages,
          /*
           * The receipt the terminal update matches on. The transition commits
           * when the callback returns, so this pair is what the post-job
           * `updateCodexHistoryTransition` CASes against — an overtaken job
           * cannot overwrite a winner.
           */
          receipt: {
            nativeGeneration: ctx.expectation.nativeAfter,
            currentTxId: ctx.expectation.txId,
          },
        };
      },
    );

    if (coordinated.status !== "acquired") {
      return codexInjectLockOutcome(coordinated);
    }
    recordCodexNativeTransactionProvenance(
      coordinated.value.preImages,
      coordinated.value.receipt.currentTxId,
    );
    transitionReceipt = coordinated.value.receipt;
  }
  // Legacy mode still forward-tags history so re-tagged threads stay listable. Design B needs
  // the opposite: a one-time migration of previously re-tagged threads BACK to openai (restore
  // machinery; cheap no-op when there is nothing to migrate).
  // History runs in a Worker under H, not on this thread.
  //
  // The three surfaces it touches — the SQLite rows, the backup manifest, and the
  // rollout files — do not share a transaction, so a busy timeout only ever
  // serialized one of them and an opposite-direction process could overtake
  // through the other two. The operation is derived from admitted intent here and
  // handed down fixed; the Worker never takes a direction from its caller.
  const historyOutcome = await runCodexHistoryJob({
    ...resolveCodexHistoryJobTarget(),
    expectedDesiredEnabled: true,
    operation: deriveCodexHistoryOperation({
      direction: "apply",
      resumeHistory: config?.syncResumeHistory !== false,
      legacyMode,
    }),
  });
  // A blocked or failed unit is reported, not silently counted as zero work:
  // `failed` is what makes the caller's message say so.
  const history: { rows: number; files: number; failed?: true } =
    historyOutcome.kind === "converged"
      ? { rows: historyOutcome.rows, files: historyOutcome.files }
      : historyOutcome.kind === "skipped"
        ? { rows: 0, files: 0 }
        : { rows: 0, files: 0, failed: true };

  /*
   * Resolve the transition this job belongs to, on the coordinated path only.
   *
   * `updateCodexHistoryTransition` had no production caller since it was
   * written, so every completed or skipped job left the row permanently
   * `pending` — the transition was published and never resolved. This is the
   * first time the durable row reflects what actually happened. The CAS on the
   * receipt means an overtaken job's late write loses and is not overwritten.
   */
  if (transitionReceipt) {
    resolveCodexHistoryTransition(transitionReceipt, historyOutcome);
  }

  const catalogMessage = catalogPath
    ? `  Codex model catalog: ${catalogPath}\n`
    : `  Codex model catalog not injected because no opencodex catalog file exists yet.\n`;
  const ejected = (history as { ejectedRows?: number }).ejectedRows ?? 0;
  const migratedRows = (history.rows ?? 0) + ejected;
  const historyMessage =
    config?.syncResumeHistory === false
      ? `  Codex resume history: left unchanged (syncResumeHistory=false).\n`
      : history.failed
        ? formatApplyHistoryFailure(historyOutcome, legacyMode)
        : legacyMode
          ? `  Codex resume history: ${history.rows} thread(s) made visible for opencodex; originals backed up for restore.\n`
          : migratedRows > 0
            ? `  Codex resume history: restored original provider metadata for ${migratedRows} manifest-backed thread(s) (one-time).\n`
            : `  Codex resume history: no backed-up metadata pending; untracked routed history left unchanged.\n`;
  // A user-owned root openai_base_url means we did NOT install routing — say so honestly
  // instead of claiming the proxy route is active (catalog/fast_mode were still written).
  if (keptUserBaseUrl) {
    return {
      success: true,
      ...(nativeSubagentDefaultsWarning
        ? { nativeSubagentDefaultsWarning }
        : {}),
      message:
        `⚠️ Codex routing NOT injected: your config already sets a root openai_base_url, and opencodex never overwrites a user-owned override.\n` +
        catalogMessage +
        historyMessage +
        managedDefaultsMessage +
        `  To route plain codex through the proxy, remove your openai_base_url line from ~/.codex/config.toml and rerun 'ocx start'.\n` +
        `  Reference config: ${CODEX_PROFILE_PATH}`,
    };
  }
  const headline = routingTarget.desktopAuthless === true
    ? `Injected opencodex as default provider into Codex config (authless Desktop mode: requires_openai_auth = false).\n`
    : legacyMode
      ? `Injected opencodex as default provider into Codex config.\n`
      : `Pointed Codex's built-in openai provider at the opencodex proxy (openai_base_url + realtime sideband override).\n`;
  return {
    success: true,
    ...(nativeSubagentDefaultsWarning ? { nativeSubagentDefaultsWarning } : {}),
    message:
      headline +
      catalogMessage +
      historyMessage +
      managedDefaultsMessage +
      `  All models now route through opencodex proxy (like OpenRouter).\n` +
      `  OpenAI models (gpt-5.5, etc.) are passed through to OpenAI.\n` +
      `  Custom models route to their configured providers.\n` +
      (legacyMode
        ? `  Fallback: codex --profile opencodex (same behavior)`
        : `  Fallback reference: ${CODEX_PROFILE_PATH}`),
  };
}

/**
 * Sub-table headers like `[model_providers.opencodex.env_http_headers]` appear when a Codex app
 * config rewrite re-serializes the provider's inline `env_http_headers` table. They define the
 * same `model_providers.opencodex` provider, so cleanup must remove them too — otherwise the
 * provider survives with no `name` and Codex rejects the whole config
 * ("provider name must not be empty"). The dot terminator keeps a user's
 * `[model_providers.opencodex_backup]`-style tables out of scope.
 */
function isOcxProviderHeaderLine(trimmedLine: string): boolean {
  // Root form matched by regex, not equality: TOML v1.0 allows a trailing comment
  // (`[model_providers.opencodex] # comment`), and an exact compare would miss that form.
  // The sub-table prefix check already tolerates trailing comments by construction.
  return (
    /^\[model_providers\.opencodex\]\s*(?:#.*)?$/.test(trimmedLine) ||
    trimmedLine.startsWith("[model_providers.opencodex.")
  );
}

function hasOcxProviderTable(content: string): boolean {
  return content
    .split("\n")
    .some((line) => isOcxProviderHeaderLine(line.trim()));
}

function removeOcxSection(content: string): string {
  const lines = content.split("\n");
  const filtered: string[] = [];
  let inOcxSection = false;
  for (const line of lines) {
    if (
      line.includes(OCX_SECTION_MARKER) ||
      isOcxProviderHeaderLine(line.trim())
    ) {
      inOcxSection = true;
      continue;
    }
    if (inOcxSection) {
      // End the injected section at the next table header that ISN'T our own. Exact match on the
      // provider name (plus our own sub-tables) so a user's
      // "[model_providers.opencodex_backup]" (or similar) is preserved, not swallowed.
      if (/^\s*\[/.test(line) && !isOcxProviderHeaderLine(line.trim())) {
        inOcxSection = false;
        filtered.push(line);
      }
      continue;
    }
    filtered.push(line);
  }
  return (
    filtered
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

interface StripOpencodexConfigResult {
  content: string;
  managedDefaultsError: string | null;
}

/**
 * Detailed form used by the on-disk restore path. A damaged ownership marker is
 * ambiguous: keep the associated value, but return the transform error so the
 * caller cannot report a complete restore.
 */
function stripOpencodexConfigResult(
  content: string,
  journaledBaseUrl: string | null = null,
  journaledRealtimeWsBaseUrl: string | null = null,
): StripOpencodexConfigResult {
  let out = content;
  const hadRootOcxProvider =
    readRootTomlString(out, "model_provider") === "opencodex";
  // #1798: marker adjacency is FORMATTING evidence, and a Codex app rewrite keeps values
  // while dropping comments. Fall back to VALUE evidence -- the exact URL we recorded
  // writing -- so an app-rewritten config is still recognized as ours.
  const hadInjectedBaseUrl = hasInjectedOpenaiBaseUrl(out)
    || (journaledBaseUrl !== null && rootTomlString(out, "openai_base_url") === journaledBaseUrl);
  out = stripInjectedOpenaiBaseUrl(out); // before removeOcxSection — it keys on the marker line too
  out = stripJournaledOpenaiBaseUrl(out, journaledBaseUrl, journaledRealtimeWsBaseUrl);
  if (hasOcxProviderTable(out)) {
    out = removeOcxSection(out);
  }
  out = removeProfileSection(out);
  // Regex (not exact-string) removal so compact `model_provider="opencodex"` is stripped too —
  // must match the detection regex above, or a detected line could survive un-removed.
  out = out
    .split("\n")
    .filter((l) => !/^\s*model_provider\s*=\s*"opencodex"\s*$/.test(l))
    .join("\n");
  // Routed root model ids (`model = "provider/slug"`) only make sense while the proxy serves
  // them — strip on both the legacy re-tag form and the Design B injected-base-url form.
  if (hadRootOcxProvider || hadInjectedBaseUrl) out = stripRootRoutedModel(out);
  const managedDefaults = transformManagedSubagentDefaults(out, null);
  if (managedDefaults.ok) out = managedDefaults.content;
  out = stripOpencodexCatalogPath(out);
  return {
    content: out.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n",
    managedDefaultsError: !managedDefaults.ok ? managedDefaults.error : null,
  };
}

/** Pure transform: strip the opencodex provider block + `model_provider = "opencodex"` lines. */
export function stripOpencodexConfig(content: string): string {
  return stripOpencodexConfigResult(content).content;
}

function hasOpencodexRouting(content: string): boolean {
  return (
    hasOcxProviderTable(content) ||
    /^\s*model_provider\s*=\s*"opencodex"/m.test(content) ||
    hasInjectedOpenaiBaseUrl(content)
  );
}

export function removeCodexConfig(
  options: { preserveProfile?: boolean } = {},
): { success: boolean; message: string } {
  if (!existsSync(CODEX_CONFIG_PATH)) {
    if (!options.preserveProfile && existsSync(CODEX_PROFILE_PATH))
      unlinkSync(CODEX_PROFILE_PATH);
    return {
      success: true,
      message: `Codex config not found; no native restore was needed${options.preserveProfile ? "." : ", and the opencodex profile was removed if present."}`,
    };
  }
  const rawContent = readFileSync(CODEX_CONFIG_PATH, "utf-8");
  // Same EOL boundary as inject: strip in LF space, write back in the file's own ending.
  // The unchanged fast path compares in LF space so an untouched file is never rewritten.
  const eol = dominantEol(rawContent);
  const content = applyEol(rawContent, "\n");
  // Read the recorded injection once: the strip below consumes it, and so does the
  // ownership verdict, which must agree with what was actually removed.
  const journaledBaseUrl = journaledInjectedOpenaiBaseUrl();
  const journaledRealtimeWsBaseUrl = journaledInjectedRealtimeWsBaseUrl();
  const had = hasOpencodexRouting(content)
    || (journaledBaseUrl !== null && rootTomlString(content, "openai_base_url") === journaledBaseUrl)
    || (journaledRealtimeWsBaseUrl !== null
      && rootTomlString(content, REALTIME_WS_BASE_URL_KEY) === journaledRealtimeWsBaseUrl);
  const stripped = stripOpencodexConfigResult(content, journaledBaseUrl, journaledRealtimeWsBaseUrl);
  if (had || stripped.content !== content) {
    atomicWriteFile(CODEX_CONFIG_PATH, applyEol(stripped.content, eol));
  }
  if (!options.preserveProfile && existsSync(CODEX_PROFILE_PATH))
    unlinkSync(CODEX_PROFILE_PATH);
  const removedMessage = had
    ? `Removed opencodex routing from Codex config${options.preserveProfile ? "." : " + profile."}`
    : "opencodex not present in Codex config.";
  if (stripped.managedDefaultsError) {
    const routingMessage = had
      ? removedMessage
      : "No opencodex routing was present in Codex config.";
    return {
      success: false,
      message:
        `${routingMessage} Native Codex sub-agent defaults could not be safely removed: ${stripped.managedDefaultsError}. ` +
        "The ambiguous marker and adjacent value were preserved; inspect $CODEX_HOME/config.toml before using native Codex.",
    };
  }
  return {
    success: true,
    message: removedMessage,
  };
}

export type CodexRestoreArtifactState = "ok" | "skipped" | "failed";

export interface CodexRestoreConfigResult {
  state: CodexRestoreArtifactState;
  changed: boolean;
  action: "journal-restored" | "owned-fields-stripped" | "external-provider-preserved" | "failed";
  message: string;
}

export interface CodexRestoreCatalogResult {
  state: CodexRestoreArtifactState;
  changed: boolean;
  removed: number;
  kept: number;
  path: string | null;
  message: string;
}

export interface CodexRestoreHistoryResult {
  state: CodexRestoreArtifactState;
  changed: boolean;
  reason?: CodexHistoryFailureReason;
  rows: number;
  files: number;
  ejectedRows: number;
  message: string;
}

export interface CodexNativeRestoreResult {
  success: boolean;
  message: string;
  externalProvider?: string;
  artifacts: {
    config: CodexRestoreConfigResult;
    catalog: CodexRestoreCatalogResult;
    history: CodexRestoreHistoryResult;
  };
}

function failedHistoryRestore(
  reason?: CodexHistoryFailureReason,
  detail?: string,
  progress: { rows?: number; files?: number } = {},
): CodexRestoreHistoryResult {
  const rows = progress.rows ?? 0;
  const files = progress.files ?? 0;
  const changed = rows > 0 || files > 0;
  return {
    state: "failed",
    changed,
    ...(reason ? { reason } : {}),
    rows,
    files,
    ejectedRows: 0,
    message: reason === "permission"
      ? changed
        ? "Codex resume history changed but did NOT converge because permission was denied while finalizing the backup manifest; the manifest was retained for review and safe retry."
        : "Codex resume history could NOT be restored because permission was denied."
      : reason === "busy"
        ? changed
          ? "Codex resume history changed but did NOT converge because backup-manifest finalization remained busy; the manifest was retained for review and safe retry."
          : detail ?? "Codex resume history could NOT be restored — the Codex app appears to be holding the history database."
        : reason === "integrity"
          ? changed
            ? "Codex resume history changed but did NOT converge because the backup or target changed; the manifest was retained for review and safe retry."
            : "Codex resume history could NOT be restored because the backup or restore target failed integrity checks; unverified provider metadata was left unchanged."
        : detail
          ? `Codex resume history could NOT be restored: ${detail}`
          : "Codex resume history could NOT be restored; the reason was not recorded. Run 'ocx doctor'.",
  };
}

/**
 * Restore failure wording for a Worker outcome.
 *
 * Only a genuine busy result blames the Codex app. An unsafe-path refusal, an
 * unavailable coordinator database, a permission denial, or a dead/timed-out
 * worker is a different problem; the old collapse made every one of those read
 * as "the Codex app is holding the database" (issue #1191). `busy` and
 * `permission` keep the restore-specific sentence built by
 * `failedHistoryRestore`; every other reason reuses the single formatter so
 * the two modules cannot drift apart.
 */
export function failedHistoryRestoreFromOutcome(
  outcome: Extract<CodexHistoryJobOutcome, { kind: "blocked" | "failed" }>,
): CodexRestoreHistoryResult {
  if (outcome.kind === "blocked" && outcome.reason === "busy") return failedHistoryRestore("busy");
  if (outcome.kind === "failed" && outcome.historyFailureReason === "busy") {
    return failedHistoryRestore(
      "busy",
      describeHistoryJobFailure(outcome, "restore"),
      { rows: outcome.rows, files: outcome.files },
    );
  }
  if (outcome.kind === "failed" && outcome.historyFailureReason === "permission") {
    return failedHistoryRestore("permission", undefined, { rows: outcome.rows, files: outcome.files });
  }
  if (outcome.kind === "failed" && outcome.historyFailureReason === "integrity") {
    return failedHistoryRestore("integrity", undefined, { rows: outcome.rows, files: outcome.files });
  }
  return failedHistoryRestore(undefined, describeHistoryJobFailure(outcome, "restore"));
}

function externalProviderRestoreResult(activeProvider: string): CodexNativeRestoreResult {
  const message = `External Codex provider ${tomlString(activeProvider)} preserved; no native restore was needed.`;
  return {
    success: true,
    message,
    externalProvider: activeProvider,
    artifacts: {
      config: { state: "skipped", changed: false, action: "external-provider-preserved", message },
      catalog: { state: "skipped", changed: false, removed: 0, kept: 0, path: null, message },
      history: { state: "skipped", changed: false, rows: 0, files: 0, ejectedRows: 0, message },
    },
  };
}

/** A foreign service claim is an authority boundary, including explicit CLI restore. */
function foreignOwnershipRestoreRefusal(message: string): CodexNativeRestoreResult {
  return {
    success: false,
    message: `Codex native restore refused: ${message}`,
    artifacts: {
      config: { state: "skipped", changed: false, action: "failed", message },
      catalog: { state: "skipped", changed: false, removed: 0, kept: 0, path: null, message },
      history: { state: "skipped", changed: false, rows: 0, files: 0, ejectedRows: 0, message },
    },
  };
}

function desiredEnabledRestoreSkip(): CodexNativeRestoreResult {
  const message = "Codex integration was re-enabled; native restore was skipped.";
  return skippedRestoreEnvelope(true, message);
}

/**
 * A schema-complete all-skipped envelope for outcomes decided before any
 * restore machinery runs. Every `restore --json` path must stay shape-stable
 * with `CodexNativeRestoreResult`; consumers never special-case early exits.
 */
export function skippedRestoreEnvelope(success: boolean, message: string): CodexNativeRestoreResult {
  return {
    success,
    message,
    artifacts: {
      config: { state: "skipped", changed: false, action: "owned-fields-stripped", message },
      catalog: { state: "skipped", changed: false, removed: 0, kept: 0, path: null, message },
      history: { state: "skipped", changed: false, rows: 0, files: 0, ejectedRows: 0, message },
    },
  };
}

/** The config/profile half of a native restore, reported as one artifact. */
function restoreCodexConfigInline(): CodexRestoreConfigResult {
  try {
    const journal = restoreJournalState();
    const restored = journal.configRestored
      ? { success: true, message: "Codex config restored from opencodex journal." }
      : removeCodexConfig({ preserveProfile: journal.profileRestored || journal.profileChanged });
    return restored.success
      ? {
          state: "ok",
          changed: journal.configRestored || journal.profileRestored || journal.profileChanged || restored.message.startsWith("Removed"),
          action: journal.configRestored ? "journal-restored" : "owned-fields-stripped",
          message: restored.message,
        }
      : { state: "failed", changed: false, action: "failed", message: restored.message };
  } catch (error) {
    return { state: "failed", changed: false, action: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/** The catalog half, always inside its own K acquisition. */
/**
 * The catalog half, always inside its own K acquisition.
 *
 * `journaledCatalogPath` must be captured by the CALLER, before the config half runs: a
 * successful journal restore deletes the journal, and a config restore can remove
 * `model_catalog_json`. Reading it here would be too late in both cases (#1798).
 */
function restoreCodexCatalogArtifact(
  revalidateDesiredState: boolean,
  journaledCatalogPath: string | null,
): CodexRestoreCatalogResult {
  const owningCodexHome = getCodexHome();
  try {
    const restored = withCatalogWriteSerialization(owningCodexHome, permit =>
      revalidateDesiredState && shouldSyncCodexOnStart(loadConfig())
        ? null
        : restoreCodexCatalogWithPermit(permit, owningCodexHome, journaledCatalogPath));
    return restored.kind === "completed" && restored.value !== null
      ? { state: "ok", changed: restored.value.removed > 0, ...restored.value, message: "Codex catalog restored." }
      : restored.kind === "completed"
        ? {
            state: "skipped", changed: false, removed: 0, kept: 0, path: null,
            message: "Codex integration was re-enabled; native catalog restoration was skipped.",
          }
        : {
            state: "failed", changed: false, removed: 0, kept: 0, path: DEFAULT_CATALOG_PATH,
            message: `Codex catalog could not be restored: ${restored.reason}.`,
          };
  } catch (error) {
    return {
      state: "failed", changed: false, removed: 0, kept: 0, path: DEFAULT_CATALOG_PATH,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Restore native Codex, running history in a Worker under H.
 *
 * On a coordinated home the config/profile restore happens INSIDE the Codex
 * write lock, publishing a `remove` transition — the same serialization inject
 * uses. Without it, an older restore could overwrite a config a concurrent
 * enable had just written under the lock, and then honestly report success
 * while desired intent said ON. The desired-state re-read under the lock turns
 * that lost race into the discriminated `desired_enabled` skip.
 */
export async function restoreNativeCodexAsync(
  options: { revalidateDesiredState?: boolean } = {},
): Promise<CodexNativeRestoreResult> {
  const activeProvider = currentExternalCodexModelProvider();
  if (activeProvider) {
    // External-provider courtesy: only the stale journal is removed. The
    // history worker must not launch — it would turn a read-mostly courtesy
    // result into a history mutation on a home we do not own.
    removeJournal();
    return externalProviderRestoreResult(activeProvider);
  }

  // `restore` normally honours a human request even when an unrelated
  // service-manager probe is unavailable. A recorded FOREIGN home is not an
  // unrelated probe: it is positive evidence another installation owns these
  // native artifacts, so do not create profile/claim locks before refusing.
  if (options.revalidateDesiredState) {
    const ownership = inspectNativeCodexOwnership();
    if (ownership.ownership === "foreign") return foreignOwnershipRestoreRefusal(ownership.reason);
  }

  const eligibility = codexWriteCoordinationEligibility({
    coordinatorPath: () =>
      resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), getCodexHome()),
    residue: () => classifyNativeRoutedResidue(),
    integrationRecord: () => readIntegrationRecord(),
  });

  // Captured before the config half: a successful journal restore DELETES the journal, and
  // restoring the config can drop `model_catalog_json`. Either one would hide the routed
  // catalog we actually wrote (#1798).
  const journaledCatalogPath = journaledInjectedCatalogPath();
  let config: CodexRestoreConfigResult;
  let transitionReceipt: { nativeGeneration: number; currentTxId: string } | undefined;

  if (eligibility.kind === "coordinated" || eligibility.kind === "adopt") {
    // The restore has no candidate bytes to witness; freshness comes from the
    // filesystem reads and the desired-state re-read performed under the lock.
    const witness = { authoritySnapshotId: "codex-native-restore" };
    const coordinated = await withCodexWriteLock(
      {
        timeoutMs: DEFAULT_INJECT_LOCK_TIMEOUT_MS,
        ...(eligibility.kind === "adopt" ? { adoption: { direction: "remove" as const } } : {}),
        admitted: witness,
        readAdmissionUnderLock: () => witness,
      },
      (ctx) => {
        if (options.revalidateDesiredState && shouldSyncCodexOnStart(loadConfig())) {
          throw new CodexWriteLockSkipped("desired_enabled");
        }
        const published = ctx.coordinator.beginTransition(
          {
            nativeGeneration: ctx.expectation.nativeBefore,
            currentTxId: ctx.currentTxId,
          },
          {
            txId: ctx.expectation.txId,
            direction: "remove",
            authoritySnapshotId: ctx.admission.authoritySnapshotId,
            nextRetryAt: new Date().toISOString(),
          },
        );
        if (published.kind !== "updated") {
          throw new CodexWriteConflictError(
            `The Codex transition could not be published: ${published.kind}.`,
          );
        }
        const preImages = captureCodexPreImages();
        let restored: CodexRestoreConfigResult;
        try {
          restored = restoreCodexConfigInline();
        } catch (error) {
          const compensated = restoreCodexPreImages(preImages);
          if (!compensated.complete) throw new CodexPartialWriteError(compensated.unrestored);
          throw error;
        }
        return {
          config: restored,
          preImages,
          receipt: {
            nativeGeneration: ctx.expectation.nativeAfter,
            currentTxId: ctx.expectation.txId,
          },
        };
      },
    );
    if (coordinated.status === "skipped") return desiredEnabledRestoreSkip();
    if (coordinated.status !== "acquired") {
      config = {
        state: "failed",
        changed: false,
        action: "failed",
        message: coordinated.status === "busy"
          ? `Another process is writing Codex configuration right now (waited ${coordinated.waitedMs}ms). Retry shortly.`
          : `Codex configuration was not restored: ${coordinated.message}`,
      };
    } else {
      recordCodexNativeTransactionProvenance(
        coordinated.value.preImages,
        coordinated.value.receipt.currentTxId,
      );
      config = coordinated.value.config;
      transitionReceipt = coordinated.value.receipt;
    }
  } else {
    // Legacy-uncoordinated (or unresolvable) homes keep the unserialized path
    // they have always had; restore is the escape hatch and must not strand
    // them. The plain re-read still honors an intervening re-enable.
    if (options.revalidateDesiredState && shouldSyncCodexOnStart(loadConfig())) {
      return desiredEnabledRestoreSkip();
    }
    config = restoreCodexConfigInline();
  }

  const catalog = restoreCodexCatalogArtifact(options.revalidateDesiredState === true, journaledCatalogPath);
  const outcome = await runCodexHistoryJob({
    ...resolveCodexHistoryJobTarget(),
    ...(options.revalidateDesiredState ? { expectedDesiredEnabled: false } : {}),
    operation: deriveCodexHistoryOperation({ direction: "restore", resumeHistory: true, legacyMode: false }),
  });
  if (transitionReceipt) {
    resolveCodexHistoryTransition(transitionReceipt, outcome);
  }
  const history: CodexRestoreHistoryResult = outcome.kind === "converged"
    ? {
        state: "ok", changed: outcome.rows > 0 || outcome.files > 0, rows: outcome.rows, files: outcome.files, ejectedRows: 0,
        message: outcome.rows > 0
          ? `Resume history metadata restored from opencodex backup (${outcome.rows} thread(s)); original providers preserved.`
          : "No backed-up resume-history metadata was pending; untracked routed history was left unchanged.",
      }
    : outcome.kind === "skipped"
      ? { state: "skipped", changed: false, rows: 0, files: 0, ejectedRows: 0, message: "Codex resume history was skipped." }
      : outcome.kind === "blocked" && (outcome.reason === "desired_disabled" || outcome.reason === "desired_enabled")
        ? {
            state: "skipped", changed: false, rows: 0, files: 0, ejectedRows: 0,
            message: outcome.reason === "desired_disabled"
              ? "Codex integration was disabled; history restoration was skipped."
              : "Codex integration was enabled; history restoration was skipped.",
          }
      : outcome.kind === "blocked" || outcome.kind === "failed"
        ? failedHistoryRestoreFromOutcome(outcome)
        : failedHistoryRestore();
  const base = catalog.removed > 0
    ? `${config.message} Catalog restored to ${catalog.kept} native model(s) (dropped ${catalog.removed} proxy-routed).`
    : config.message;
  const success = config.state !== "failed"
    && catalog.state !== "failed"
    && history.state !== "failed";
  return {
    success,
    message: `${base}${history.state === "failed" ? ` ⚠️ ${history.message}` : ""}`,
    artifacts: { config, catalog, history },
  };
}

export function restoreNativeCodex(options: { skipHistory?: boolean; revalidateDesiredState?: boolean } = {}): CodexNativeRestoreResult {
  const activeProvider = currentExternalCodexModelProvider();
  if (activeProvider) {
    removeJournal();
    return externalProviderRestoreResult(activeProvider);
  }
  if (options.revalidateDesiredState && shouldSyncCodexOnStart(loadConfig())) {
    return desiredEnabledRestoreSkip();
  }
  // Captured before the config half: a successful journal restore DELETES the journal, and
  // restoring the config can drop `model_catalog_json`. Either one would hide the routed
  // catalog we actually wrote (#1798).
  const journaledCatalogPath = journaledInjectedCatalogPath();
  const config = restoreCodexConfigInline();
  const catalog = restoreCodexCatalogArtifact(options.revalidateDesiredState === true, journaledCatalogPath);
  // Design B (loopback) steady state: threads are already tagged openai, so prove the
  // no-op with a readonly probe instead of write-opening a DB the Codex app may hold
  // (Windows: WAL writer lock -> seconds of stalling + a false warning on every stop).
  // Legacy (non-loopback) installs keep the unconditional write-open restore.
  let skipWhenProvablyNoop = false;
  try {
    skipWhenProvablyNoop = !shouldInjectApiAuthHeader(loadConfig());
  } catch {
    /* unreadable config: keep the conservative write-open restore */
  }
  // `skipHistory` is how the async wrapper takes this work for itself: the
  // native files come down here, and history runs in the Worker under H.
  const rawHistory = options.skipHistory
    ? { rows: 0, files: 0 }
    : syncCodexHistoryProvider("openai", undefined, undefined, {
        skipWhenProvablyNoop,
      });
  const history: CodexRestoreHistoryResult = options.skipHistory
    ? { state: "skipped", changed: false, rows: 0, files: 0, ejectedRows: 0, message: "History restoration runs asynchronously." }
    : rawHistory.failed
      ? failedHistoryRestore(rawHistory.failureReason, undefined, rawHistory)
      : {
          state: "ok",
          changed: rawHistory.rows > 0 || rawHistory.files > 0 || (rawHistory.ejectedRows ?? 0) > 0,
          rows: rawHistory.rows,
          files: rawHistory.files,
          ejectedRows: rawHistory.ejectedRows ?? 0,
          message: rawHistory.rows > 0
            ? `Resume history metadata restored from opencodex backup (${rawHistory.rows} thread(s)); original providers preserved.`
            : "No backed-up resume-history metadata was pending; untracked routed history was left unchanged.",
        };
  const message = catalog.removed > 0
    ? `${config.message} Catalog restored to ${catalog.kept} native model(s) (dropped ${catalog.removed} proxy-routed).`
    : config.message;
  return {
    success: config.state !== "failed" && catalog.state !== "failed" && history.state !== "failed",
    message,
    artifacts: { config, catalog, history },
  };
}

export function getCodexConfigPath(): string {
  return CODEX_CONFIG_PATH;
}

/**
 * Frame one failed apply history job honestly.
 *
 * A genuine lock keeps the established deferred/SKIPPED wording; any other
 * reason names itself instead of blaming the Codex app/IDE.
 */
export function formatApplyHistoryFailure(outcome: CodexHistoryJobOutcome, legacyMode: boolean): string {
  // A busy database is a deferral no matter which half observed it: the lock
  // contended (blocked/busy), or the worker acquired the lock and then found
  // SQLite busy (failed with a busy history reason). Only those keep the
  // deferred headline; every other failure is a real "NOT changed".
  const busy =
    (outcome.kind === "blocked" && outcome.reason === "busy") ||
    (outcome.kind === "failed" && outcome.historyFailureReason === "busy");
  const partiallyChanged = outcome.kind === "failed"
    && ((outcome.rows ?? 0) > 0 || (outcome.files ?? 0) > 0);
  const headline = partiallyChanged
    ? "Codex resume history changed but did not converge"
    : legacyMode
      ? "Codex resume history sync SKIPPED"
      : busy
      ? "Codex resume history metadata restore deferred"
      : "Codex resume history NOT changed";
  return `  ⚠️ ${headline}: ${describeHistoryJobFailure(outcome, "apply", legacyMode)}\n`;
}
