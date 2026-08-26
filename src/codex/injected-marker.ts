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

export const OCX_SECTION_MARKER = "# Auto-injected by opencodex";

export function isRootOpenaiBaseUrlLine(line: string): boolean {
  return /^\s*openai_base_url\s*=/.test(line);
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
  const lines = content.split("\n");
  const firstTable = lines.findIndex(line => /^\s*\[/.test(line));
  const rootLines = lines.slice(0, firstTable === -1 ? lines.length : firstTable);
  const pattern = tomlStringPattern(key);
  for (const line of rootLines) {
    const match = pattern.exec(line);
    if (match?.[1]) return parseTomlString(match[1]).trim();
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
export function stripJournaledOpenaiBaseUrl(content: string, injectedUrl: string | null): string {
  if (!injectedUrl) return content;
  const lines = content.split(String.fromCharCode(10));
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const drop = new Set<number>();
  for (let i = 0; i < rootEnd; i++) {
    const line = lines[i]!;
    if (!isRootOpenaiBaseUrlLine(line)) continue;
    if (rootTomlString(line, "openai_base_url") !== injectedUrl) continue;
    drop.add(i);
    // Take an ownership marker directly above it too, so repeated cycles cannot
    // accumulate orphaned comments.
    if (i > 0 && lines[i - 1]!.includes(OCX_SECTION_MARKER)) drop.add(i - 1);
  }
  if (drop.size === 0) return content;
  return lines.filter((_, i) => !drop.has(i)).join(String.fromCharCode(10));
}

export function hasInjectedOpenaiBaseUrl(content: string): boolean {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  for (let i = 1; i < rootEnd; i++) {
    if (isRootOpenaiBaseUrlLine(lines[i]!) && lines[i - 1]!.includes(OCX_SECTION_MARKER)) return true;
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
