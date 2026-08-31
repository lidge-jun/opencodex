import { constants, copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../config";
import { applyEol, dominantEol, isLoopbackHostname, providerBaseHost } from "../codex/inject";
import {
  grokDefaultReasoningEffort,
  grokReasoningEffortOption,
  sanitizeGrokReasoningEfforts,
} from "./effort";

export interface GrokInjectModel {
  id: string;
  name?: string;
  contextWindow?: number;
  /** Catalog ladder. Empty or absent omits every thinking-intensity field. */
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

export interface GrokInjectResult {
  ok: boolean;
  changed: boolean;
  message: string;
  skippedReason?: "no-grok-home" | "orphaned-marker" | "non-loopback";
}

const BEGIN_MARKER = "# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>";
const END_MARKER = "# <<< opencodex managed block <<<";
// Grok 0.2.109 (2026-07-21) shipped working [model_providers.<id>] inheritance: base_url,
// api_backend, api_key, and extra_headers declared on the provider are applied to inference
// routing for inheriting models (verified in grok-build's with_provider_defaults →
// resolve_model_list → sampling_config_for_model → SamplingClient chain). We emit one shared
// [model_providers.opencodex] table and each [model.*] references it via model_provider.

/**
 * INTERNAL API shared with `./inspect` (WP2, devlog 260803_integrations_toggle_all/012).
 * The inspector and the writer are its only callers — one parser for one fence, so a
 * read and a strip can never disagree about where our block starts and stops.
 */
export interface ManagedRegion {
  start: number;
  end: number;
  orphaned: boolean;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * INTERNAL API shared with `./inspect`, so the reader and the writer resolve the
 * authoritative home identically (GROK_HOME, then ~/.grok). Not a public surface.
 */
export function resolveGrokHome(grokHome?: string): string {
  return grokHome ?? (process.env.GROK_HOME || join(homedir(), ".grok"));
}

/** INTERNAL API shared with `./inspect` — a missing home is a STATE, not an error. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** INTERNAL API — see `ManagedRegion` above. Not a public fence-parsing surface. */
export function findManagedRegion(content: string): ManagedRegion | null {
  const start = content.indexOf(BEGIN_MARKER);
  if (start === -1) return null;
  const endMarkerStart = content.indexOf(END_MARKER, start + BEGIN_MARKER.length);
  if (endMarkerStart === -1) return { start, end: content.length, orphaned: true };
  return { start, end: endMarkerStart + END_MARKER.length, orphaned: false };
}

/**
 * A TOML key segment as it may be spelled in a table header: bare, basic string, or literal
 * string. All three spellings of the same key address the SAME table, so both segments of a
 * `[model.<alias>]` header must be canonicalized before comparison.
 */
const KEY_SEGMENT = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const DOTTED_KEY = String.raw`${KEY_SEGMENT}(?:[ \t]*\.[ \t]*${KEY_SEGMENT})*`;
/** One complete TOML table-header line; paired brackets reject array-value lookalikes. */
const TABLE_HEADER_LINE = new RegExp(
  String.raw`^[ \t]*(?:\[\[[ \t]*(${DOTTED_KEY})[ \t]*\]\]|\[[ \t]*(${DOTTED_KEY})[ \t]*\])[ \t]*(?:#[^\r\n]*)?$`,
);

interface TomlTableHeader {
  index: number;
  length: number;
  segments: string[];
  array: boolean;
}

interface TomlStructure {
  view: string;
  headers: TomlTableHeader[];
  containerRootLineStarts: Set<number>;
}

/** End of a TOML multi-line basic/literal string, or EOF when it is unclosed. */
function tomlMultilineStringEnd(content: string, start: number, quote: '"' | "'"): number {
  let cursor = start + 3;
  while (cursor < content.length) {
    if (quote === '"' && content[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (content[cursor] === quote
      && content[cursor + 1] === quote
      && content[cursor + 2] === quote) {
      let end = cursor + 3;
      // TOML permits one or two quote characters immediately before the closing delimiter.
      if (content[end] === quote) {
        end += 1;
        if (content[end] === quote) end += 1;
      }
      return end;
    }
    cursor += 1;
  }
  return content.length;
}

/** Find one TOML string value's exact source span; semantic decoding uses Bun's parser. */
function tomlStringSpanAt(content: string, start: number): { end: number } | null {
  const quote = content[start];
  if (quote !== '"' && quote !== "'") return null;
  if (content[start + 1] === quote && content[start + 2] === quote) {
    const end = tomlMultilineStringEnd(content, start, quote);
    const token = content.slice(start, end);
    if (token.length < 6 || !token.endsWith(quote.repeat(3))) return null;
    return { end };
  }

  for (let cursor = start + 1; cursor < content.length; cursor += 1) {
    const char = content[cursor]!;
    if (char === "\r" || char === "\n") return null;
    if (quote === '"' && char === "\\") {
      cursor += 1;
      continue;
    }
    if (char === quote) {
      return { end: cursor + 1 };
    }
  }
  return null;
}

/** Find the matching end of one inline table / array while skipping strings and comments. */
function tomlContainerEnd(content: string, start: number): number | null {
  const opener = content[start];
  if (opener !== "{" && opener !== "[") return null;
  const stack: string[] = [opener];
  for (let index = start + 1; index < content.length;) {
    const char = content[index]!;
    if (char === "#") {
      const newline = content.indexOf("\n", index);
      index = newline === -1 ? content.length : newline + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const span = tomlStringSpanAt(content, index);
      if (span === null) return null;
      index = span.end;
      continue;
    }
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.pop() !== expected) return null;
      if (stack.length === 0) return index + 1;
    }
    index += 1;
  }
  return null;
}

/**
 * A same-length lexical projection for structural scans. Triple-quoted string bytes become
 * spaces while line endings and every byte outside those values keep their original offsets.
 */
function tomlStructuralView(content: string): string {
  let state: "code" | "comment" | "basic" | "literal" = "code";
  let cursor = 0;
  let output = "";
  for (let index = 0; index < content.length;) {
    const char = content[index]!;
    if (state === "comment") {
      if (char === "\n") state = "code";
      index += 1;
      continue;
    }
    if (state === "basic") {
      if (char === "\\") index += 2;
      else {
        if (char === '"') state = "code";
        index += 1;
      }
      continue;
    }
    if (state === "literal") {
      if (char === "'") state = "code";
      index += 1;
      continue;
    }
    if (char === "#") {
      state = "comment";
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      if (content[index + 1] === char && content[index + 2] === char) {
        const end = tomlMultilineStringEnd(content, index, char);
        output += content.slice(cursor, index);
        output += content.slice(index, end).replace(/[^\r\n]/g, " ");
        cursor = end;
        index = end;
        continue;
      }
      state = char === '"' ? "basic" : "literal";
    }
    index += 1;
  }
  return output.length === 0 ? content : output + content.slice(cursor);
}

/** Update array / inline-table nesting for one non-header line in the structural view. */
function tomlContainerDepthAfterLine(line: string, initialDepth: number): number {
  let depth = initialDepth;
  let state: "code" | "basic" | "literal" = "code";
  for (let index = 0; index < line.length;) {
    const char = line[index]!;
    if (state === "basic") {
      if (char === "\\") index += 2;
      else {
        if (char === '"') state = "code";
        index += 1;
      }
      continue;
    }
    if (state === "literal") {
      if (char === "'") state = "code";
      index += 1;
      continue;
    }
    if (char === "#") break;
    if (char === '"' || char === "'") {
      state = char === '"' ? "basic" : "literal";
      index += 1;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth = Math.max(0, depth - 1);
    index += 1;
  }
  return depth;
}

/**
 * Find real table headers and assignment-eligible lines while excluding arrays, inline tables,
 * comments, and multi-line strings. Offsets remain exact because `view` is length-preserving.
 */
function analyzeTomlStructure(content: string): TomlStructure {
  const view = tomlStructuralView(content);
  const headers: TomlTableHeader[] = [];
  const containerRootLineStarts = new Set<number>();
  let depth = 0;
  for (let lineStart = 0; lineStart <= view.length;) {
    const newline = view.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? view.length : newline;
    const rawLine = view.slice(lineStart, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const header = depth === 0 ? TABLE_HEADER_LINE.exec(line) : null;
    if (header) {
      const dottedKey = header[1] ?? header[2]!;
      headers.push({
        index: lineStart,
        length: header[0].length,
        segments: canonicalDottedKey(dottedKey),
        array: header[1] !== undefined,
      });
    } else {
      if (depth === 0) containerRootLineStarts.add(lineStart);
      depth = tomlContainerDepthAfterLine(line, depth);
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return { view, headers, containerRootLineStarts };
}

/** Resolve a header key segment (bare / basic / literal) to the key it actually addresses. */
function canonicalKeySegment(raw: string): string {
  if (raw.startsWith('"')) return decodeTomlBasicString(raw.slice(1, -1));
  if (raw.startsWith("'")) return raw.slice(1, -1); // literal strings have no escapes
  return raw;
}

/** Split a TOML dotted key without treating dots inside quoted segments as separators. */
function canonicalDottedKey(raw: string): string[] {
  return [...raw.matchAll(new RegExp(KEY_SEGMENT, "g"))]
    .map(match => canonicalKeySegment(match[0]!));
}

/**
 * `[model.<alias>]` table headers the USER owns (outside our fence) — reserved for collisions.
 * TOML admits equivalent header spellings for BOTH segments (`["model"."ocx-mine"]`,
 * `['model'.ocx-mine]`, `[ model . ocx-mine ]`); all of them redefine the same table, so each
 * form is canonicalized before it is reserved.
 */
function userModelAliases(content: string, region: ManagedRegion | null): Set<string> {
  const outsideManagedRegion = region
    ? content.slice(0, region.start) + content.slice(region.end)
    : content;
  const aliases = new Set<string>();
  for (const header of analyzeTomlStructure(outsideManagedRegion).headers) {
    if (header.segments[0] !== "model" || header.segments.length < 2) continue;
    aliases.add(header.segments[1]!);
  }
  return aliases;
}

/** The api_key literal every generated entry carries. It is necessary, but not ownership alone. */
const OPENCODEX_API_KEY = "opencodex-loopback";
const OPENCODEX_GROK_MARKER = "x-opencodex-grok";

/** The provider id opencodex owns inside ~/.grok/config.toml. */
const OPENCODEX_PROVIDER_ID = "opencodex";

/** A plain `[model.<alias>]` table outside the fence that opencodex itself wrote. */
interface OrphanTable {
  alias: string;
  /** The model id this entry routes to — used to find its replacement alias. */
  modelId: string;
  /** Explicit markers authorize teardown; legacy fingerprints authorize replacement only. */
  ownership: "explicit" | "legacy";
  /** Offsets into the NORMALIZED content: header start .. next header start (or EOF). */
  start: number;
  end: number;
  /** Re-serialized child tables may be separated from the parent by unrelated tables. */
  additionalRanges: Array<{ start: number; end: number }>;
}

/** `key = "value"` / `key = value` pairs at the top level of one table body. */
function tableBodyKeys(body: string): Map<string, string> {
  const keys = new Map<string, string>();
  const structure = analyzeTomlStructure(body);
  // Bare keys only: a quoted dotted segment could otherwise split a quoted value
  // containing a dot.
  const assignment =
    /^[ \t]*([A-Za-z0-9_-]+(?:[ \t]*\.[ \t]*[A-Za-z0-9_-]+)*)[ \t]*=[ \t]*(.*?)[ \t]*$/gm;
  for (const match of structure.view.matchAll(assignment)) {
    if (!structure.containerRootLineStarts.has(match.index!)) continue;
    const path = match[1]!.split(".").map(part => part.trim());
    const raw = match[2]!;
    const value = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
      ? decodeTomlBasicString(raw.slice(1, -1))
      : raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")
        ? raw.slice(1, -1) // TOML literal strings do not process escapes.
        : raw;
    if (path.length === 1) {
      if (!keys.has(path[0]!)) keys.set(path[0]!, value);
      continue;
    }
    // Dotted keys re-open a nested namespace: `extra_headers.k = v` is the key `k` of the
    // sub-table `extra_headers`, which a folded-body reader must be able to see. Rebuild
    // the inline-table spelling that hasInlineOwnershipMarker matches (bare word booleans
    // and numbers keep their TOML spelling — no quoting, so the regex is unchanged).
    let suffix = value;
    for (let level = path.length - 1; level >= 1; level -= 1) {
      const prefixKey = path.slice(0, level).join(".");
      const inner = `${JSON.stringify(path[level]!)} = ${suffix}`;
      suffix = `{ ${inner} }`;
      const existing = keys.get(prefixKey);
      if (existing === undefined || !existing.startsWith("{")) {
        keys.set(prefixKey, suffix);
      } else {
        keys.set(prefixKey, `{ ${existing.slice(2, -2)}, ${inner} }`);
      }
    }
  }
  return keys;
}

/** Is this base_url pointed at the local machine? */
function isLoopbackBaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** Exact marker emitted inside every modern generated model table. */
function hasInlineOwnershipMarker(value: string | undefined): boolean {
  // The reconstructed fold of a Grok dotted re-serialization writes bare `1` for the
  // boolean literal, so both `= "1"` and `= 1` spellings are accepted here.
  return value !== undefined
    && /^\{[ \t]*["']x-opencodex-grok["'][ \t]*=[ \t]*(?:"1"|'1'|1)[ \t]*\}$/.test(value);
}

/** Historical deterministic alias, including collision suffixes allocated by the writer. */
function isGeneratedAliasForModel(alias: string, modelId: string): boolean {
  const base = `ocx-${modelId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  if (alias === base) return true;
  if (!alias.startsWith(`${base}-`)) return false;
  const suffix = alias.slice(base.length + 1);
  return /^[1-9][0-9]*$/.test(suffix) && Number(suffix) >= 2;
}

/** Pre-marker auto-generated row shape. Manual rows never carried the generated name. */
function isLegacyGeneratedTable(alias: string, keys: ReadonlyMap<string, string>): boolean {
  const modelId = keys.get("model");
  return modelId !== undefined
    && modelId.length > 0
    && keys.get("api_backend") === "chat_completions"
    && keys.get("name") === `OCX ${modelId}`
    && isGeneratedAliasForModel(alias, modelId);
}

/** Classify a direct provider/model id without stealing a slash-shaped configured combo alias. */
function isDisabledProviderModelId(
  modelId: string,
  disabledProviderNamespaces: ReadonlySet<string> | undefined,
  comboPublicModelIds: ReadonlySet<string> | undefined,
): boolean {
  if (!disabledProviderNamespaces || comboPublicModelIds?.has(modelId)) return false;
  const slash = modelId.indexOf("/");
  return slash > 0
    && slash < modelId.length - 1
    && disabledProviderNamespaces.has(modelId.slice(0, slash));
}

/**
 * Model tables OUTSIDE the fence that opencodex itself wrote (#511).
 *
 * These are entries from a version that predates the markers (or predates
 * `context_window`). Because they sit outside the fence, `userModelAliases` reserves
 * their aliases as user-owned and the writer routes around them with a `-2` suffix — so
 * every sync adds a CORRECT duplicate and never removes the stale original. Grok then
 * resolves the original, finds no `context_window`, and falls back to its own 200k.
 *
 * Ownership is CONJUNCTIVE and deliberately strict, because a false positive deletes a
 * hand-written user model. The public manual recipe intentionally uses the same loopback key,
 * endpoint, and Responses backend, so those fields are not ownership proof. We additionally
 * require either the durable generated marker or the exact pre-marker legacy fingerprint:
 *   - a plain `[model.x]` header (never `[[model.x]]` / `[model.x.sub]` — those spellings
 *     mark human authorship and stay reserved);
 *   - `api_key` equal to our own literal;
 *   - a loopback `base_url`, so an entry that merely copied our key while pointing at a
 *     remote host is left alone.
 *   - `x-opencodex-grok = "1"` in generated inline/child extra_headers, OR the historical
 *     chat_completions + `name = "OCX <model>"` + deterministic generated alias shape.
 *   - PROVIDER-INHERITANCE shape: `model_provider = "opencodex"` with no api_key/base_url of
 *     its own, adopting the verdict of the `[model_providers.opencodex]` table it references
 *     (the current block shape carries no per-model evidence; this mirrors Codex-side
 *     classifyCodexRouting).
 * A loopback base_url ALONE is not enough: aiming your own model at the local proxy is a
 * legitimate thing to do.
 *
 * Also sweeps orphaned `[model_providers.opencodex]` blocks from a previous managed block
 * that used the provider-inheritance shape. Grok's re-serializer promotes the inline
 * `extra_headers = { ... }` into a separate `[model_providers.<id>.extra_headers]`
 * sub-table, which can split the parent's body (its own keys then live inside the child's
 * span) and may interleave user tables between the parent and its children, so each
 * provider's body is FOLDED with all its same-provider descendants before judging, and
 * the removal span covers them by their exact ranges. The fenced provider is excluded
 * from that sweep (the splice owns it) but still counts as ownership evidence, so
 * teardown does not orphan models that inherit from it. The
 * durable marker lives on the provider (never on the inheriting model), so the sweep is
 * what keeps explicit ownership of inherited entries verifiable after a rewrite.
 */
function findOpencodexOrphans(content: string, region: ManagedRegion | null): OrphanTable[] {
  const orphans: OrphanTable[] = [];
  // A pre-fence orphan's body must stop AT the fence. The managed block opens with a
  // COMMENT, not a table header, so a span that runs to "the next table header" swallows
  // the BEGIN marker whenever no other table separates them — and removing the orphan then
  // deletes the fence opener itself, which strands the END marker and makes every later
  // sync re-append a block (the #511 duplicate loop, one layer down).
  // `region` is null ONLY when BEGIN_MARKER is absent (see findManagedRegion), so -1
  // disables the clamp for marker-less files without a redundant scan.
  const fenceStart = region ? region.start : -1;
  const clampEnd = (start: number, end: number): number =>
    fenceStart >= 0 && start < fenceStart ? Math.min(end, fenceStart) : end;
  // Collect every table header first: a table body runs to the NEXT header, whatever it is.
  const headers = analyzeTomlStructure(content).headers;
  // [model_providers.<id>] tables outside the fence, folded with their own sub-tables (see
  // the function doc). A table passing the predicate (our api_key literal + a loopback
  // base_url + the durable marker inline or in a re-serialized child) contributes to
  // `ownedProviderIds` for the model scan below; one with OUR id is additionally swept as
  // an orphan of a previous managed block (a leftover here collides with the regenerated
  // block's provider table — duplicate key — and alias rewriting skips provider orphans
  // because they have no alias and no model id). The dot-terminated prefix keeps a user's
  // `[model_providers.opencodex_backup]` out of scope.
  const ownedProviderIds = new Set<string>();
  for (const [position, header] of headers.entries()) {
    if (header.array || header.segments.length !== 2 || header.segments[0] !== "model_providers") continue;
    // Inside the fence the regular splice owns the table, but it is still ownership
    // evidence: models kept outside the fence after a Grok rewrite (retired ids) inherit
    // their verdict from the fenced provider, so classification must happen while the
    // fence still exists or teardown leaves them with a dangling model_provider reference.
    const insideRegion = region !== null
      && header.index >= region.start && header.index < region.end;
    const end = clampEnd(header.index, headers[position + 1]?.index ?? content.length);
    let body = content.slice(header.index + header.length, end);
    // Re-serialized children may sit non-contiguously (a user table can interleave), so
    // fold every same-provider descendant globally, like the model scan below, and remove
    // them by their exact ranges. Never fold across the fence: a pre-fence parent must
    // judge on pre-fence bytes only, and fenced or below-fence content is not the orphan's.
    const additionalRanges: Array<{ start: number; end: number }> = [];
    for (let next = 0; next < headers.length; next += 1) {
      if (next === position) continue;
      const child = headers[next]!;
      if (region && child.index >= region.start && child.index < region.end) continue;
      if (fenceStart >= 0
        && (header.index < fenceStart) !== (child.index < fenceStart)) continue;
      if (child.segments.length <= 2
        || child.segments[0] !== "model_providers"
        || child.segments[1] !== header.segments[1]) continue;
      const childEnd = clampEnd(child.index, headers[next + 1]?.index ?? content.length);
      body += "\n" + content.slice(child.index + child.length, childEnd);
      additionalRanges.push({ start: child.index, end: childEnd });
    }
    const keys = tableBodyKeys(body);
    if (keys.get("api_key") !== OPENCODEX_API_KEY) continue;
    if (!isLoopbackBaseUrl(keys.get("base_url"))) continue;
    // The durable marker may sit inline on the provider, or be promoted by Grok's
    // re-serializer into `[model_providers.<id>.extra_headers]` — where the folded body
    // shows it as a bare `x-opencodex-grok = "1"` assignment. Both forms decide.
    if (!hasInlineOwnershipMarker(keys.get("extra_headers"))
      && keys.get(OPENCODEX_GROK_MARKER) !== "1") continue;
    ownedProviderIds.add(header.segments[1]!);
    if (insideRegion) continue;
    if (header.segments[1] === OPENCODEX_PROVIDER_ID) {
      orphans.push({
        alias: "",
        modelId: "",
        ownership: "explicit",
        start: header.index,
        end,
        additionalRanges,
      });
    }
  }
  for (const [position, header] of headers.entries()) {
    if (header.array || header.segments.length !== 2 || header.segments[0] !== "model") continue;
    // Inside the fence the regular splice already owns it.
    if (region && header.index >= region.start && header.index < region.end) continue;
    const bodyEnd = clampEnd(header.index, headers[position + 1]?.index ?? content.length);
    const keys = tableBodyKeys(content.slice(header.index + header.length, bodyEnd));
    const modelId = keys.get("model");
    if (!modelId) continue;
    // Two shapes carry our ownership signal. The current managed block routes every model
    // through a shared provider table (`model_provider = "opencodex"`), so a re-serialized
    // unfenced entry has NO api_key/base_url of its own — the evidence lives on the provider
    // table it references (Codex-side precedent: classifyCodexRouting follows model_provider
    // for the same reason). Inheritance is accepted only from a provider that itself passed
    // the strict predicate above, and only for rows whose alias carries the generated
    // fingerprint: a user is free to reference the managed provider from their own
    // [model.*] table, and inheritance alone must not grant removal authority over it.
    const providerId = keys.get("model_provider");
    const inheritedOwned =
      providerId === OPENCODEX_PROVIDER_ID
      && ownedProviderIds.has(OPENCODEX_PROVIDER_ID)
      && isGeneratedAliasForModel(header.segments[1]!, modelId);
    if (!inheritedOwned) {
      if (keys.get("api_key") !== OPENCODEX_API_KEY) continue;
      if (!isLoopbackBaseUrl(keys.get("base_url"))) continue;
    }
    let hasOwnershipMarker = hasInlineOwnershipMarker(keys.get("extra_headers"));
    // Swallow the entry's OWN sub-tables (`[model.<alias>.extra_headers]`, and after #1756
    // `[[model.<alias>.reasoning_efforts]]`). Grok may re-serialize them non-contiguously,
    // so collect exact descendant spans globally rather than stopping at the first
    // unrelated table.
    const additionalRanges: Array<{ start: number; end: number }> = [];
    for (let next = 0; next < headers.length; next += 1) {
      if (next === position) continue;
      const child = headers[next]!;
      if (region && child.index >= region.start && child.index < region.end) continue;
      if (child.segments.length <= 2
        || child.segments[0] !== "model"
        || child.segments[1] !== header.segments[1]) continue;
      const childEnd = clampEnd(child.index, headers[next + 1]?.index ?? content.length);
      additionalRanges.push({ start: child.index, end: childEnd });
      if (!child.array && child.segments.length === 3 && child.segments[2] === "extra_headers") {
        const childKeys = tableBodyKeys(content.slice(child.index + child.length, childEnd));
        if (childKeys.get(OPENCODEX_GROK_MARKER) === "1") hasOwnershipMarker = true;
      }
    }
    const legacyGenerated = isLegacyGeneratedTable(header.segments[1]!, keys);
    // An inherited model has no per-model marker; its verdict comes from the provider
    // table it references, which only lands here when that provider proved durable
    // ownership. A legacy-fingerprint model keeps dev's conservative classification.
    const ownership: "explicit" | "legacy" = inheritedOwned || hasOwnershipMarker
      ? "explicit"
      : "legacy";
    if (!hasOwnershipMarker && !legacyGenerated && !inheritedOwned) continue;
    orphans.push({
      alias: header.segments[1]!,
      modelId,
      ownership,
      start: header.index,
      end: bodyEnd,
      additionalRanges,
    });
  }
  return orphans;
}

function orphanRanges(orphans: readonly OrphanTable[]): Array<{ start: number; end: number }> {
  const unique = new Map<string, { start: number; end: number }>();
  for (const orphan of orphans) {
    for (const range of [{ start: orphan.start, end: orphan.end }, ...orphan.additionalRanges]) {
      unique.set(`${range.start}:${range.end}`, range);
    }
  }
  return [...unique.values()];
}

/** Remove exact whole-table ranges, back to front so earlier offsets stay valid. */
function removeTableRanges(content: string, ranges: readonly { start: number; end: number }[]): string {
  let next = content;
  const unique = new Map(ranges.map(range => [`${range.start}:${range.end}`, range]));
  for (const range of [...unique.values()].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, range.start) + next.slice(range.end);
  }
  return next;
}

function removeOrphanTables(content: string, orphans: OrphanTable[]): string {
  return removeTableRanges(content, orphanRanges(orphans));
}

/** Model aliases and routed ids owned by one complete managed region. */
function managedModelAliases(content: string, region: ManagedRegion | null): Map<string, string> {
  const models = new Map<string, string>();
  if (!region) return models;
  const structure = analyzeTomlStructure(content);
  for (const [position, header] of structure.headers.entries()) {
    if (header.array || header.segments.length !== 2 || header.segments[0] !== "model") continue;
    if (header.index < region.start || header.index >= region.end) continue;
    const bodyEnd = Math.min(structure.headers[position + 1]?.index ?? content.length, region.end);
    const modelId = tableBodyKeys(content.slice(header.index + header.length, bodyEnd)).get("model");
    if (modelId !== undefined) models.set(header.segments[1]!, modelId);
  }
  return models;
}

/** Read one exact path from an already parsed TOML document. */
type TomlPathSegment = string | number;

function tomlPathString(document: unknown, path: readonly TomlPathSegment[]): string | null {
  let value = document;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(value)) return null;
      value = value[segment];
    } else {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
      value = (value as Record<string, unknown>)[segment];
    }
  }
  return typeof value === "string" ? value : null;
}

/** Parse a probe document and read one exact semantic path. */
function parsedTomlPathString(content: string, path: readonly TomlPathSegment[]): string | null {
  try {
    return tomlPathString(Bun.TOML.parse(content), path);
  } catch {
    return null;
  }
}

type ModelReferencePatternSegment = string | "*";

interface ModelReferencePath {
  path: readonly ModelReferencePatternSegment[];
  /** A structured reference assignment that can be removed whole without losing sibling config. */
  removableContainerPath?: readonly string[];
}

/** Grok config values whose strings resolve through the `[model.<alias>]` catalog. */
const MODEL_REFERENCE_PATHS: readonly ModelReferencePath[] = [
  { path: ["models", "default"] },
  { path: ["models", "web_search"] },
  { path: ["models", "session_summary"] },
  { path: ["models", "image_description"] },
  { path: ["models", "prompt_suggestion"] },
  { path: ["ui", "fork_secondary_model"] },
  { path: ["subagents", "models", "*"] },
  { path: ["subagents", "roles", "*", "model"] },
  { path: ["subagents", "personas", "*", "model"] },
  { path: ["auto_mode", "classifier_model"] },
  {
    path: ["goal", "planner_model", "model"],
    removableContainerPath: ["goal", "planner_model"],
  },
  {
    path: ["goal", "strategist_model", "model"],
    removableContainerPath: ["goal", "strategist_model"],
  },
  {
    path: ["goal", "skeptic_models", "*", "model"],
    removableContainerPath: ["goal", "skeptic_models"],
  },
];

interface AliasReference {
  path: TomlPathSegment[];
  alias: string;
  removableContainerPath?: readonly string[];
}

function collectAliasReferences(document: unknown): AliasReference[] {
  const references: AliasReference[] = [];
  const visit = (
    value: unknown,
    pattern: readonly ModelReferencePatternSegment[],
    patternIndex: number,
    path: TomlPathSegment[],
    removableContainerPath: readonly string[] | undefined,
  ): void => {
    if (patternIndex === pattern.length) {
      if (typeof value === "string") {
        references.push({
          path,
          alias: value,
          ...(removableContainerPath ? { removableContainerPath } : {}),
        });
      }
      return;
    }
    const segment = pattern[patternIndex]!;
    if (segment === "*") {
      if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
          visit(item, pattern, patternIndex + 1, [...path, index], removableContainerPath);
        }
      } else if (typeof value === "object" && value !== null) {
        for (const [key, item] of Object.entries(value)) {
          visit(item, pattern, patternIndex + 1, [...path, key], removableContainerPath);
        }
      }
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    visit(
      (value as Record<string, unknown>)[segment],
      pattern,
      patternIndex + 1,
      [...path, segment],
      removableContainerPath,
    );
  };

  for (const reference of MODEL_REFERENCE_PATHS) {
    visit(document, reference.path, 0, [], reference.removableContainerPath);
  }
  return references;
}

function sourcePath(path: readonly TomlPathSegment[]): string[] {
  return path.filter((segment): segment is string => typeof segment === "string");
}

function pathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function pathStartsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return path.length >= prefix.length
    && prefix.every((segment, index) => segment === path[index]);
}

function tomlContainerStringSpans(
  content: string,
  start: number,
  end: number,
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (let index = start + 1; index < end - 1;) {
    const char = content[index]!;
    if (char === "#") {
      const newline = content.indexOf("\n", index);
      index = newline === -1 || newline >= end ? end : newline + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const span = tomlStringSpanAt(content, index);
      if (span === null || span.end > end) return [];
      spans.push({ start: index, end: span.end });
      index = span.end;
      continue;
    }
    index += 1;
  }
  return spans;
}

interface AliasReferenceCandidate {
  valueStart: number;
  valueEnd: number;
  assignmentPath: string[];
  directLine: { start: number; end: number } | null;
  containerLine: { start: number; end: number } | null;
}

/** Rename or remove every declared semantic model reference without touching user prose. */
function transformAliasReferences(
  content: string,
  replacements: ReadonlyMap<string, string | null>,
  allowRootDotted = true,
): string {
  if (replacements.size === 0) return content;
  let document: unknown;
  try {
    document = Bun.TOML.parse(content);
  } catch {
    throw new Error(
      "Grok config rewrite refused: Bun could not parse the TOML document safely.",
    );
  }
  const references = collectAliasReferences(document);
  const targets = references.filter(reference => replacements.has(reference.alias));
  if (targets.length === 0) return content;
  const structure = analyzeTomlStructure(content);
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const candidates: AliasReferenceCandidate[] = [];
  const assignment = new RegExp(String.raw`^([ \t]*(${DOTTED_KEY})[ \t]*=)`, "gm");
  let headerPosition = -1;
  for (const match of structure.view.matchAll(assignment)) {
    const assignmentStart = match.index!;
    if (!structure.containerRootLineStarts.has(assignmentStart)) continue;
    while ((structure.headers[headerPosition + 1]?.index ?? Number.POSITIVE_INFINITY)
      < assignmentStart) headerPosition += 1;
    const currentHeader = headerPosition >= 0 ? structure.headers[headerPosition]! : null;
    if (!allowRootDotted && currentHeader === null) continue;
    const segments = canonicalDottedKey(match[2]!);
    const assignmentPath = [...(currentHeader?.segments ?? []), ...segments];
    let valueStart = assignmentStart + match[1]!.length;
    while (content[valueStart] === " " || content[valueStart] === "\t") valueStart += 1;
    const directTargets = targets.filter(target => pathsEqual(sourcePath(target.path), assignmentPath));
    if (directTargets.length > 0) {
      const value = tomlStringSpanAt(content, valueStart);
      if (value !== null) {
        const suffix = /^[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/.exec(content.slice(value.end));
        if (suffix !== null) {
          candidates.push({
            valueStart,
            valueEnd: value.end,
            assignmentPath,
            directLine: { start: assignmentStart, end: value.end + suffix[0].length },
            containerLine: null,
          });
          continue;
        }
      }
    }

    const containerTargets = targets.filter(target =>
      pathStartsWith(sourcePath(target.path), assignmentPath));
    if (containerTargets.length === 0 || (content[valueStart] !== "{" && content[valueStart] !== "[")) continue;
    const containerEnd = tomlContainerEnd(content, valueStart);
    if (containerEnd === null) continue;
    const suffix = /^[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/.exec(content.slice(containerEnd));
    if (suffix === null) continue;
    const containerLine = { start: assignmentStart, end: containerEnd + suffix[0].length };
    for (const value of tomlContainerStringSpans(content, valueStart, containerEnd)) {
      candidates.push({
        valueStart: value.start,
        valueEnd: value.end,
        assignmentPath,
        directLine: null,
        containerLine,
      });
    }
  }

  for (const [targetIndex, target] of targets.entries()) {
    const replacement = replacements.get(target.alias)!;
    const targetSourcePath = sourcePath(target.path);
    const probeCandidates = candidates.filter(candidate =>
      pathsEqual(candidate.assignmentPath, targetSourcePath)
      || pathStartsWith(targetSourcePath, candidate.assignmentPath));
    if (probeCandidates.length === 0 && !allowRootDotted) continue;
    if (probeCandidates.length === 0 || probeCandidates.length > 128) {
      throw new Error(
        "Grok config rewrite refused: the model-reference source could not be bounded safely.",
      );
    }
    let located = false;
    for (const candidate of probeCandidates) {
      let sentinel = `__opencodex_reference_probe_${targetIndex}_${candidate.valueStart}__`;
      while (sentinel === target.alias) sentinel += "_";
      const probe = content.slice(0, candidate.valueStart)
        + tomlString(sentinel)
        + content.slice(candidate.valueEnd);
      if (parsedTomlPathString(probe, target.path) !== sentinel) continue;
      if (replacement === null) {
        let removal = candidate.directLine;
        if (removal === null && candidate.containerLine !== null
          && target.removableContainerPath
          && pathsEqual(candidate.assignmentPath, target.removableContainerPath)) {
          const containerReferences = references.filter(reference =>
            pathStartsWith(sourcePath(reference.path), candidate.assignmentPath));
          if (containerReferences.length > 0
            && containerReferences.every(reference => replacements.get(reference.alias) === null)) {
            removal = candidate.containerLine;
          }
        }
        if (removal === null) {
          throw new Error(
            "Grok teardown refused: a model reference uses an inline TOML shape that cannot "
            + "be removed without rewriting user-owned bytes.",
          );
        }
        edits.push({ start: removal.start, end: removal.end, replacement: "" });
      } else {
        edits.push({
          start: candidate.valueStart,
          end: candidate.valueEnd,
          replacement: tomlString(replacement),
        });
      }
      located = true;
      break;
    }
    if (!located) {
      throw new Error(
        "Grok config rewrite refused: the semantic model reference could not be located safely.",
      );
    }
  }
  let next = content;
  const uniqueEdits = new Map(edits.map(edit => [`${edit.start}:${edit.end}:${edit.replacement}`, edit]));
  for (const edit of [...uniqueEdits.values()].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
  }
  return next;
}

/** Repoint references at whichever alias survived orphan adoption, or remove them. */
function rewriteAliasReferences(content: string, replacements: Map<string, string | null>): string {
  return transformAliasReferences(content, replacements);
}

/** Remove only references that name model aliases teardown actually swept. */
function removeAliasReferences(
  content: string,
  removedAliases: ReadonlySet<string>,
  allowRootDotted = true,
): string {
  return transformAliasReferences(
    content,
    new Map([...removedAliases].map(alias => [alias, null] as const)),
    allowRootDotted,
  );
}

function orphanedMarkerResult(action: string): GrokInjectResult {
  return {
    ok: false,
    changed: false,
    message: `Grok config ${action} refused: found the opencodex begin marker without its end marker. `
      + "The managed region boundary is ambiguous, so nothing was modified. "
      + "Repair ~/.grok/config.toml manually (see config.toml.bak-opencodex) and re-run.",
    skippedReason: "orphaned-marker",
  };
}

function copyBackupOnce(configPath: string, backupPath: string): void {
  if (existsSync(backupPath)) return;
  try {
    copyFileSync(configPath, backupPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
}

function errorResult(action: string, error: unknown): GrokInjectResult {
  const detail = error instanceof Error ? error.message : String(error);
  return { ok: false, changed: false, message: `Could not ${action} Grok config: ${detail}` };
}

export function buildGrokManagedBlock(
  port: number,
  models: GrokInjectModel[],
  hostname?: string,
  reservedAliases?: ReadonlySet<string>,
  /**
   * Ids to allocate an alias for but NOT emit. Alias numbering must not depend on which
   * models the user switched off, or excluding one colliding model would rename another
   * model's alias out from under a grok config that already uses it.
   */
  excluded?: ReadonlySet<string>,
): string {
  const host = providerBaseHost(hostname);
  const baseUrl = `http://${host}:${port}/v1`;
  const lines = [
    BEGIN_MARKER,
    "",
    `[model_providers.${OPENCODEX_PROVIDER_ID}]`,
    `base_url = ${tomlString(baseUrl)}`,
    'api_backend = "responses"',
    'api_key = "opencodex-loopback"',
    // Best-effort attribution tag for the usage dashboard. Upstream Grok sends
    // extra_headers verbatim on inference calls (11-custom-models.md). This is NOT a
    // security boundary — any loopback client could send the same header.
    'extra_headers = { "x-opencodex-grok" = "1" }',
  ];
  const aliasCounts = new Map<string, number>();
  const taken = new Set(reservedAliases ?? []);

  for (const model of models) {
    const baseAlias = `ocx-${model.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
    let count = (aliasCounts.get(baseAlias) ?? 0) + 1;
    let alias = count === 1 ? baseAlias : `${baseAlias}-${count}`;
    // User-owned [model.<alias>] tables outside the fence are reserved: emitting a
    // duplicate table header would make the whole TOML invalid for grok.
    while (taken.has(alias)) {
      count += 1;
      alias = `${baseAlias}-${count}`;
    }
    aliasCounts.set(baseAlias, count);
    taken.add(alias);
    // Slot consumed, table not written: this is what keeps every other alias stable
    // across selection changes.
    if (excluded?.has(model.id)) continue;
    lines.push(
      "",
      `[model.${alias}]`,
      `model = ${tomlString(model.id)}`,
      `model_provider = ${tomlString(OPENCODEX_PROVIDER_ID)}`,
      `name = ${tomlString(model.name ?? `OCX ${model.id}`)}`,
    );
    if (Number.isFinite(model.contextWindow) && (model.contextWindow ?? 0) > 0) {
      lines.push(`context_window = ${model.contextWindow}`);
    }
    // Array-of-tables MUST follow every parent keyval (including inline extra_headers).
    // Keep every picker option inside Grok's accepted CLI vocabulary; ultra is Codex-only.
    const efforts = sanitizeGrokReasoningEfforts(model.reasoningEfforts);
    const defaultEffort = grokDefaultReasoningEffort(efforts, model.defaultReasoningEffort);
    if (defaultEffort !== undefined) {
      lines.push(
        "supports_reasoning_effort = true",
        `reasoning_effort = ${tomlString(defaultEffort)}`,
      );
      for (const effort of efforts) {
        const option = grokReasoningEffortOption(effort, effort === defaultEffort);
        lines.push(
          "",
          `[[model.${alias}.reasoning_efforts]]`,
          `id = ${tomlString(option.id)}`,
          `value = ${tomlString(option.value)}`,
          `label = ${tomlString(option.label)}`,
          `description = ${tomlString(option.description)}`,
          `default = ${option.default}`,
        );
      }
    }
  }

  lines.push(END_MARKER);
  return lines.join("\n");
}

export function injectGrokConfig(
  port: number,
  models: GrokInjectModel[],
  opts: {
    grokHome?: string;
    hostname?: string;
    excluded?: ReadonlySet<string>;
    /** Unfiltered known ids used only to distinguish hidden current models from retired ones. */
    catalogModelIds?: ReadonlySet<string>;
    /** Canonical provider keys disabled in config and therefore absent from catalog fetching. */
    disabledProviderNamespaces?: ReadonlySet<string>;
    /** Configured combo public ids that may syntactically resemble provider/model ids. */
    comboPublicModelIds?: ReadonlySet<string>;
  } = {},
): GrokInjectResult {
  const grokHome = resolveGrokHome(opts.grokHome);
  if (!isDirectory(grokHome)) {
    return {
      ok: true,
      changed: false,
      message: `Grok home not found at ${grokHome}; config injection skipped.`,
      skippedReason: "no-grok-home",
    };
  }

  // Non-loopback binds require the real admission token (src/server/auth-cors.ts), and there is
  // no safe way for a REGENERATED block to carry it: a literal token would write the user's
  // secret into their own file and overwrite it on every start/ensure/restart, while omitting
  // api_key in favour of env_key opens grok's credential fallthrough — with no `model_provider`
  // to fail closed, an unresolved env_key makes grok send its xAI session bearer to our
  // plaintext LAN endpoint (upstream config.rs resolve_credentials). So we do not auto-register
  // at all here; the user configures models manually, outside our fence, where nothing we do
  // can clobber their credential.
  if (!isLoopbackHostname(opts.hostname)) {
    const removed = stripGrokConfig({ ...(opts.grokHome !== undefined ? { grokHome: opts.grokHome } : {}) });
    const cleanup = removed.changed
      ? " Removed the previously generated block, which pointed at a loopback address."
      : "";
    return {
      ok: true, // a deliberate policy skip, not a failure — it must never block startup
      changed: removed.changed,
      skippedReason: "non-loopback",
      message: `Grok auto-registration skipped: opencodex is bound to the non-loopback host `
        + `"${opts.hostname}", where requests need your admission token. A managed block would `
        + `either store that secret in ~/.grok/config.toml or overwrite it on the next start, so `
        + `add the models yourself OUTSIDE the opencodex markers (see the Grok Build guide).${cleanup}`,
    };
  }

  const configPath = join(grokHome, "config.toml");
  const backupPath = join(grokHome, "config.toml.bak-opencodex");
  try {
    const configExisted = existsSync(configPath);
    const rawContent = configExisted ? readFileSync(configPath, "utf8") : "";
    const eol = dominantEol(rawContent);
    const originalContent = applyEol(rawContent, "\n");
    const originalRegion = findManagedRegion(originalContent);
    // Ambiguous fence: refuse before the sweep, or "outside the region" could mean the
    // entire file.
    if (originalRegion?.orphaned) return orphanedMarkerResult("injection");
    const previousManagedModels = managedModelAliases(originalContent, originalRegion);

    // Adopt our own pre-fence entries (#511) BEFORE reserving user aliases, so the stale
    // duplicate is replaced instead of routed around forever. Runs inside the normalized
    // window so the user's dominant EOL is still restored below.
    // Durably marked rows use the full UNFILTERED catalog: explicitly excluded and otherwise
    // hidden current models must still lose stale generated tables. Ambiguous pre-marker legacy
    // rows are migrated only when this write emits their replacement. Direct callers that do not
    // have a separate catalog keep the historical `models` behavior.
    const catalogModelIds = opts.catalogModelIds ?? new Set(models.map(model => model.id));
    const emittedModelIds = new Set(models
      .filter(model => !opts.excluded?.has(model.id))
      .map(model => model.id));
    const orphans = findOpencodexOrphans(originalContent, originalRegion)
      .filter(orphan =>
        // A provider table carries no alias and no model id: its strict predicate (our key
        // + loopback + durable marker) is itself the deletion authority, and a leftover
        // collides with the regenerated provider table (duplicate key).
        orphan.alias === ""
        || (orphan.ownership === "legacy"
          // A legacy fingerprint is not durable deletion authority. Migrate it only when this
          // same write will replace the row with a marked managed table.
          ? emittedModelIds.has(orphan.modelId)
          : catalogModelIds.has(orphan.modelId)
            || isDisabledProviderModelId(
              orphan.modelId,
              opts.disabledProviderNamespaces,
              opts.comboPublicModelIds,
            )));
    const content = removeOrphanTables(originalContent, orphans);
    // Removing bytes above the fence MOVES it: recompute rather than adjust arithmetic,
    // so the splice below cannot cut the file in the wrong place.
    const region = orphans.length > 0 ? findManagedRegion(content) : originalRegion;

    const block = buildGrokManagedBlock(port, models, opts.hostname, userModelAliases(content, region), opts.excluded);
    let nextContent: string;
    if (region) {
      nextContent = content.slice(0, region.start) + block + content.slice(region.end);
    } else if (content.length === 0) {
      nextContent = `${block}\n`;
    } else {
      // Exactly ONE separator newline, always. The old rule ("\n\n" when the file lacked a
      // trailing newline) made two different originals — "X" and "X\n" — produce byte-identical
      // files, so strip could not restore both. One newline keeps injection injective: the
      // user's own terminator is preserved verbatim and strip can undo exactly what we added.
      nextContent = `${content}\n${block}\n`;
    }

    // Repoint every model selector at whichever managed alias survived. Compare both swept
    // out-of-fence tables and the PREVIOUS managed block: ordinary exclusion removes only the
    // latter, so tying cleanup to `orphans` made the #2830 path dead code.
    const nextManagedModels = managedModelAliases(nextContent, findManagedRegion(nextContent));
    const survivors = new Map<string, string>();
    for (const [alias, modelId] of nextManagedModels) {
      if (!survivors.has(modelId)) survivors.set(modelId, alias);
    }
    const replacements = new Map<string, string | null>();
    for (const removed of [
      // Provider orphans carry no alias and no model id: there is nothing to repoint, and
      // an empty alias must never enter the rename map.
      ...orphans.filter(orphan => orphan.alias !== "")
        .map(orphan => ({ alias: orphan.alias, modelId: orphan.modelId })),
      ...[...previousManagedModels].map(([alias, modelId]) => ({ alias, modelId })),
    ]) {
      if (nextManagedModels.get(removed.alias) === removed.modelId) continue;
      const replacement = survivors.get(removed.modelId) ?? null;
      if (replacement !== removed.alias) replacements.set(removed.alias, replacement);
    }
    nextContent = rewriteAliasReferences(nextContent, replacements);

    const output = applyEol(nextContent, eol);
    if (output === rawContent) {
      return { ok: true, changed: false, message: "Grok config already contains the current opencodex managed block." };
    }
    // Back up before a first-time fence write AND before any sweep, since adopting an orphan
    // deletes a table the user has in their file. Previously the adjacent-orphan layout got a
    // backup only as a side effect of the fence being destroyed (which made `region` falsy);
    // preserving the fence must not silently drop that safety net.
    if (configExisted && (!region || orphans.length > 0)) copyBackupOnce(configPath, backupPath);
    atomicWriteFile(configPath, output);
    return {
      ok: true,
      changed: true,
      message: region
        ? "Updated the opencodex managed block in Grok config."
        : "Added the opencodex managed block to Grok config.",
    };
  } catch (error) {
    return errorResult("inject", error);
  }
}

export function stripGrokConfig(opts: { grokHome?: string } = {}): GrokInjectResult {
  const grokHome = resolveGrokHome(opts.grokHome);
  if (!isDirectory(grokHome)) {
    return {
      ok: true,
      changed: false,
      message: `Grok home not found at ${grokHome}; no managed config to remove.`,
      skippedReason: "no-grok-home",
    };
  }

  const configPath = join(grokHome, "config.toml");
  if (!existsSync(configPath)) {
    return { ok: true, changed: false, message: "Grok config not found; no managed block to remove." };
  }

  try {
    const rawContent = readFileSync(configPath, "utf8");
    const eol = dominantEol(rawContent);
    const content = applyEol(rawContent, "\n");
    const originalRegion = findManagedRegion(content);
    if (originalRegion?.orphaned) return orphanedMarkerResult("cleanup");

    // Remove the fence against its ORIGINAL offsets first. A pre-fence orphan's span is clamped
    // at the fence start and can include the separator newline injection added. Sweeping that
    // orphan first and then applying this separator undo would remove one additional USER newline.
    let stripped: string;
    let orphanCount = 0;
    if (originalRegion) {
      const fullOrphans = findOpencodexOrphans(content, originalRegion)
        .filter(orphan => orphan.ownership === "explicit");
      let removalEnd = originalRegion.end;
      if (content.startsWith("\n", removalEnd)) removalEnd += 1;
      let prefix = content.slice(0, originalRegion.start);
      const restOfFile = content.slice(removalEnd);
      // Undo the single separator newline injection added. Two cases, mirroring inject:
      //   "X\n"  -> "X\n" + "\n" + block  => prefix ends "\n\n", drop one.
      //   "X"    -> "X"   + "\n" + block  => prefix ends "\n" at EOF, drop it.
      // A block the user has appended content after is left alone: we never shrink their bytes.
      if (prefix.endsWith("\n\n")) prefix = prefix.slice(0, -1);
      else if (restOfFile.length === 0 && prefix.endsWith("\n")) prefix = prefix.slice(0, -1);
      // Keep the old fence boundary while sweeping. Concatenating first would let the last
      // pre-fence orphan absorb comment-only or bare-key user content appended after the fence.
      const prefixOrphans = findOpencodexOrphans(prefix, null)
        .filter(orphan => orphan.ownership === "explicit");
      const tailOrphans = findOpencodexOrphans(restOfFile, null)
        .filter(orphan => orphan.ownership === "explicit");
      const removedAliases = new Set(
        [...fullOrphans, ...prefixOrphans, ...tailOrphans]
          .map(orphan => orphan.alias)
          // Provider orphans carry no alias; their ranges above already removed the table.
          .filter(alias => alias !== ""),
      );
      // The backup must cover every removed TABLE, not just aliased rows: provider-only
      // orphans carry no alias and would otherwise be swept without any backup.
      orphanCount = new Set(
        [...fullOrphans, ...prefixOrphans, ...tailOrphans]
          .flatMap(orphan => orphanRanges([orphan])),
      ).size;
      const fullRanges = orphanRanges(fullOrphans);
      const prefixRanges = [
        ...orphanRanges(prefixOrphans),
        ...fullRanges.filter(range => range.end <= originalRegion.start),
      ];
      const tailRanges = [
        ...orphanRanges(tailOrphans),
        ...fullRanges
          .filter(range => range.start >= removalEnd)
          .map(range => ({ start: range.start - removalEnd, end: range.end - removalEnd })),
      ];
      // Preserve the original fence as a structural boundary while cleaning references too.
      // Joining first can re-parent a headerless tail under the last table in `prefix`.
      stripped = removeAliasReferences(
        removeTableRanges(prefix, prefixRanges),
        removedAliases,
      ) + removeAliasReferences(
        removeTableRanges(restOfFile, tailRanges),
        removedAliases,
        false,
      );
    } else {
      // Retired or otherwise non-emitted OpenCodex tables may intentionally remain outside the
      // fence while the integration is enabled. Teardown owns those strictly identified tables
      // even after Grok has re-serialized the file and dropped our marker comments.
      const orphans = findOpencodexOrphans(content, null)
        .filter(orphan => orphan.ownership === "explicit");
      if (orphans.length === 0) {
        return { ok: true, changed: false, message: "No opencodex managed block found in Grok config." };
      }
      orphanCount = orphans.length;
      stripped = removeOrphanTables(content, orphans);
      stripped = removeAliasReferences(
        stripped,
        new Set(orphans.map(orphan => orphan.alias).filter(alias => alias !== "")),
      );
    }
    if (orphanCount > 0) copyBackupOnce(configPath, join(grokHome, "config.toml.bak-opencodex"));
    atomicWriteFile(configPath, applyEol(stripped, eol));

    return {
      ok: true,
      changed: true,
      message: originalRegion
        ? "Removed the opencodex managed block from Grok config."
        : "Removed stale opencodex-managed model entries from Grok config.",
    };
  } catch (error) {
    return errorResult("strip", error);
  }
}
/** Decode a TOML basic-string body: JSON-compatible escapes plus TOML's \uXXXX / \UXXXXXXXX. */
function decodeTomlBasicString(body: string): string {
  return body.replace(
    /\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g,
    (whole, esc: string) => {
      if (esc[0] === "u") return String.fromCharCode(parseInt(esc.slice(1), 16));
      if (esc[0] === "U") {
        const code = parseInt(esc.slice(1), 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      switch (esc) {
        case "b": return "\b";
        case "t": return "\t";
        case "n": return "\n";
        case "f": return "\f";
        case "r": return "\r";
        case '"': return '"';
        case "\\": return "\\";
        default: return whole; // invalid escape — keep raw, reservation stays conservative
      }
    },
  );
}
