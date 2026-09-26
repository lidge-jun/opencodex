/**
 * Does opencodex-owned Codex routing name a loopback port this process does not serve?
 *
 * `classifyCodexRouting` answers "opencodex-local" whatever the port, so a live proxy cannot tell
 * from it that `config.toml` still points at a port a dead instance left behind. That is the state a
 * killed second instance produced: the owner kept serving its port while every new Codex thread
 * failed with "Connection refused" against the other one, and nothing looked again after startup.
 *
 * Pure: the caller passes the file bytes, the ports it serves, and (lazily) the journaled values.
 * Only OWNED routing counts. Native config, a user's own root URL, a custom provider and an external
 * `model_provider` are all `not-owned`, so nothing built on this can undo `ocx restore`, an eject, a
 * Codex-OFF toggle or a stop teardown. Only loopback endpoints with an explicit port can be foreign:
 * LAN and admission-token routing is never reported.
 */
import { externalCodexModelProvider } from "./inject/config-toml";
import { classifyRoutingEndpoint } from "./inject/routing-classify";
import {
  OCX_SECTION_MARKER,
  REALTIME_WS_BASE_URL_KEY,
  isRootOpenaiBaseUrlLine,
  isRootRealtimeWsBaseUrlLine,
  providerTableString,
  rootTomlString,
} from "./injected-marker";

export type CodexRoutingDriftKey =
  | "openai_base_url"
  | typeof REALTIME_WS_BASE_URL_KEY
  | "model_providers.opencodex.base_url";

export interface CodexRoutingDriftTarget {
  readonly key: CodexRoutingDriftKey;
  readonly url: string;
  /** Host as written, brackets removed (`127.0.0.1`, `localhost`, `::1`). */
  readonly hostname: string;
  readonly port: number;
}

export type CodexRoutingDrift =
  | { readonly kind: "none" }
  | { readonly kind: "not-owned" }
  | { readonly kind: "foreign"; readonly targets: readonly CodexRoutingDriftTarget[] };

/** The root URLs the last injection recorded writing (`journal.ts`), read without side effects. */
export interface JournaledCodexRouting {
  readonly openaiBaseUrl: string | null;
  readonly realtimeWsBaseUrl: string | null;
}

export interface CodexRoutingDriftInput {
  /** Ports this process serves: the bound port and the loopback listener port. */
  readonly ownPorts: Iterable<number>;
  /**
   * Value evidence for a root line whose marker comment a Codex app rewrite dropped (#1798). A
   * function is called at most once, and only when an unmarked root URL names a foreign port.
   */
  readonly journaled?: JournaledCodexRouting | (() => JournaledCodexRouting);
}

/** The root line's value, and whether the ownership marker sits directly above it. */
function rootLine(content: string, key: string, isLine: (line: string) => boolean): { value: string | null; marked: boolean } {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(line => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  for (let index = 0; index < rootEnd; index += 1) {
    if (!isLine(lines[index]!)) continue;
    return {
      value: rootTomlString(lines[index]!, key),
      marked: index > 0 && lines[index - 1]!.includes(OCX_SECTION_MARKER),
    };
  }
  return { value: null, marked: false };
}

/** A loopback endpoint with an explicit port, or null for anything the detector must ignore. */
function loopbackEndpoint(url: string): { hostname: string; port: number } | null {
  if (classifyRoutingEndpoint(url) !== "local") return null;
  try {
    const parsed = new URL(url);
    if (!parsed.port) return null;
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { hostname: parsed.hostname.replace(/^\[|\]$/g, ""), port };
  } catch {
    return null;
  }
}

export function detectCodexRoutingDrift(content: string, input: CodexRoutingDriftInput): CodexRoutingDrift {
  const own = new Set(input.ownPorts);
  const normalized = content.replace(/\r\n/g, "\n");
  let journaled: JournaledCodexRouting | undefined;
  const readJournaled = (): JournaledCodexRouting => {
    if (journaled) return journaled;
    const source = input.journaled;
    journaled = typeof source === "function" ? source() : (source ?? { openaiBaseUrl: null, realtimeWsBaseUrl: null });
    return journaled;
  };

  // `marked` is the cheap ownership proof; `owned` adds the journal's value evidence, which is read
  // only for an unmarked line that names a foreign port.
  const candidates: Array<{ key: CodexRoutingDriftKey; url: string; marked: boolean; owned: () => boolean }> = [];
  const base = rootLine(normalized, "openai_base_url", isRootOpenaiBaseUrlLine);
  if (base.value) {
    const url = base.value;
    candidates.push({ key: "openai_base_url", url, marked: base.marked, owned: () => base.marked || readJournaled().openaiBaseUrl === url });
  }
  const realtime = rootLine(normalized, REALTIME_WS_BASE_URL_KEY, isRootRealtimeWsBaseUrlLine);
  if (realtime.value) {
    const url = realtime.value;
    candidates.push({ key: REALTIME_WS_BASE_URL_KEY, url, marked: realtime.marked, owned: () => realtime.marked || readJournaled().realtimeWsBaseUrl === url });
  }
  if (rootTomlString(normalized, "model_provider") === "opencodex") {
    const url = providerTableString(normalized, "opencodex", "base_url");
    if (url) candidates.push({ key: "model_providers.opencodex.base_url", url, marked: true, owned: () => true });
  }
  if (candidates.length === 0) return { kind: "not-owned" };
  // An external provider owns routing even when an old opencodex line is still in the file.
  if (externalCodexModelProvider(normalized) !== null) return { kind: "not-owned" };

  const targets: CodexRoutingDriftTarget[] = [];
  let ours = false;
  for (const candidate of candidates) {
    const endpoint = loopbackEndpoint(candidate.url);
    if (endpoint !== null && !own.has(endpoint.port)) {
      if (candidate.owned()) targets.push({ key: candidate.key, url: candidate.url, ...endpoint });
      continue;
    }
    // A URL naming a port we serve is never drift, whoever wrote it; neither is non-loopback routing.
    ours ||= candidate.marked || endpoint !== null;
  }
  if (targets.length > 0) return { kind: "foreign", targets };
  return ours ? { kind: "none" } : { kind: "not-owned" };
}
