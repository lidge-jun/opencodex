/**
 * Ownership predicates for `~/.codex/config.toml`: does opencodex own the routing
 * currently written there?
 *
 * These live in their own leaf module rather than in `inject.ts` because
 * `journal.ts` needs them and `inject.ts` already imports `journal.ts`. Keeping
 * them here breaks that cycle. `inject.ts` imports them back and re-exports the
 * two public predicates, so external callers see no change.
 */
export const OCX_SECTION_MARKER = "# Auto-injected by opencodex";

export function isRootOpenaiBaseUrlLine(line: string): boolean {
  return /^\s*openai_base_url\s*=/.test(line);
}

export function tomlStringPattern(key: string): RegExp {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyToken = `(?:${escaped}|"${escaped}"|'${escaped}')`;
  return new RegExp(`^\\s*${keyToken}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`);
}

export function rootTomlString(content: string, key: string): string | null {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(line => /^\s*\[/.test(line));
  const rootLines = lines.slice(0, firstTable === -1 ? lines.length : firstTable);
  const pattern = tomlStringPattern(key);
  for (const line of rootLines) {
    const match = pattern.exec(line);
    if (match?.[1]) return match[1].trim();
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
    if (match?.[1]) return match[1].trim();
  }
  return null;
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
