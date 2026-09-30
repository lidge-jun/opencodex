// Holds INV-TOML-01 from structure/overview.md; keep the id here if this file is split or renamed.
import { existsSync, readFileSync } from "node:fs";
import { contextCompatibleBaseLine } from "../context-compat";
import { resolveEffectiveProjectModelProvider } from "../project-config-warnings";
import {
  OCX_ROUTING_MARKER_LINE,
  REALTIME_WS_BASE_URL_KEY,
  isOcxRoutingMarkerLine,
  isRootOpenaiBaseUrlLine,
  isRootRealtimeWsBaseUrlLine,
  providerTableStart,
  providerTableString,
  rootTomlString,
} from "../injected-marker";
import {
  CODEX_CONFIG_PATH,
  DEFAULT_CATALOG_PATH,
  resolveCodexConfigPath,
  tomlString,
} from "../paths";
import { normalizeStructuralWhitespace, rootAssignmentKey, rootSourceLines, sourceAssignment, sourceAssignmentSpan, sourceText, type SourceLine } from "../toml-source-lines";
import { readBoundedCodexConfig } from "./bounded-config-reader";
import {
  type CodexRoutingTarget,
  providerBaseHost,
  routingTargetOrigin,
  usesProviderTable,
  validateCodexRoutingTarget,
} from "./routing-target";

export function externalCodexModelProvider(content: string): string | null {
  const provider = resolveEffectiveProjectModelProvider(content).provider;
  if (!provider || provider === "openai" || provider === "opencodex") return null;
  // A provider table counts as an external owner only when it carries a `base_url` — a
  // gateway names somebody else's endpoint. A base-url-less table is the Codex desktop
  // app's own native-routing placeholder (since app 26.924 each app-managed rewrite
  // writes `model_provider = "custom"` plus such a table, stripping the injected root
  // keys alongside), which re-injects cleanly because the injector strips a root
  // `model_provider` line first. A REAL external provider must carry a base_url.
  if (providerTableStart(content.split("\n"), provider) !== -1 && providerTableString(content, provider, "base_url") === null) {
    return null;
  }
  return provider;
}

/**
 * The ownership answer for read/write paths — inject, sync, connect, restore, and the
 * shutdown gate. It deliberately reads the whole file like Codex does (links included):
 * a large or link-mediated config is still a valid config, and these callers must
 * classify it exactly rather than degrade to "undetermined".
 */
export function currentExternalCodexModelProvider(): string | null {
  if (!existsSync(CODEX_CONFIG_PATH)) return null;
  return externalCodexModelProvider(readFileSync(CODEX_CONFIG_PATH, "utf8"));
}

/**
 * The same ownership answer for read-only observation (the settings GET / poll path),
 * through a bounded read so a special or oversized config.toml cannot stall a request.
 * A present-but-unreadable config throws so the caller reports undetermined ownership
 * instead of "none".
 */
export function observedExternalCodexModelProvider(): string | null {
  const content = readBoundedCodexConfig(CODEX_CONFIG_PATH);
  return content === null ? null : externalCodexModelProvider(content);
}

/**
 * Detect the file's dominant line ending. Structural edits retain physical line endings;
 * the full injection/removal pipeline still normalizes to LF at its boundary and converts
 * back on write so generated blocks do not leave a mixed-EOL file.
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

/** Label Codex shows for the injected provider when the operator has not chosen one. */
export const DEFAULT_CODEX_PROVIDER_DISPLAY_NAME = "OpenCodex Proxy";

/** Longest label accepted, matching the display-label policy used for provider names. */
const MAX_CODEX_PROVIDER_DISPLAY_NAME_LENGTH = 128;

/** Would this label put a control character into config.toml? */
function hasControlCharacter(value: string): boolean {
  // Checked by code point rather than by a control-character regex, which needs a lint
  // suppression this repository's hygiene gate rejects — and which reads no more clearly.
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Which label to write, given whatever the config holds.
 *
 * Presentation only, and deliberately separate from identity: routing resolves through the
 * provider id `opencodex` in the root `model_provider` line and the `[model_providers.opencodex]`
 * header, neither of which is derived from this value. So a rename cannot reroute a thread or
 * orphan a row that already names that id (#4810).
 *
 * Every rejected value falls back to the default rather than being emitted or omitted. Codex
 * refuses to load a provider with no name, so writing a blank one would break the whole config
 * file rather than one thread — strictly worse than the branding it was meant to remove. That is
 * also why there is no way to suppress the field: suppression here means choosing a neutral
 * label. A control character or an over-long value is rejected for the same reason, because
 * `tomlString` would faithfully encode something Codex may still reject.
 */
export function resolveCodexProviderDisplayName(configured?: string): string {
  const trimmed = (configured ?? "").trim();
  if (!trimmed) return DEFAULT_CODEX_PROVIDER_DISPLAY_NAME;
  if (trimmed.length > MAX_CODEX_PROVIDER_DISPLAY_NAME_LENGTH) return DEFAULT_CODEX_PROVIDER_DISPLAY_NAME;
  if (hasControlCharacter(trimmed)) return DEFAULT_CODEX_PROVIDER_DISPLAY_NAME;
  return trimmed;
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

export function buildProviderTableBlockForTarget(
  target: CodexRoutingTarget,
  supportsWebsockets = false,
  displayName?: string,
): string {
  const lines = [
    "",
    OCX_ROUTING_MARKER_LINE,
    "[model_providers.opencodex]",
    `name = ${tomlString(resolveCodexProviderDisplayName(displayName))}`,
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
  return setRootUrl(content, contextCompatibleBaseLine(content, buildOpenaiBaseUrlLine(portOrTarget, hostname)));
}

function ownedRootUrl(lines: SourceLine[], index: number, key: string): boolean {
  return lines[index]!.structural && rootTomlString(lines[index]!.text, key) !== null
    && index > 0 && lines[index - 1]!.structural && isOcxRoutingMarkerLine(lines[index - 1]!.text);
}

function insertRootSourceLines(content: string, added: string[]): string {
  const { bom, lines, rootEnd } = rootSourceLines(content);
  const eol = dominantEol(content);
  if (rootEnd === lines.length) {
    return content.replace(/(?:\r?\n)+$/, "") + eol + added.join(eol) + eol;
  }
  let at = rootEnd;
  while (at > 0 && lines[at - 1]!.structural && lines[at - 1]!.text.trim() === "") at -= 1;
  lines.splice(at, 0, ...added.map(text => ({ text, eol, structural: true })));
  return bom + sourceText(lines);
}

function setRootUrl(content: string, key: string): { content: string; keptUserBaseUrl: boolean } {
  const { bom, lines, rootEnd } = rootSourceLines(content);
  for (let index = 0; index < rootEnd; index++) {
    if (!lines[index]!.structural || !isRootOpenaiBaseUrlLine(lines[index]!.text)) continue;
    if (!ownedRootUrl(lines, index, "openai_base_url")) return { content, keptUserBaseUrl: true };
    lines[index - 1]!.text = OCX_ROUTING_MARKER_LINE;
    lines[index]!.text = key;
    return { content: bom + sourceText(lines), keptUserBaseUrl: false };
  }
  return { content: insertRootSourceLines(content, [OCX_ROUTING_MARKER_LINE, key]), keptUserBaseUrl: false };
}

export function setRootOpenaiBaseUrlForTarget(
  content: string,
  target: CodexRoutingTarget,
): { content: string; keptUserBaseUrl: boolean } {
  return setRootUrl(content, contextCompatibleBaseLine(content, buildOpenaiBaseUrlLineForTarget(target)));
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
  const { bom, lines, rootEnd } = rootSourceLines(content);
  const key = buildRealtimeWsBaseUrlLine(validateCodexRoutingTarget(target));
  for (let index = 0; index < rootEnd; index++) {
    if (!lines[index]!.structural || !isRootRealtimeWsBaseUrlLine(lines[index]!.text)) continue;
    if (!ownedRootUrl(lines, index, REALTIME_WS_BASE_URL_KEY)) return { content, keptUserRealtimeWsBaseUrl: true };
    lines[index - 1]!.text = OCX_ROUTING_MARKER_LINE;
    lines[index]!.text = key;
    return { content: bom + sourceText(lines), keptUserRealtimeWsBaseUrl: false };
  }
  for (let index = 0; index < rootEnd; index++) {
    if (!isRootOpenaiBaseUrlLine(lines[index]!.text) || !ownedRootUrl(lines, index, "openai_base_url")) continue;
    const eol = dominantEol(content);
    lines[index]!.eol ||= eol;
    lines.splice(index + 1, 0, ...[OCX_ROUTING_MARKER_LINE, key].map(text => ({ text, eol, structural: true })));
    return { content: bom + sourceText(lines), keptUserRealtimeWsBaseUrl: false };
  }
  return { content, keptUserRealtimeWsBaseUrl: false };
}

/**
 * Root key codex-rs reads for its web-search mode. The value opencodex writes is the only one that
 * takes the native hosted tool away; the other modes keep it, so they are never written here.
 */
export const ROOT_WEB_SEARCH_KEY = "web_search";

/** The one value opencodex writes for {@link ROOT_WEB_SEARCH_KEY}. */
export const ROOT_WEB_SEARCH_DISABLED_LINE = 'web_search = "disabled"';

/** The value {@link ROOT_WEB_SEARCH_DISABLED_LINE} carries, as the journal records it. */
export const ROOT_WEB_SEARCH_DISABLED_VALUE = "disabled";

export function isRootWebSearchLine(line: string): boolean {
  // Quoted spellings (including escaped basic keys) name the same key to TOML.
  // A predicate that matched only the bare
  // spelling would leave `"web_search" = "live"` in place while inserting our own line, and two
  // root keys of the same name stop Codex from loading the file at all.
  return rootAssignmentKey(line) === ROOT_WEB_SEARCH_KEY;
}

/** What an earlier injection recorded about this key, read back from the journal. */
export interface RootWebSearchJournal {
  /** The value that injection wrote, or null when it wrote none. */
  injectedValue?: string | null;
  /** The complete user-owned assignment removed (possibly multiline), or null. */
  replacedUserLine?: string | null;
}

/** What one pass of {@link ensureRootWebSearchDisabled} did, for the journal to record. */
export interface RootWebSearchOutcome {
  content: string;
  /** The complete user-owned root assignment removed (possibly multiline), or null. */
  replacedUserLine: string | null;
  /** The value this pass wrote, or null when it wrote none. */
  wroteValue: string | null;
}

/**
 * Ensure the root `web_search` key follows the web-search sidecar's master switch.
 *
 * Codex reads this key (modes `disabled`/`cached`/`indexed`/`live`) to decide whether its native
 * Responses `web_search` tool is offered at all; `disabled` is the only mode that removes the tool
 * from the model's tool list. An operator who runs an MCP search server instead needs exactly that,
 * because a native tool the client still advertises wins the model's attention away from the MCP
 * one. So the switch is not advisory: while `webSearchSidecar.enabled` is false we own the value.
 *
 * Ownership, both directions:
 * - `disabled` removes EVERY root `web_search` line (ours or the user's) and writes the marker-owned
 *   pair. Two root keys of the same name are invalid TOML, so keeping a user line alongside ours
 *   would stop Codex from loading the file at all — and the operator has just asked for this exact
 *   value. A value the user owned is reported back as `replacedUserLine` so the journal can carry
 *   it, and `ocx restore` additionally replays the snapshot, like every other line this injection
 *   rewrites.
 * - enabled (or unset) removes only the marker-owned pair, so re-enabling the sidecar cannot leave
 *   the native tool switched off — which would silently leave the sidecar with nothing to intercept.
 *   Two further sources of ownership come from the journal: the exact value a recorded injection
 *   wrote, so a line whose marker comment a Codex app reserialize dropped is still ours (#1798), and
 *   the user line that injection removed, which goes back now that nothing owns the key.
 */
export function ensureRootWebSearchDisabled(
  content: string,
  disabled: boolean,
  journal: RootWebSearchJournal = {},
): RootWebSearchOutcome {
  const stripped = stripInjectedRootWebSearch(content, journal.injectedValue);
  const { bom, lines, rootEnd } = rootSourceLines(stripped);
  if (!disabled) {
    const restore = journal.replacedUserLine;
    const owned = lines.slice(0, rootEnd).some(line => line.structural && isRootWebSearchLine(line.text));
    return {
      content: restore?.trim() && !owned ? insertRootSourceLines(stripped, [applyEol(restore, dominantEol(stripped))]) : stripped,
      replacedUserLine: null,
      wroteValue: null,
    };
  }
  // Whatever root line is left here is not marker-owned and not the value we recorded writing, so
  // it is the operator's own mode: keep its exact text for the pass that switches the sidecar back
  // on. Only one can be valid TOML, and the first is the one Codex reads. A pass that finds no such
  // line keeps the one an earlier off pass recorded — the ordinary way to reach that state is a
  // second injection while the switch is still off (a model change), and the operator's mode must
  // not evaporate because the line it came from is already gone.
  const drop = new Set<number>();
  let replacedUserLine = journal.replacedUserLine ?? null;
  let foundUserAssignment = false;
  for (let index = 0; index < rootEnd; index++) {
    if (!lines[index]!.structural || !isRootWebSearchLine(lines[index]!.text)) continue;
    const assignment = sourceAssignmentSpan(lines, index, rootEnd);
    if (!assignment) throw new Error("Cannot safely rewrite an incomplete root web_search assignment.");
    if (!foundUserAssignment) replacedUserLine = assignment.text;
    foundUserAssignment = true;
    for (let at = index; at < assignment.end; at++) drop.add(at);
  }
  return {
    content: insertRootSourceLines(
      bom + sourceText(lines.filter((_, index) => !drop.has(index))),
      [OCX_ROUTING_MARKER_LINE, ROOT_WEB_SEARCH_DISABLED_LINE],
    ),
    replacedUserLine,
    wroteValue: ROOT_WEB_SEARCH_DISABLED_VALUE,
  };
}

/**
 * Remove the marker-owned root `web_search` pair (marker line + the key line right after it).
 * Same ownership rule as `stripInjectedOpenaiBaseUrl`: a user's own line has no marker above it and
 * survives, so a hand-set mode is never reinterpreted as ours after an injection cycle. `injectedValue`
 * adds the #1798 value evidence — the exact value a recorded injection wrote — so a line whose marker
 * comment a Codex app reserialize dropped is still recognized as ours.
 */
export function stripInjectedRootWebSearch(content: string, injectedValue?: string | null): string {
  const { bom, lines, rootEnd } = rootSourceLines(content);
  const drop = new Set<number>();
  for (let index = 0; index < rootEnd; index++) {
    const line = lines[index]!;
    if (!line.structural || !isRootWebSearchLine(line.text)) continue;
    const assignment = sourceAssignment(lines, index, rootEnd);
    if (!assignment || typeof assignment.value !== "string") continue;
    const value = assignment.value;
    const markerOwned = index > 0 && lines[index - 1]!.structural && isOcxRoutingMarkerLine(lines[index - 1]!.text);
    if (!markerOwned && (!injectedValue || value !== injectedValue)) continue;
    for (let at = index; at < assignment.end; at++) drop.add(at);
    if (markerOwned) drop.add(index - 1);
  }
  return drop.size ? bom + sourceText(lines.filter((_, index) => !drop.has(index))) : content;
}

/**
 * Remove the marker-owned root `openai_base_url` (marker line + the key line right after it).
 * A user's own root override (no marker) survives; an orphaned marker with no key line after
 * it is dropped too so repeated strip/inject cycles cannot accumulate marker comments.
 * A marker-owned `experimental_realtime_ws_base_url` pair is removed by the same rule.
 */
export function stripInjectedOpenaiBaseUrl(content: string): string {
  const { bom, lines, rootEnd } = rootSourceLines(content);
  const drop = new Set<number>();
  for (let index = 0; index < rootEnd; index++) {
    const line = lines[index]!;
    if (!line.structural || !isOcxRoutingMarkerLine(line.text)) continue;
    const next = lines[index + 1];
    if (index + 1 < rootEnd && next?.structural
      && (isRootOpenaiBaseUrlLine(next.text) || isRootRealtimeWsBaseUrlLine(next.text))) {
      const key = rootAssignmentKey(next.text)!;
      if (rootTomlString(next.text, key) === null) continue;
      drop.add(index);
      drop.add(index + 1);
    } else if (index + 1 >= rootEnd || (next?.structural && next.text.trim() === "")) {
      drop.add(index);
    }
  }
  return drop.size ? bom + sourceText(lines.filter((_, index) => !drop.has(index))) : content;
}

/**
 * Strip every existing `model_provider` line that we must not duplicate: any line set to
 * "opencodex" (wherever it sits — including a previously mis-nested one under a table), plus any
 * ROOT-level model_provider (before the first table) of any value, since we override the global.
 * A `model_provider` legitimately inside a user table/profile with a non-opencodex value is left
 * untouched.
 */
export function stripExistingModelProvider(content: string): string {
  const { bom, lines, rootEnd } = rootSourceLines(content);
  const drop = new Set<number>();
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]!.structural || rootAssignmentKey(lines[index]!.text) !== "model_provider") continue;
    const assignment = sourceAssignmentSpan(lines, index, index < rootEnd ? rootEnd : lines.length);
    if (!assignment) throw new Error("Cannot safely rewrite an incomplete model_provider assignment.");
    if (index >= rootEnd) {
      const decoded = sourceAssignment(lines, index);
      if (typeof decoded?.value !== "string" || decoded.value.trim() !== "opencodex") continue;
    }
    for (let at = index; at < assignment.end; at++) drop.add(at);
  }
  return bom + sourceText(lines.filter((_, index) => !drop.has(index)));
}

/**
 * Drop ROOT-level `model_context_window` overrides (keys before the first table header). Codex
 * treats this root key as a global override that wins over the per-model catalog values, so a stale
 * `model_context_window = 1000000` makes every model (e.g. gpt-5.5) report a 1M window. User-owned
 * compaction limits do not alter the advertised context window and must survive reinjection.
 */
export function stripRootContextWindowOverrides(content: string): string {
  const { bom, lines, rootEnd } = rootSourceLines(content);
  const drop = new Set<number>();
  for (let index = 0; index < rootEnd; index++) {
    if (!lines[index]!.structural || rootAssignmentKey(lines[index]!.text) !== "model_context_window") continue;
    const assignment = sourceAssignmentSpan(lines, index, rootEnd);
    if (!assignment) throw new Error("Cannot safely rewrite an incomplete model_context_window assignment.");
    for (let at = index; at < assignment.end; at++) drop.add(at);
  }
  return bom + sourceText(lines.filter((_, index) => !drop.has(index)));
}

export function stripRootRoutedModel(content: string): string {
  const { bom, lines, rootEnd } = rootSourceLines(content);
  return bom + sourceText(lines.filter((line, index) => index >= rootEnd || !line.structural
    || !rootTomlString(line.text, "model")?.includes("/")));
}

/**
 * Insert `model_provider = "opencodex"` at the document ROOT — immediately before the first table
 * header (TOML root keys must precede all tables). If there are no tables, append it to the root body.
 */
export function setRootModelProvider(content: string): string {
  return insertRootSourceLines(content, ['model_provider = "opencodex"']);
}

function readRootModelCatalogPath(content: string): string | null {
  const { lines, rootEnd } = rootSourceLines(content);
  let ownedCatalogPath: string | null = null;
  for (let index = 0; index < rootEnd; index += 1) {
    if (!lines[index].structural) continue;
    const catalogPath = rootTomlString(lines[index].text, "model_catalog_json");
    if (catalogPath === null) continue;
    if (!isOpencodexCatalogPath(catalogPath)) return catalogPath;
    ownedCatalogPath ??= catalogPath;
  }
  return ownedCatalogPath;
}

export function setRootModelCatalogPath(content: string, catalogPath: string): string {
  const { bom, lines, rootEnd } = rootSourceLines(content);
  const key = `model_catalog_json = ${tomlString(catalogPath)}`;
  const ownedAssignments: number[] = [];
  let hasUserAssignment = false;
  for (let i = 0; i < rootEnd; i++) {
    if (!lines[i].structural || rootAssignmentKey(lines[i].text) !== "model_catalog_json") continue;
    const existing = rootTomlString(lines[i].text, "model_catalog_json");
    if (existing !== null && isOpencodexCatalogPath(existing)) {
      ownedAssignments.push(i);
    } else {
      hasUserAssignment = true;
    }
  }
  if (hasUserAssignment) {
    const owned = new Set(ownedAssignments);
    return bom + sourceText(lines.filter((_, index) => !owned.has(index)));
  }
  if (ownedAssignments.length > 0) {
    lines[ownedAssignments[0]].text = key;
    const duplicates = new Set(ownedAssignments.slice(1));
    return bom + sourceText(lines.filter((_, index) => !duplicates.has(index)));
  }
  return insertRootSourceLines(content, [key]);
}

export function removeProfileSection(content: string): string {
  const { bom, lines } = rootSourceLines(content);
  let inProfile = false;
  const kept = lines.filter(line => {
    if (line.structural && /^\s*\[/.test(line.text)) {
      try {
        const parsed = Bun.TOML.parse(line.text) as Record<string, unknown>;
        inProfile = typeof parsed.profiles === "object" && parsed.profiles !== null
          && Object.hasOwn(parsed.profiles, "opencodex");
      } catch { inProfile = false; }
    }
    return !inProfile;
  });
  return normalizeStructuralWhitespace(bom + sourceText(kept));
}

export function normalizeServiceTier(content: string): string {
  const { bom, lines, rootEnd } = rootSourceLines(content);
  for (const line of lines.slice(0, rootEnd)) {
    if (line.structural) line.text = line.text.replace(/^(\s*service_tier\s*=\s*)["']priority["']\s*$/, '$1"fast"');
  }
  return bom + sourceText(lines);
}

export function ensureFastModeFeature(content: string, fastMode?: boolean): string {
  // Tri-state fast mode (see OcxConfig.fastMode): true forces `fast_mode = true`,
  // false forces `fast_mode = false`, and undefined leaves the user's config
  // untouched (no [features] table is added and an existing fast_mode line is
  // preserved as-is). Table and key matching accept the valid TOML spellings
  // `[features] # comment`, `["features"]` / `['features']`, and quoted keys.
  if (fastMode === undefined) return content;
  const { bom, lines } = rootSourceLines(content);
  const eol = lines.find(line => line.eol)?.eol || "\n";
  const featuresStart = lines.findIndex(line => {
    if (!line.structural || !/^\s*\[/.test(line.text)) return false;
    try {
      const parsed = Bun.TOML.parse(line.text) as Record<string, unknown>;
      return Object.keys(parsed).length === 1 && typeof parsed.features === "object"
        && parsed.features !== null && !Array.isArray(parsed.features)
        && Object.keys(parsed.features).length === 0;
    } catch { return false; }
  });
  if (featuresStart === -1) {
    return content.replace(/[\r\n]+$/, "") + eol + eol + "[features]" + eol
      + "fast_mode = " + (fastMode ? "true" : "false") + eol;
  }

  const nextTable = lines.findIndex(
    (line, index) => index > featuresStart && line.structural && /^\s*\[/.test(line.text),
  );
  const featuresEnd = nextTable === -1 ? lines.length : nextTable;
  for (let i = featuresStart + 1; i < featuresEnd; i++) {
    if (lines[i].structural && rootAssignmentKey(lines[i].text) === "fast_mode") {
      // Refuse to rewrite an incomplete physical view of a collection/string value.
      try { Bun.TOML.parse(lines[i].text); } catch { return content; }
      lines[i].text = `${/^\s*/.exec(lines[i].text)![0]}fast_mode = ${fastMode ? "true" : "false"}`;
      return bom + sourceText(lines);
    }
  }

  let insertAt = featuresEnd;
  while (insertAt > featuresStart + 1 && lines[insertAt - 1].structural && lines[insertAt - 1].text.trim() === "") insertAt--;
  if (insertAt > 0 && !lines[insertAt - 1].eol) lines[insertAt - 1].eol = eol;
  lines.splice(insertAt, 0, { text: `fast_mode = ${fastMode ? "true" : "false"}`, eol, structural: true });
  return bom + sourceText(lines);
}

function isOpencodexCatalogPath(path: string): boolean {
  return path.replace(/\\/g, "/").split("/").pop() === "opencodex-catalog.json";
}

export function stripOpencodexCatalogPath(content: string): string {
  const { bom, lines, rootEnd } = rootSourceLines(content);
  return bom + sourceText(lines
    .filter((line, index) => {
      if (index >= rootEnd || !line.structural) return true;
      const path = rootTomlString(line.text, "model_catalog_json");
      return path === null || !isOpencodexCatalogPath(path);
    }));
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

export function buildProfileFileForTarget(
  target: CodexRoutingTarget,
  catalogPath?: string | null,
  supportsWebsockets = false,
  fastMode?: boolean,
  displayName?: string,
): string {
  const origin = routingTargetOrigin(target);
  const host = new URL(origin).host;
  // Design B (loopback): the reference/fallback file documents the root override form.
  // Non-loopback keeps the legacy provider-table shape (built-in provider cannot carry
  // the x-opencodex-api-key env header); explicit Desktop policies share that shape.
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
  lines.push(buildProviderTableBlockForTarget(target, supportsWebsockets, displayName).trimEnd(), "");
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

/**
 * The effective `model_catalog_json` is one of ours and the file is gone.
 *
 * Codex does not degrade on this: a catalog path it cannot read stops it loading its
 * configuration at all, which looks exactly like the routing lockout in #5261 and is what the
 * reporter's machine was left in after the catalog file was deleted by hand.
 *
 * Injection already repairs it — the chooser refuses a missing owned path and the caller strips
 * the stale line. That only helps someone who runs opencodex again, and the whole difficulty of
 * this state is that Codex is the thing that stopped working, so nothing prompts them to. This
 * predicate exists so the CLI can say it out loud.
 *
 * A user-owned catalog assignment wins here exactly as it does during injection: if they named
 * the file, its absence is theirs to explain, and we do not claim it.
 *
 * Ownership is decided by basename, which is a weak test — a file the user happens to name
 * `opencodex-catalog.json` is read as ours wherever it sits. That is deliberate rather than
 * overlooked: it is the same test injection already applies, and a detector that drew the line
 * somewhere else would report a state injection would then treat differently. Tightening it is a
 * change to injection, not to this.
 */
export function missingOwnedCatalogPath(content: string): string | null {
  const existing = readRootModelCatalogPath(content);
  if (!existing) return null;
  const resolved = resolveCodexConfigPath(existing);
  if (!isOpencodexCatalogPath(resolved)) return null;
  return existsSync(resolved) ? null : existing;
}
