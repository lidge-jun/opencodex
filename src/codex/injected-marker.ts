/**
 * Ownership predicates for `~/.codex/config.toml`: does opencodex own the routing
 * currently written there?
 *
 * These live in their own leaf module rather than in `inject.ts` because
 * `journal.ts` needs them and `inject.ts` already imports `journal.ts`. Keeping
 * them here breaks that cycle. `inject.ts` imports them back and re-exports the
 * two public predicates, so external callers see no change.
 */
import { parseTomlString } from "./paths";
import { rootAssignmentKey, rootSourceLines, sourceText } from "./toml-source-lines";

export const OCX_SECTION_MARKER = "# Auto-injected by opencodex";

/**
 * The marker line actually written above ROUTING keys, carrying the command that undoes them.
 *
 * #5261: a Windows user whose proxy had stopped was locked out of Codex sign-in, because the
 * root `openai_base_url` we write keeps pointing Codex's built-in openai provider at a port
 * nothing is listening on. The only surface such a user can still read is `config.toml` itself,
 * and it said nothing but "Auto-injected by opencodex" — so the recovery they found was to
 * hand-delete lines and the catalog file, which is strictly worse than `ocx restore`.
 *
 * Root routing predicates and lossless provider table capture/removal accept either exact marker
 * line directly above structural routing syntax; they do not claim user comments or opaque value
 * lines that merely contain the marker. Keeping the hint on the same
 * line lets those transforms remove it together with the routing they own.
 *
 * Scope is routing only. Prompt layers keep the bare marker: `ocx restore` is not their undo.
 */
export const OCX_ROUTING_MARKER_LINE = `${OCX_SECTION_MARKER} (undo: ocx restore)`;

export function isOcxRoutingMarkerLine(line: string): boolean {
  const text = line.trim();
  return text === OCX_SECTION_MARKER || text === OCX_ROUTING_MARKER_LINE;
}

export function isRootOpenaiBaseUrlLine(line: string): boolean {
  return rootAssignmentKey(line) === "openai_base_url";
}

/**
 * codex-rs root key that redirects the realtime sideband WebSocket (WebRTC voice
 * join + standalone realtime WS) without touching ordinary provider HTTP. Since
 * openai/codex 438c9e98d (#35830) the sideband ignores the provider base URL and
 * dials `https://api.openai.com/v1` unless this key is set, so a Pool-routed
 * call-create and a directly-joined sideband end up on different accounts (404).
 * Injected next to `openai_base_url` with the same value.
 */
export const REALTIME_WS_BASE_URL_KEY = "experimental_realtime_ws_base_url";

export function isRootRealtimeWsBaseUrlLine(line: string): boolean {
  return rootAssignmentKey(line) === REALTIME_WS_BASE_URL_KEY;
}

export function tomlStringPattern(key: string): RegExp {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyToken = `(?:${escaped}|"${escaped}"|'${escaped}')`;
  // The quoted value is captured WITH its quotes so callers can decode it as TOML.
  // A basic string escapes backslashes, so a Windows path is stored doubled; reading
  // the raw bytes back returned a path that matched nothing on disk and made the
  // journal's recorded catalog path un-restorable (#1798).
  return new RegExp(`^\\s*${keyToken}\\s*=\\s*("(?:\\\\.|[^"\\\\])*"|'[^']*')\\s*(?:#.*)?$`);
}

export function rootTomlString(content: string, key: string): string | null {
  const { lines, rootEnd } = rootSourceLines(content);
  for (const line of lines.slice(0, rootEnd)) {
    if (!line.structural || rootAssignmentKey(line.text) !== key) continue;
    try {
      const value = (Bun.TOML.parse(line.text) as Record<string, unknown>)[key];
      if (typeof value === "string") return value.trim();
    } catch { /* Incomplete multiline assignments are not single-line ownership evidence. */ }
  }
  return null;
}

export function providerTableStart(lines: string[], provider: string): number {
  const escapedProvider = provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const providerToken = `(?:${escapedProvider}|"${escapedProvider}"|'${escapedProvider}')`;
  const header = new RegExp(`^\\s*\\[\\s*(?:model_providers|"model_providers"|'model_providers')\\s*\\.\\s*${providerToken}\\s*\\]\\s*(?:#.*)?$`);
  return lines.findIndex(line => header.test(line));
}

export function providerTableString(content: string, provider: string, key: string): string | null {
  const lines = content.split("\n");
  const start = providerTableStart(lines, provider);
  if (start === -1) return null;
  const pattern = tomlStringPattern(key);
  for (let index = start + 1; index < lines.length && !/^\s*\[/.test(lines[index]); index += 1) {
    const match = pattern.exec(lines[index]);
    if (match?.[1]) return parseTomlString(match[1]).trim();
  }
  return null;
}

/**
 * Drop a root `openai_base_url` whose VALUE is the one a recorded injection wrote.
 *
 * #1798: the marker-adjacency rule below is formatting evidence, and the Codex app
 * reserializes the file -- values kept, comments dropped. This rule is value evidence
 * instead, so it still recognizes our URL after that rewrite. It is deliberately an
 * EXACT value match against what we recorded writing: a user gateway we never wrote
 * cannot match, so restore can never delete a URL that was not ours.
 */
export function stripJournaledOpenaiBaseUrl(
  content: string,
  injectedUrl: string | null,
  injectedRealtimeWsUrl: string | null = null,
): string {
  if (!injectedUrl && !injectedRealtimeWsUrl) return content;
  const { bom, lines, rootEnd } = rootSourceLines(content);
  const drop = new Set<number>();
  for (let i = 0; i < rootEnd; i++) {
    if (!lines[i]!.structural) continue;
    const line = lines[i]!.text;
    // Each key is matched against ITS OWN recorded value. The realtime override is
    // journaled separately so a user-owned override that happens to equal the proxy
    // URL is never mistaken for ours.
    if (isRootOpenaiBaseUrlLine(line)) {
      if (!injectedUrl || rootTomlString(line, "openai_base_url") !== injectedUrl) continue;
    } else if (isRootRealtimeWsBaseUrlLine(line)) {
      if (!injectedRealtimeWsUrl || rootTomlString(line, REALTIME_WS_BASE_URL_KEY) !== injectedRealtimeWsUrl) continue;
    } else {
      continue;
    }
    drop.add(i);
    // Take an ownership marker directly above it too, so repeated cycles cannot
    // accumulate orphaned comments.
    if (i > 0 && lines[i - 1]!.structural && isOcxRoutingMarkerLine(lines[i - 1]!.text)) drop.add(i - 1);
  }
  if (drop.size === 0) return content;
  return bom + sourceText(lines.filter((_, i) => !drop.has(i)));
}

export function hasInjectedOpenaiBaseUrl(content: string): boolean {
  const { lines, rootEnd } = rootSourceLines(content);
  for (let i = 1; i < rootEnd; i++) {
    if (lines[i]!.structural && lines[i - 1]!.structural
      && isRootOpenaiBaseUrlLine(lines[i]!.text) && rootTomlString(lines[i]!.text, "openai_base_url") !== null
      && isOcxRoutingMarkerLine(lines[i - 1]!.text)) return true;
  }
  return false;
}

/**
 * True when the active Codex config is owned by opencodex routing. Covers the
 * loopback Design B root override and the legacy/non-loopback provider table.
 * A user-owned `openai_base_url` is intentionally not classified as injected.
 */
export function hasInjectedCodexRouting(content: string): boolean {
  if (hasInjectedOpenaiBaseUrl(content)) return true;
  return rootTomlString(content, "model_provider") === "opencodex"
    && providerTableString(content, "opencodex", "base_url") !== null;
}
