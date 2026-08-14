/**
 * prompt-layers.ts — the Codex prompt-layer surface in `$CODEX_HOME/config.toml`.
 *
 * Scope boundary: this module owns the five `include_*` prompt toggles and the
 * generated `developer_instructions` projection. It is a SIBLING of
 * `features.ts`, not an extension of it: that module's header explicitly forbids
 * broadening itself past `multi_agent_v2`, so the technique is copied here
 * rather than the file being widened.
 *
 * Two design decisions are load-bearing and were forced by an adversarial audit
 * (devlog/_plan/260802_codex_set_prompt_composer/):
 *
 * 1. NO USER PROSE IS PARSED BACK OUT OF TOML. Custom layers live in
 *    `opencodex-prompt.json`, which we own outright; config.toml receives a
 *    write-only projection of the enabled subset. Layer identity never has to
 *    survive a round trip through a TOML parser.
 *
 * 2. NO TOML LIBRARY IS USED TO VERIFY WHAT WE WROTE. Measured on Bun 1.3.14,
 *    `Bun.TOML.parse` transposes `\t` and `\f`, rejects `\u0007`, and does not
 *    trim the newline after an opening `'''`. Codex parses with Rust
 *    `toml_edit`, so verifying through a JS parser could report success on a
 *    file Codex reads differently. Instead the accepted character set is
 *    restricted until escaping is total under three rules, and verification is
 *    a byte comparison.
 *
 * CODEX_HOME is resolved at CALL time (the `features.ts:58-67` pattern) so tests
 * can point fixtures via env or an explicit path.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { expandUserPath } from "../config";
import { CODEX_CONFIG_PATH } from "./paths";
import { OCX_SECTION_MARKER } from "./injected-marker";
import {
  durableWrite,
  durableWriteExclusive,
  durableDelete,
  encodeJournal,
  ensureDir,
  hashBytes,
  recoverIfNeeded as recoverJournal,
  type JournalRecord,
} from "./prompt-journal";
import { release, stillHeld, tryAcquire } from "./prompt-lock";

// ---------------------------------------------------------------------------
// Inventory — ONE definition, consumed by the route and the GUI alike.
// Classes are the five in devlog 001 §4; the partition is total and disjoint.
// ---------------------------------------------------------------------------

export type LayerClass =
  | "base"
  | "config-toggle"
  | "feature-gated"
  | "runtime-conditional"
  | "extension-unknown";

export type ToggleId =
  | "permissions"
  | "collaboration"
  | "environment"
  | "apps"
  | "skills";

export interface LayerDescriptor {
  id: string;
  class: LayerClass;
  /** config key for config-toggle and feature-gated rows; null otherwise */
  key: string | null;
  /** documented default when the key is absent */
  default: boolean | null;
  /** assembly index from devlog 001 §1; null when registration-order dependent */
  order: number | null;
}

/**
 * Assembly order per `core/src/session/world_state.rs`. `base-instructions` is
 * NOT a world-state section — it travels in the Responses `instructions` field
 * — so it carries order 0 and sits ahead of the rest.
 *
 * `plugins` is `runtime-conditional`, not feature-gated: `core/src/mcp.rs:200`
 * computes `selected_plugin_available || !capability_summaries().is_empty()`,
 * so `[features] plugins` influences the right operand but does not gate
 * emission.
 */
export const LAYER_INVENTORY: readonly LayerDescriptor[] = Object.freeze([
  { id: "base-instructions", class: "base", key: null, default: null, order: 0 },
  { id: "model-switch", class: "runtime-conditional", key: null, default: null, order: 1 },
  { id: "personality", class: "feature-gated", key: "features.personality", default: true, order: 2 },
  { id: "context-window-guidance", class: "feature-gated", key: "features.token_budget", default: false, order: 3 },
  { id: "realtime", class: "runtime-conditional", key: null, default: null, order: 4 },
  { id: "agents-md", class: "runtime-conditional", key: null, default: null, order: 5 },
  { id: "permissions", class: "config-toggle", key: "include_permissions_instructions", default: true, order: 6 },
  { id: "collaboration", class: "config-toggle", key: "include_collaboration_mode_instructions", default: true, order: 7 },
  { id: "environment", class: "config-toggle", key: "include_environment_context", default: true, order: 8 },
  { id: "environments-instructions", class: "feature-gated", key: "features.deferred_executor", default: false, order: 9 },
  { id: "apps", class: "config-toggle", key: "include_apps_instructions", default: true, order: 10 },
  { id: "plugins", class: "runtime-conditional", key: null, default: null, order: 11 },
  { id: "tools", class: "feature-gated", key: "features.deferred_tool_world_state", default: false, order: 12 },
  { id: "skills", class: "config-toggle", key: "skills.include_instructions", default: true, order: 13 },
  { id: "multi-agent-mode", class: "feature-gated", key: "features.multi_agent_v2.enabled", default: false, order: 14 },
] as const);

/**
 * The write allowlist. Fixed, never computed: `config_toml.rs` does NOT carry
 * serde's `deny_unknown_fields`, so a typo'd key is silently ignored in normal
 * mode and a hard startup error under `--strict-config`. A fixed table means
 * the GUI can never emit a key it did not intend.
 */
const TOGGLE_KEYS: Record<ToggleId, { table: string | null; key: string }> = {
  permissions: { table: null, key: "include_permissions_instructions" },
  collaboration: { table: null, key: "include_collaboration_mode_instructions" },
  environment: { table: null, key: "include_environment_context" },
  apps: { table: null, key: "include_apps_instructions" },
  skills: { table: "skills", key: "include_instructions" },
};

export const TOGGLE_IDS = Object.freeze(Object.keys(TOGGLE_KEYS) as ToggleId[]);

export function isToggleId(value: string): value is ToggleId {
  return Object.prototype.hasOwnProperty.call(TOGGLE_KEYS, value);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface Paths {
  configPath?: string;
  storePath?: string;
}

function activeCodexHome(): string {
  const raw = process.env.CODEX_HOME?.trim();
  if (!raw) return CODEX_CONFIG_PATH.slice(0, -"/config.toml".length);
  const path = resolve(expandUserPath(raw));
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

export function activeConfigPath(opts?: Paths): string {
  return opts?.configPath ?? join(activeCodexHome(), "config.toml");
}

export function activeStorePath(opts?: Paths): string {
  return opts?.storePath ?? join(activeCodexHome(), "opencodex-prompt.json");
}

function journalPathFor(storePath: string): string {
  return `${storePath.replace(/\.json$/, "")}.journal`;
}

function lockPathFor(storePath: string): string {
  return `${storePath.replace(/\.json$/, "")}.lock`;
}

// ---------------------------------------------------------------------------
// Character policy — see the header. Defined over Unicode SCALAR VALUES, not
// UTF-16 code units, because a lone surrogate is not a scalar value and UTF-8
// encoding would silently substitute U+FFFD.
// ---------------------------------------------------------------------------

export interface CharacterFinding {
  /** code-point index, consistent across module, route and editor */
  position: number;
  reason: "control" | "unpaired-surrogate";
  codePoint: number;
}

/** Tab to four spaces, CRLF and lone CR to LF. Applied BEFORE validation. */
export function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
}

/** First offending scalar, or null. Run AFTER normalizeBody. */
export function findInvalidCharacter(body: string): CharacterFinding | null {
  let position = 0;
  for (let i = 0; i < body.length; ) {
    const code = body.codePointAt(i)!;
    const unit = body.charCodeAt(i);
    const isHighSurrogate = unit >= 0xd800 && unit <= 0xdbff;
    const isLowSurrogate = unit >= 0xdc00 && unit <= 0xdfff;
    // codePointAt only combines a well-formed pair, so a surviving surrogate
    // code point here is unpaired by construction.
    if ((isHighSurrogate || isLowSurrogate) && code === unit) {
      return { position, reason: "unpaired-surrogate", codePoint: code };
    }
    const isNewline = code === 0x0a;
    const isC0 = code < 0x20 && !isNewline;
    const isDel = code === 0x7f;
    const isC1 = code >= 0x80 && code <= 0x9f;
    if (isC0 || isDel || isC1) {
      return { position, reason: "control", codePoint: code };
    }
    i += code > 0xffff ? 2 : 1;
    position += 1;
  }
  return null;
}

/**
 * TOML basic-string encoding, total over the accepted set: three rules, none of
 * them in the range where `Bun.TOML.parse` misbehaves. `\r` cannot appear
 * because normalizeBody removed it; control characters cannot appear because
 * findInvalidCharacter rejected them.
 */
export function encodeBasicString(body: string): string {
  return `"${body.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/**
 * Inverse of `encodeBasicString`, deliberately narrow: it accepts ONLY the three
 * escapes we emit. `\t`, `\f`, `\b`, `\r` and `\uXXXX` are refused rather than
 * guessed — decoding them correctly is exactly the ambiguity the restricted set
 * exists to avoid.
 */
export function decodeBasicString(literal: string): string | null {
  if (literal.length < 2 || !literal.startsWith('"') || !literal.endsWith('"')) return null;
  const inner = literal.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (ch !== "\\") {
      if (ch === '"') return null; // unescaped quote: not a single literal
      out += ch;
      continue;
    }
    const next = inner[i + 1];
    if (next === "\\") out += "\\";
    else if (next === '"') out += '"';
    else if (next === "n") out += "\n";
    else return null; // any other escape is outside what we will decode
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Byte-level hashing. The revision covers COMPLETE file bytes plus existence,
// so removing the marker while leaving the value intact still changes it.
// ---------------------------------------------------------------------------

function readFileOrNull(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function computeRevision(configBytes: string | null, storeBytes: string | null): string {
  const hash = createHash("sha256");
  hash.update("cfg:");
  hash.update(configBytes ?? "\0absent");
  hash.update("\nstore:");
  hash.update(storeBytes ?? "\0absent");
  return `sha256:${hash.digest("hex")}`;
}

export { readFileOrNull as readFileBytes };

// ---------------------------------------------------------------------------
// Scoped TOML scanning. Line-based like `features.ts:80-93`: booleans need no
// escaping, and line editing preserves the user's comments and formatting
// exactly where a re-serialize would not.
// ---------------------------------------------------------------------------

const TABLE_HEADER = /^\s*\[/;

/** Lines of the root scope: everything before the first `[table]` header. */
function rootLines(content: string): string[] {
  const lines = content.split("\n");
  const first = lines.findIndex(l => TABLE_HEADER.test(l));
  return first === -1 ? lines : lines.slice(0, first);
}

/** Lines of `[header]`'s body, up to the next table header. */
function tableLines(content: string, header: string): string[] | null {
  const lines = content.split("\n");
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex(l => new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`).test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => TABLE_HEADER.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

function boolInLines(lines: string[], key: string): boolean | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}\\s*=\\s*(true|false)\\s*(?:#.*)?$`);
  for (const line of lines) {
    const m = pattern.exec(line);
    if (m) return m[1] === "true";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ownership of the generated projection.
//
// Canonical physical form, always exactly two lines at the top of the document:
//
//     # Auto-injected by opencodex
//     developer_instructions = "<single-line basic string>"
//
// Replacement is "find the marker, replace the next line" — never a span search.
// Adjacency mirrors `injected-marker.ts:53-60`, tightened by a shape check.
// ---------------------------------------------------------------------------

const DEV_INSTRUCTIONS_KEY = "developer_instructions";
const CANONICAL_LINE = /^developer_instructions = "(?:[^"\\]|\\.)*"$/;
const ANY_DEV_INSTRUCTIONS = /^\s*(?:developer_instructions|"developer_instructions"|'developer_instructions')\s*=/;

export type Ownership =
  /** no such key anywhere in the root scope */
  | { state: "absent" }
  /** marker-adjacent and canonically shaped: ours to rewrite */
  | { state: "owned"; line: number; literal: string }
  /** marker-adjacent but reshaped: refuse, offer repair */
  | { state: "owned-malformed"; line: number; raw: string }
  /** no marker: externally authored, refuse and offer adoption */
  | { state: "external"; line: number; raw: string };

export function inspectOwnership(configBytes: string | null): Ownership {
  if (configBytes === null) return { state: "absent" };
  const lines = rootLines(configBytes);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (!ANY_DEV_INSTRUCTIONS.test(raw)) continue;
    const marked = i > 0 && lines[i - 1]!.includes(OCX_SECTION_MARKER);
    if (!marked) return { state: "external", line: i + 1, raw };
    if (!CANONICAL_LINE.test(raw)) return { state: "owned-malformed", line: i + 1, raw };
    const literal = raw.slice(`${DEV_INSTRUCTIONS_KEY} = `.length);
    return { state: "owned", line: i + 1, literal };
  }
  return { state: "absent" };
}

// ---------------------------------------------------------------------------
// Store — the single source of truth for custom layers.
// ---------------------------------------------------------------------------

export interface CustomLayer {
  /** [a-z0-9]{6}, stable across edits */
  id: string;
  title: string;
  body: string;
  enabled: boolean;
}

const LAYER_ID = /^[a-z0-9]{6}$/;

function isCustomLayer(value: unknown): value is CustomLayer {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && LAYER_ID.test(v.id)
    && typeof v.title === "string"
    && typeof v.body === "string"
    && typeof v.enabled === "boolean";
}

/** null means unreadable/malformed, which is NOT the same as an empty store. */
export function parseStore(storeBytes: string | null): CustomLayer[] | null {
  if (storeBytes === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(storeBytes);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const layers = (parsed as { layers?: unknown }).layers;
  if (!Array.isArray(layers) || !layers.every(isCustomLayer)) return null;
  const ids = new Set(layers.map(l => l.id));
  if (ids.size !== layers.length) return null;
  return layers;
}

/** Enabled layers, joined in order. This is the value written to config.toml. */
export function composeProjection(layers: readonly CustomLayer[]): string {
  return layers.filter(l => l.enabled).map(l => l.body).join("\n\n");
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface ToggleState {
  id: ToggleId;
  key: string;
  /** null = the key is absent from the user file */
  userFileValue: boolean | null;
  /**
   * userFileValue ?? default. NOT the resolved Codex value: opencodex reads one
   * of the eight config layers, so it reports this file's value under a name
   * that says as much.
   */
  defaultedUserValue: boolean;
  default: boolean;
}

export type Drift =
  | "journal-present"
  | "projection-stale"
  | "store-missing"
  | "owned-malformed"
  | null;

export interface PromptLayerSnapshot {
  configPath: string;
  storePath: string;
  configExists: boolean;
  readable: boolean;
  developerInstructionsOwned: boolean;
  /** non-null blocks mutations until resolved */
  drift: Drift;
  toggles: ToggleState[];
  custom: CustomLayer[];
  modelInstructionsFile: string | null;
  revision: string;
}

function readToggle(configBytes: string | null, id: ToggleId): ToggleState {
  const spec = TOGGLE_KEYS[id];
  const descriptor = LAYER_INVENTORY.find(d => d.id === id)!;
  const fallback = descriptor.default ?? true;
  const key = spec.table ? `${spec.table}.${spec.key}` : spec.key;
  let value: boolean | null = null;
  if (configBytes !== null) {
    const scope = spec.table ? tableLines(configBytes, spec.table) : rootLines(configBytes);
    value = scope === null ? null : boolInLines(scope, spec.key);
  }
  return {
    id,
    key,
    userFileValue: value,
    defaultedUserValue: value ?? fallback,
    default: fallback,
  };
}

function readModelInstructionsFile(configBytes: string | null): string | null {
  if (configBytes === null) return null;
  for (const line of rootLines(configBytes)) {
    const m = /^\s*model_instructions_file\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * Pure. Never writes, never locks, never recovers — a GET must not modify a
 * user's configuration, so drift is REPORTED here and resolved elsewhere.
 */
export function readPromptLayers(opts?: Paths): PromptLayerSnapshot {
  const configPath = activeConfigPath(opts);
  const storePath = activeStorePath(opts);
  const configExists = existsSync(configPath);
  const configBytes = readFileOrNull(configPath);
  const storeExists = existsSync(storePath);
  const storeBytes = readFileOrNull(storePath);

  // Present but unreadable is a hard stop; absent is an ordinary first run.
  const readable = !configExists || configBytes !== null;
  const ownership = inspectOwnership(configBytes);
  const layers = parseStore(storeBytes);
  const projection = ownership.state === "owned"
    ? decodeBasicString(ownership.literal)
    : null;

  let drift: Drift = null;
  if (existsSync(`${storePath.replace(/\.json$/, "")}.journal`)) {
    drift = "journal-present";
  } else if (ownership.state === "owned-malformed") {
    drift = "owned-malformed";
  } else if (!storeExists && projection !== null && projection.length > 0) {
    // The store is gone while a live projection remains. Treating this as an
    // empty store would erase the active prompt on the next write.
    drift = "store-missing";
  } else if (layers !== null && projection !== null && composeProjection(layers) !== projection) {
    drift = "projection-stale";
  }

  return {
    configPath,
    storePath,
    configExists,
    readable,
    developerInstructionsOwned: ownership.state === "owned",
    drift,
    toggles: TOGGLE_IDS.map(id => readToggle(configBytes, id)),
    custom: layers ?? [],
    modelInstructionsFile: readModelInstructionsFile(configBytes),
    revision: computeRevision(configBytes, storeBytes),
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type WriteError =
  | "config_unreadable"
  | "stale_revision"
  | "developer_instructions_not_owned"
  | "unknown_layer"
  | "store_unreadable"
  | "invalid_characters"
  | "write_superseded"
  | "recovery_required"
  | "locked";

export type WriteResult =
  | { ok: true; changed: boolean; snapshot: PromptLayerSnapshot }
  | { ok: false; error: WriteError; detail?: string };

/** Line editing, not re-serialization: the user's comments and layout survive. */
function dominantEol(content: string): "\r\n" | "\n" {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return "\n";
  const bareLf = (content.match(/\n/g) ?? []).length - crlf;
  return crlf >= bareLf ? "\r\n" : "\n";
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

function joinLines(lines: string[], eol: "\r\n" | "\n"): string {
  const text = lines.join("\n");
  return eol === "\n" ? text : text.replace(/\n/g, "\r\n");
}

function firstTableIndex(lines: string[]): number {
  const idx = lines.findIndex(l => TABLE_HEADER.test(l));
  return idx === -1 ? lines.length : idx;
}

/** Set a root-scope boolean, inserting above the first table when absent. */
function setRootBool(content: string, key: string, value: boolean): string {
  const eol = dominantEol(content);
  const lines = splitLines(content);
  const limit = firstTableIndex(lines);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^(\\s*${escaped}\\s*=\\s*)(?:true|false)(\\s*(?:#.*)?)$`);
  for (let i = 0; i < limit; i += 1) {
    const m = pattern.exec(lines[i]!);
    if (m) {
      lines[i] = `${m[1]}${value}${m[2]}`;
      return joinLines(lines, eol);
    }
  }
  lines.splice(limit, 0, `${key} = ${value}`);
  return joinLines(lines, eol);
}

/** Set a boolean inside `[table]`, appending the table when absent. */
function setTableBool(content: string, table: string, key: string, value: boolean): string {
  const eol = dominantEol(content);
  const lines = splitLines(content);
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex(l => new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`).test(l));
  if (start === -1) {
    const tail = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    lines.splice(tail, 0, `[${table}]`, `${key} = ${value}`);
    return joinLines(lines, eol);
  }
  const keyEscaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^(\\s*${keyEscaped}\\s*=\\s*)(?:true|false)(\\s*(?:#.*)?)$`);
  let end = start + 1;
  while (end < lines.length && !TABLE_HEADER.test(lines[end]!)) end += 1;
  for (let i = start + 1; i < end; i += 1) {
    const m = pattern.exec(lines[i]!);
    if (m) {
      lines[i] = `${m[1]}${value}${m[2]}`;
      return joinLines(lines, eol);
    }
  }
  lines.splice(end, 0, `${key} = ${value}`);
  return joinLines(lines, eol);
}

/**
 * Replace, insert, or remove the generated two-line block. Canonical form is
 * marker + assignment at the top of the document; replacement is "find the
 * marker, replace the next line" rather than a span search.
 */
function setProjection(content: string | null, projection: string | null): string {
  const base = content ?? "";
  const eol = dominantEol(base);
  const lines = splitLines(base);
  const limit = firstTableIndex(lines);

  let markerAt = -1;
  for (let i = 0; i < limit; i += 1) {
    if (i > 0 && lines[i - 1]!.includes(OCX_SECTION_MARKER) && ANY_DEV_INSTRUCTIONS.test(lines[i]!)) {
      markerAt = i - 1;
      break;
    }
  }

  if (markerAt !== -1) {
    if (projection === null) lines.splice(markerAt, 2);
    else lines[markerAt + 1] = `${DEV_INSTRUCTIONS_KEY} = ${encodeBasicString(projection)}`;
    return joinLines(lines, eol);
  }

  if (projection === null) return joinLines(lines, eol);
  lines.splice(0, 0, OCX_SECTION_MARKER, `${DEV_INSTRUCTIONS_KEY} = ${encodeBasicString(projection)}`);
  return joinLines(lines, eol);
}

function serializeStore(layers: readonly CustomLayer[]): string {
  return `${JSON.stringify({ layers }, null, 2)}\n`;
}

interface Mutation {
  nextConfig: string | null;
  nextStore: string | null;
}

/**
 * The seven-step transaction. Every filesystem mutation in this module goes
 * through here so the journal, the lock, and the per-target byte checks cannot
 * be bypassed by a future caller.
 */
function commit(
  opts: Paths | undefined,
  revision: string,
  build: (snapshot: PromptLayerSnapshot, configBytes: string | null, storeBytes: string | null)
    => Mutation | { error: WriteError; detail?: string },
): WriteResult {
  const configPath = activeConfigPath(opts);
  const storePath = activeStorePath(opts);
  const journalPath = journalPathFor(storePath);
  const lockPath = lockPathFor(storePath);

  ensureDir(configPath);
  ensureDir(storePath);

  const acquired = tryAcquire(lockPath);
  if (!acquired.ok) return { ok: false, error: "locked" };
  const handle = acquired.handle;

  try {
    // 1. recovery first: a journal on disk means an earlier attempt never
    //    committed, and we must not stack a second transaction on top of it.
    const recovered = recoverJournal(journalPath, { configPath, storePath });
    if (!recovered.ok) return { ok: false, error: "recovery_required", detail: recovered.detail };

    // 2. re-read and compare against the caller's edit base.
    const configBytes = readFileOrNull(configPath);
    const storeBytes = readFileOrNull(storePath);
    if (existsSync(configPath) && configBytes === null) {
      return { ok: false, error: "config_unreadable" };
    }
    if (computeRevision(configBytes, storeBytes) !== revision) {
      return { ok: false, error: "stale_revision" };
    }

    const snapshot = readPromptLayers({ configPath, storePath });
    const built = build(snapshot, configBytes, storeBytes);
    if ("error" in built) return { ok: false, error: built.error, detail: built.detail };

    const { nextConfig, nextStore } = built;
    const configChanged = nextConfig !== configBytes;
    const storeChanged = nextStore !== storeBytes;
    if (!configChanged && !storeChanged) {
      return { ok: true, changed: false, snapshot };
    }

    // 3. journal the intent. Its existence is NOT a commit.
    const record: JournalRecord = {
      configPath,
      storePath,
      preConfig: hashBytes(configBytes),
      postConfig: hashBytes(nextConfig),
      preStore: hashBytes(storeBytes),
      postStore: hashBytes(nextStore),
      preConfigBytes: configBytes,
      postConfigBytes: nextConfig,
      preStoreBytes: storeBytes,
      postStoreBytes: nextStore,
    };
    durableWrite(journalPath, encodeJournal(record));

    // 4/5. each target re-verifies ITS OWN bytes immediately before its rename,
    //      so a third party writing between step 2 and here is not overwritten.
    if (configChanged) {
      if (hashBytes(readFileOrNull(configPath)) !== record.preConfig) {
        return rollback(record, journalPath, "stale_revision");
      }
      if (nextConfig === null) durableDelete(configPath);
      else durableWrite(configPath, nextConfig);
    }
    if (storeChanged) {
      if (hashBytes(readFileOrNull(storePath)) !== record.preStore) {
        return rollback(record, journalPath, "stale_revision");
      }
      if (nextStore === null) durableDelete(storePath);
      else durableWrite(storePath, nextStore);
    }

    // 6. verify COMPLETE bytes, not just our two lines: another writer could
    //    change an unrelated key and a narrow check would report success.
    const finalConfig = hashBytes(readFileOrNull(configPath));
    const finalStore = hashBytes(readFileOrNull(storePath));
    if (finalConfig !== record.postConfig || finalStore !== record.postStore) {
      return { ok: false, error: "write_superseded" };
    }
    if (!stillHeld(handle)) return { ok: false, error: "write_superseded" };

    durableDelete(journalPath);   // this deletion is the commit
    return { ok: true, changed: true, snapshot: readPromptLayers({ configPath, storePath }) };
  } finally {
    release(handle);
  }
}

/** Undo whatever landed, then drop the journal. Never touches an unknown file. */
function rollback(record: JournalRecord, journalPath: string, error: WriteError): WriteResult {
  const configNow = hashBytes(readFileOrNull(record.configPath));
  const storeNow = hashBytes(readFileOrNull(record.storePath));
  if (configNow !== record.preConfig && configNow !== record.postConfig) {
    return { ok: false, error: "recovery_required", detail: record.configPath };
  }
  if (storeNow !== record.preStore && storeNow !== record.postStore) {
    return { ok: false, error: "recovery_required", detail: record.storePath };
  }
  if (configNow === record.postConfig) {
    if (record.preConfigBytes === null) durableDelete(record.configPath);
    else durableWrite(record.configPath, record.preConfigBytes);
  }
  if (storeNow === record.postStore) {
    if (record.preStoreBytes === null) durableDelete(record.storePath);
    else durableWrite(record.storePath, record.preStoreBytes);
  }
  durableDelete(journalPath);
  return { ok: false, error };
}

/** Flip one of the five prompt toggles. */
export function setToggle(id: string, enabled: boolean, revision: string, opts?: Paths): WriteResult {
  if (!isToggleId(id)) return { ok: false, error: "unknown_layer" };
  const spec = TOGGLE_KEYS[id];
  return commit(opts, revision, (_snapshot, configBytes, storeBytes) => ({
    nextConfig: spec.table
      ? setTableBool(configBytes ?? "", spec.table, spec.key, enabled)
      : setRootBool(configBytes ?? "", spec.key, enabled),
    nextStore: storeBytes,
  }));
}

/** Replace the whole custom-layer list; order is composition order. */
export function writeCustomLayers(layers: readonly CustomLayer[], revision: string, opts?: Paths): WriteResult {
  for (const layer of layers) {
    const normalized = normalizeBody(layer.body);
    const invalid = findInvalidCharacter(normalized);
    if (invalid !== null) {
      return { ok: false, error: "invalid_characters", detail: `layer ${layer.id} at code point ${invalid.position}` };
    }
  }
  const normalizedLayers = layers.map(l => ({ ...l, body: normalizeBody(l.body) }));
  return commit(opts, revision, (snapshot, configBytes, _storeBytes) => {
    // Only a marker-owned key may be rewritten. Absent is fine — we create it.
    const ownership = inspectOwnership(configBytes);
    if (ownership.state === "external" || ownership.state === "owned-malformed") {
      return { error: "developer_instructions_not_owned" };
    }
    const projection = composeProjection(normalizedLayers);
    return {
      nextConfig: setProjection(configBytes, projection.length > 0 ? projection : null),
      nextStore: serializeStore(normalizedLayers),
    };
  });
}

// ---------------------------------------------------------------------------
// Adoption — taking ownership of an externally authored key.
//
// Refusing alone was a dead end: the earlier answer was "delete your existing
// instructions by hand", which is not a feature. Adoption previews the raw line
// AND the exact body that will be committed, then imports on confirmation.
// ---------------------------------------------------------------------------

export interface AdoptPreview {
  rawLine: string | null;
  /** post-normalization body — byte-identical to what a confirm would store */
  decodedBody: string | null;
  reason: "ok" | "nothing_to_adopt" | "unsupported_form" | "invalid_characters";
  path: string;
  line: number | null;
  detail?: string;
}

function newLayerId(existing: readonly CustomLayer[]): string {
  const taken = new Set(existing.map(l => l.id));
  for (;;) {
    const id = randomBytes(4).toString("hex").slice(0, 6);
    if (!taken.has(id)) return id;
  }
}

/**
 * Read-only. Runs the same five steps a confirm would, so preview and commit
 * cannot disagree: decode -> normalize -> validate -> cap -> present.
 */
export function previewAdopt(opts?: Paths): AdoptPreview {
  const configPath = activeConfigPath(opts);
  const ownership = inspectOwnership(readFileOrNull(configPath));

  if (ownership.state === "absent" || ownership.state === "owned") {
    return { rawLine: null, decodedBody: null, reason: "nothing_to_adopt", path: configPath, line: null };
  }

  const raw = ownership.raw;
  const line = ownership.line;
  const eq = raw.indexOf("=");
  const literal = eq === -1 ? "" : raw.slice(eq + 1).trim().replace(/\s*#.*$/, "");
  const decoded = decodeBasicString(literal);
  if (decoded === null) {
    return {
      rawLine: raw,
      decodedBody: null,
      reason: "unsupported_form",
      path: configPath,
      line,
      detail: "only a single-line basic string using \\\", \\\\ and \\n can be decoded safely",
    };
  }

  const normalized = normalizeBody(decoded);
  const invalid = findInvalidCharacter(normalized);
  if (invalid !== null) {
    return {
      rawLine: raw,
      decodedBody: null,
      reason: "invalid_characters",
      path: configPath,
      line,
      detail: `code point ${invalid.position} is a ${invalid.reason}`,
    };
  }

  return { rawLine: raw, decodedBody: normalized, reason: "ok", path: configPath, line };
}

/** Import the external value as one custom layer and take ownership of the key. */
export function adoptDeveloperInstructions(revision: string, opts?: Paths): WriteResult {
  const preview = previewAdopt(opts);
  if (preview.reason !== "ok" || preview.decodedBody === null) {
    return {
      ok: false,
      error: preview.reason === "invalid_characters" ? "invalid_characters" : "developer_instructions_not_owned",
      detail: preview.detail,
    };
  }
  const body = preview.decodedBody;
  return commit(opts, revision, (snapshot, configBytes) => {
    const existing = snapshot.custom;
    const adopted: CustomLayer = {
      id: newLayerId(existing),
      title: "Imported from config.toml",
      body,
      enabled: true,
    };
    const layers = [adopted, ...existing];
    // Drop the unowned line first, then write the canonical owned block.
    const stripped = removeUnownedProjection(configBytes ?? "");
    return {
      nextConfig: setProjection(stripped, composeProjection(layers)),
      nextStore: serializeStore(layers),
    };
  });
}

/** Remove an unowned or reshaped `developer_instructions` from the root scope. */
function removeUnownedProjection(content: string): string {
  const eol = dominantEol(content);
  const lines = splitLines(content);
  const limit = firstTableIndex(lines);
  for (let i = 0; i < limit; i += 1) {
    if (!ANY_DEV_INSTRUCTIONS.test(lines[i]!)) continue;
    const marked = i > 0 && lines[i - 1]!.includes(OCX_SECTION_MARKER);
    lines.splice(marked ? i - 1 : i, marked ? 2 : 1);
    return joinLines(lines, eol);
  }
  return joinLines(lines, eol);
}

// ---------------------------------------------------------------------------
// Salvage — the store is gone while a live projection remains.
//
// This is salvage, NOT reconstruction. The projection is one concatenated
// string: layer boundaries, ids, titles, order, disabled layers, and whether a
// blank line separated two layers or was the user's own text are all gone.
// ---------------------------------------------------------------------------

export interface SalvagePreview {
  body: string | null;
  /** the DIRECTORY backups land in. A read-only preview reserves no filename. */
  backupDir: string;
  unrecoverable: readonly string[];
  reason: "ok" | "nothing_to_salvage";
}

const UNRECOVERABLE = Object.freeze([
  "layer boundaries",
  "layer ids",
  "layer titles",
  "row order",
  "disabled layers and their bodies",
  "whether a blank line separated two layers or was your own text",
]);

export function previewSalvage(opts?: Paths): SalvagePreview {
  const configPath = activeConfigPath(opts);
  const storePath = activeStorePath(opts);
  const ownership = inspectOwnership(readFileOrNull(configPath));
  const body = ownership.state === "owned" ? decodeBasicString(ownership.literal) : null;
  return {
    body,
    // `dirname`, not a hand-rolled `lastIndexOf("/")`: a Windows store path is
    // `D:\...\store.toml`, which contains no forward slash at all, so the
    // slice returned `"."` and the preview named the wrong directory.
    backupDir: dirname(storePath),
    unrecoverable: UNRECOVERABLE,
    reason: body !== null && body.length > 0 ? "ok" : "nothing_to_salvage",
  };
}

/**
 * Adopt the live projection as ONE layer. A durable backup is written first and
 * salvage aborts if it cannot be created — a destructive operation whose safety
 * net failed should not proceed.
 */
export function salvageProjection(revision: string, opts?: Paths): WriteResult {
  const preview = previewSalvage(opts);
  if (preview.reason !== "ok" || preview.body === null) {
    return { ok: false, error: "developer_instructions_not_owned", detail: "no live projection to salvage" };
  }
  const body = preview.body;
  const storePath = activeStorePath(opts);
  const backupPath = `${storePath.replace(/\.json$/, "")}.salvage-${Date.now()}-${randomBytes(3).toString("hex")}.txt`;
  try {
    durableWriteExclusive(backupPath, body);
  } catch {
    return { ok: false, error: "recovery_required", detail: `could not write a durable backup at ${backupPath}` };
  }
  return commit(opts, revision, (_snapshot, configBytes) => {
    const salvaged: CustomLayer = {
      id: newLayerId([]),
      title: "Salvaged from config.toml",
      body,
      enabled: true,
    };
    return {
      nextConfig: setProjection(configBytes, body),
      nextStore: serializeStore([salvaged]),
    };
  });
}
