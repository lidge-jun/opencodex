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
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes, type Hash } from "node:crypto";
import { expandUserPath } from "../config";
import { CODEX_CONFIG_PATH } from "./paths";
import { resolveCodexHomeDir } from "./home";
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
  /**
   * Commit and pull-request attribution, contributed by `ext/git-attribution` rather
   * than by a world_state.rs section — which is why it is absent from the order list
   * above and carries `order: null`: it registers through
   * `extensions.context_contributors()` (`core/src/session/world_state.rs:64-66`),
   * whose position is registration-order dependent.
   *
   * `runtime-conditional`, NOT feature-gated. `ext/git-attribution/src/lib.rs:33-80`
   * resolves enablement from the AUTH SERVER via `resolve_attribution_policy`, caches
   * it on the thread store, and falls back to disabled when the lookup fails.
   * `features/src/lib.rs:277` records the old config flag as removed, so there is no
   * key for this GUI to write and nothing in [features] to point a user at.
   *
   * Both states emit text: enabled sends the `Co-authored-by: Codex` trailer plus the
   * `Generated with Codex.` PR marker, disabled sends an explicit countermand. So the
   * row's condition line must name the policy rather than claiming "always on".
   */
  { id: "git-attribution", class: "runtime-conditional", key: null, default: null, order: null },
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
  baseVariantDir?: string;
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

/**
 * Where authored base-prompt variants live, one markdown file per variant.
 *
 * A directory of real files rather than another JSON store, because
 * `model_instructions_file` points Codex at a path it reads directly. Embedding the
 * bodies in `opencodex-prompt.json` would mean materialising a temp file at selection
 * time, which is a second write path for no gain.
 */
export function activeBaseVariantDir(opts?: Paths): string {
  return opts?.baseVariantDir ?? join(activeCodexHome(), "opencodex-prompt-base");
}

/**
 * Instruction documents the prompt probe renders out of CODEX_HOME, in the
 * precedence order Codex itself applies: an `AGENTS.override.md` shadows
 * `AGENTS.md`. Both are hashed into the probe fingerprint, because either one
 * changes the rendered project document without touching a managed file.
 */
const PROBE_INSTRUCTION_FILES = ["AGENTS.override.md", "AGENTS.md"] as const;

/**
 * The project-document filenames Codex would look for in a given home, in its own
 * order: the two built-ins first, then whatever `project_doc_fallback_filenames`
 * adds, de-duplicated (`core/src/agents_md.rs` `candidate_filenames`).
 *
 * Read from config rather than hard-coded, because a user who configures
 * `TEAM.md` renders TEAM.md, and a fingerprint that only knew about AGENTS.md
 * would let an edit to it pass unnoticed.
 *
 */
function probeInstructionFilenames(configBytes: string | null): string[] {
  const names: string[] = [...PROBE_INSTRUCTION_FILES];
  for (const entry of rootArrayEntries(configBytes, "project_doc_fallback_filenames")) {
    // Upstream trims each configured name and drops whitespace-only entries
    // (`core/src/config/mod.rs`), so " TEAM.md " and "TEAM.md" are one filename.
    const name = entry.trim();
    if (name === "") continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Decoded string entries of a root-scope TOML array.
 *
 * Parsed, not pattern-matched. Three successive review rounds each found another
 * valid spelling a hand-rolled reader missed — multi-line arrays, a comment after the
 * opening bracket, a quoted key — and every miss was a rendered document whose edits
 * moved no admission key. The pattern was the defect: TOML is not a line format, so
 * no regex over lines can enumerate what a parser accepts.
 *
 * The module header's warning about JS TOML parsers does apply here, and a review
 * round proved it against an earlier version of this comment that claimed otherwise.
 * Bun rejects an entire document containing an integer outside JavaScript's safe
 * range, such as `model_context_window = 9223372036854775807`, which Rust accepts as
 * an ordinary `i64`. A whole-document parse turned that into BOTH arrays disappearing
 * — a worse failure than any single missed spelling, and one the old regex did not
 * have.
 *
 * So the parse is the preferred reader, not the only one. When it fails, the scan
 * below runs, and it is deliberately loose: it accepts any spelling it recognises and
 * over-reports rather than under-reports, because an extra hashed filename costs one
 * redundant probe while a missing one costs stale text.
 */
function rootArrayEntries(configBytes: string | null, key: string): string[] {
  const value = rootValue(configBytes, key);
  if (value === PARSE_FAILED) return scanRootArrayEntries(configBytes, key);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Distinguishes "the parser could not read this file" from "the key is absent".
 * Collapsing the two is what made an unrelated large integer silently empty the
 * project-document set.
 */
const PARSE_FAILED = Symbol("toml-parse-failed");

/** A root-scope value, `undefined` when the key is absent, `PARSE_FAILED` when the file will not parse. */
function rootValue(configBytes: string | null, key: string): unknown {
  if (configBytes === null) return undefined;
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(configBytes);
  } catch {
    return PARSE_FAILED;
  }
  if (typeof parsed !== "object" || parsed === null) return PARSE_FAILED;
  return (parsed as Record<string, unknown>)[key];
}

/**
 * Fallback reader for a config this parser will not accept but Codex will.
 *
 * Not a second attempt at being a TOML parser — that approach failed three review
 * rounds. It is a deliberately over-eager scan: it takes the first bracketed group for
 * the key under either spelling, spans lines, strips comments, and keeps anything that
 * decodes. Over-reporting is the safe direction here.
 */
function scanRootArrayEntries(configBytes: string | null, key: string): string[] {
  const lines = rootLines(configBytes ?? "");
  const opener = new RegExp(`^\\s*"?${key}"?\\s*=\\s*\\[(.*)$`);
  for (let i = 0; i < lines.length; i += 1) {
    const m = opener.exec(lines[i]!);
    if (!m) continue;
    let body = m[1]!.replace(/#.*$/, "");
    for (let j = i; !body.includes("]"); ) {
      j += 1;
      if (j >= lines.length) return [];
      body += lines[j]!.replace(/#.*$/, "");
    }
    const out: string[] = [];
    for (const raw of body.slice(0, body.indexOf("]")).split(",")) {
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      const decoded = trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2
        ? trimmed.slice(1, -1)
        : decodeBasicString(trimmed);
      if (decoded !== null) out.push(decoded);
    }
    return out;
  }
  return [];
}

/**
 * The directories Codex would look in for a project document, given the home the
 * probe runs in.
 *
 * Upstream finds the nearest ancestor holding a `project_root_markers` entry
 * (default `.git`) and then searches every directory from that root down to the cwd,
 * inclusive; with no such ancestor it searches the cwd alone
 * (`core/src/agents_md.rs` `agents_md_paths`).
 *
 * This was originally written off as unreachable on the grounds that the probe runs
 * in CODEX_HOME with no checkout around it. That was wrong, and a review round caught
 * it: `~/.codex` inside a dotfiles repository is an ordinary setup, and there the
 * walk finds real documents. The walk is cheap — a bounded number of `existsSync`
 * calls beside a subprocess spawn — so it is performed rather than assumed away.
 */
function probeProjectDocDirs(home: string, configBytes: string | null): string[] {
  const markers = projectRootMarkers(configBytes);
  // An explicitly empty array disables root detection upstream, which is not the same
  // as an absent key falling back to the default.
  if (markers.length === 0) return [home];
  let root: string | null = null;
  for (let dir = home; ; ) {
    if (markers.some(marker => existsSync(join(dir, marker)))) { root = dir; break; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (root === null) return [home];
  const dirs: string[] = [];
  for (let dir = home; ; ) {
    dirs.push(dir);
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Root first, matching upstream's reversed search order. Order is load-bearing:
  // the digest must not change merely because the walk was traversed the other way.
  return dirs.reverse();
}

/** `project_root_markers`, defaulting to `.git` when the key is absent. */
function projectRootMarkers(configBytes: string | null): string[] {
  if (!hasRootKey(configBytes, "project_root_markers")) return [".git"];
  // Present-but-empty disables root detection upstream, which is why presence is
  // tested separately from the decoded entries rather than inferred from them.
  return rootArrayEntries(configBytes, "project_root_markers").filter(m => m !== "");
}

/**
 * Whether a root-scope key is present at all, regardless of what it holds.
 *
 * A parse failure is not an answer, so it falls through to the scan rather than
 * counting as present: reading `PARSE_FAILED` as "present" would report an empty
 * marker list and disable root detection on a config Codex reads fine.
 */
function hasRootKey(configBytes: string | null, key: string): boolean {
  const value = rootValue(configBytes, key);
  if (value === PARSE_FAILED) return scanHasRootKey(configBytes, key);
  return value !== undefined;
}

/** Textual presence check, used only when the parser cannot read the file. */
function scanHasRootKey(configBytes: string | null, key: string): boolean {
  const probe = new RegExp(`^\\s*"?${key}"?\\s*=`);
  return rootLines(configBytes ?? "").some(line => probe.test(line));
}

/**
 * Feed one named field into a fingerprint, framed so that no two distinct states
 * can produce the same digest.
 *
 * Framing is the whole point. Concatenating `name + ":" + contents` is ambiguous:
 * an adversarial review of the first version of this function showed that
 * `{override: "left", agents: "right\nAGENTS.md:tail"}` and
 * `{override: "left\nAGENTS.md:right", agents: "tail"}` hashed identically, because
 * a file's own bytes can imitate the separator that follows it. That is exactly a
 * missed invalidation: the fingerprint is the probe's admission key, so two
 * different prompt states sharing a digest means one caller is served the other's
 * stale text.
 *
 * A byte length cannot be forged by content, so each field carries one. Absence is
 * a length of -1 rather than a sentinel string, because a sentinel is just more
 * content: the same review found that `null` collided with a file whose bytes were
 * literally NUL + "absent".
 */
function updateFingerprintField(hash: Hash, name: string, contents: string | null): void {
  const bytes = contents === null ? -1 : Buffer.byteLength(contents, "utf8");
  hash.update(`\n${name}:${bytes}:`);
  if (contents !== null) hash.update(contents);
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
  // Length-framed for the reason given on updateFingerprintField: with a bare
  // separator, config bytes ending in "\nstore:" shift the boundary and two
  // different pairs hash alike. That matters twice over — this value is both the
  // probe's admission input and the optimistic-concurrency token compared in
  // commit(), where a collision would let a write built on stale bytes through.
  updateFingerprintField(hash, "cfg", configBytes);
  updateFingerprintField(hash, "store", storeBytes);
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

/** One authored base-prompt variant. `default` is never represented here. */
export interface BaseVariant {
  id: string;
  title: string;
  body: string;
  bytes: number;
}

/**
 * Which base prompt is in force. THREE values, not two.
 *
 * - `default` — `model_instructions_file` is absent, so Codex uses its own base prompt.
 *   This is the absence of a key, not a body we store: there is nothing to edit and
 *   nothing to delete, which is what makes the default structurally immutable rather
 *   than merely guarded.
 * - a variant id — the key points inside our own variant directory.
 * - `external` — the key is set and points somewhere else.
 *
 * The third value is load-bearing and an audit forced it. Collapsing it into `default`
 * would have shown a user "Codex's own base prompt" while their base prompt was in fact
 * replaced by a file they had set by hand. The panel already ships a notice for that
 * state in ten locales; this keeps reporting it instead of overwriting a key we do not
 * own.
 */
export type BaseSelection = { kind: "default" } | { kind: "variant"; id: string } | { kind: "external"; path: string };

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
  baseVariants: BaseVariant[];
  baseSelection: BaseSelection;
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
    // Capture the whole literal INCLUDING its quotes and decode it, rather than
    // returning the raw inner text. `setRootString` writes this key through
    // `encodeBasicString`, which escapes backslashes, so on Windows the stored
    // literal is "C:\\Users\\..." while the path is "C:\Users\...". Reading the
    // inner text verbatim returned the doubled form: the round trip did not
    // survive, `baseSelection` compared a doubled path against the real variant
    // path and reported `external` for a variant this code had just selected.
    //
    // `[^"]*` cannot span an escaped quote either. That is not a new limit -- it
    // is the same one the writer's restricted escape set is built around, and
    // `decodeBasicString` refuses anything outside it rather than guessing.
    const m = /^\s*model_instructions_file\s*=\s*("[^"]*")\s*(?:#.*)?$/.exec(line);
    if (m) return decodeBasicString(m[1]!);
  }
  return null;
}

/** Variant ids are ours to generate, so they stay in one narrow shape. */
const BASE_VARIANT_ID = /^[a-z0-9]{6}$/;

/**
 * The variant files on disk, newest-id-last so the picker order is stable.
 *
 * `default.md` is SKIPPED rather than read: `default` names the absence of a key, so a
 * file claiming that id would appear as a fourth variant whose selection could never be
 * expressed. Anything not matching our own id shape is skipped for the same reason - we
 * only report what we could also write.
 */
export function readBaseVariants(opts?: Paths): BaseVariant[] {
  const dir = activeBaseVariantDir(opts);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Absent directory is an ordinary first run, not an error.
    return [];
  }
  const out: BaseVariant[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".md")) continue;
    const id = name.slice(0, -3);
    if (!BASE_VARIANT_ID.test(id)) continue;
    const body = readFileOrNull(join(dir, name));
    if (body === null) continue;
    // First line is the title when it is a markdown heading; the rest is the prompt.
    // Storing the title inside the file keeps one artifact per variant instead of a
    // sidecar index that can disagree with it.
    const nl = body.indexOf("\n");
    const firstLine = nl === -1 ? body : body.slice(0, nl);
    const titled = firstLine.startsWith("# ");
    out.push({
      id,
      title: titled ? firstLine.slice(2).trim() : id,
      body: titled ? body.slice(nl === -1 ? body.length : nl + 1) : body,
      bytes: Buffer.byteLength(body, "utf8"),
    });
  }
  return out;
}

/**
 * Resolve which base prompt is in force, given the config bytes and the variants.
 *
 * Comparison is by RESOLVED path: `~/.codex/opencodex-prompt-base/abc123.md` and an
 * absolute spelling of the same file are the same selection, and treating them as
 * different would report `external` for a variant we wrote ourselves.
 */
export function resolveBaseSelection(
  configBytes: string | null,
  variants: readonly BaseVariant[],
  opts?: Paths,
): BaseSelection {
  const raw = readModelInstructionsFile(configBytes);
  if (raw === null) return { kind: "default" };
  const dir = activeBaseVariantDir(opts);
  let resolved: string;
  try {
    resolved = resolve(expandUserPath(raw));
  } catch {
    return { kind: "external", path: raw };
  }
  for (const variant of variants) {
    if (resolved === resolve(join(dir, `${variant.id}.md`))) {
      return { kind: "variant", id: variant.id };
    }
  }
  return { kind: "external", path: raw };
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
  const baseVariants = readBaseVariants(opts);

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
    baseVariants,
    baseSelection: resolveBaseSelection(configBytes, baseVariants, opts),
    revision: computeRevision(configBytes, storeBytes),
  };
}

/**
 * Identity for prompt-text probe admission, deliberately separate from the
 * optimistic-concurrency revision above. The revision covers only config/store
 * transaction bytes; an edit to the selected base variant changes the prompt
 * without changing that transaction contract.
 *
 * The instruction documents in CODEX_HOME are hashed for the same reason, and they
 * are read from `resolveCodexHomeDir()` rather than from `activeConfigPath`'s
 * directory. Those two are deliberately different under test — the route fixtures
 * inject `codexPromptPaths` at a temp root while CODEX_HOME points at a decoy — and
 * the probe renders whatever lives in the home it actually runs in. Deriving the
 * path from the injected config would name a file the probe never reads, which is
 * a fingerprint that cannot fail rather than evidence.
 *
 * A BOUNDED invalidation key, not prompt identity. It covers opencodex-managed writes,
 * the selected base prompt, the project documents Codex would discover from this home,
 * and each skill's manifest. Plugin manifests, live MCP availability, and the clock
 * also move the rendered prompt and are not files this process can name.
 *
 * The distinction is worth stating exactly, because the obvious phrasing is wrong: for
 * a COVERED input the key moves and a late caller is refused with `busy`. For an
 * UNCOVERED one the key does not move, so a late caller joins and reads the older
 * rendering. That is the residual, bounded to one in-flight window in a read-only view.
 *
 * "Hash every input" is only closable against a pinned Codex — the dependency graph is
 * upstream's and moves on its own. An enumeration-free alternative exists (admit only
 * when the probe started after the request arrived) and is recorded in the plan; it
 * costs the coalescing this work exists to provide unless arrivals are batched first.
 * See devlog/_plan/260829_bugpr_lane_h_residual_issues/130_pr2872_probe_fingerprint.md.
 */
export function computePromptProbeStateFingerprint(opts?: Paths): string {
  const configBytes = readFileOrNull(activeConfigPath(opts));
  const storeBytes = readFileOrNull(activeStorePath(opts));
  const variants = readBaseVariants(opts);
  const selection = resolveBaseSelection(configBytes, variants, opts);
  const hash = createHash("sha256");
  updateFingerprintField(hash, "revision", computeRevision(configBytes, storeBytes));
  updateFingerprintField(hash, "selected-base", selection.kind === "variant" ? `variant:${selection.id}` : selection.kind);
  if (selection.kind === "variant") {
    updateFingerprintField(hash, "variant-bytes", readFileOrNull(join(activeBaseVariantDir(opts), `${selection.id}.md`)));
  }
  if (selection.kind === "external") {
    // The selected base file is hashed whether or not we manage it. Hashing the
    // managed variant's bytes while recording an external selection as the bare
    // word "external" would make the guarantee depend on who authored the file,
    // which is not a distinction the probe's caller can see.
    //
    // Its path is part of the identity as well as its contents: pointing the key
    // at a different file changes the prompt even when both files read alike.
    updateFingerprintField(hash, "external-path", selection.path);
    let externalBytes: string | null = null;
    try {
      // Relative to the CONFIG FILE's directory, which is what Codex does with its
      // relative path fields. resolve() alone would use this process's cwd — the
      // proxy's working directory, which has nothing to do with either the config
      // or the probe child's cwd — and would hash an unrelated file.
      externalBytes = readFileOrNull(resolve(dirname(activeConfigPath(opts)), expandUserPath(selection.path)));
    } catch {
      // An unresolvable path is a state, not a failure: it hashes as absent, and
      // resolveBaseSelection has already reported the selection as external.
      externalBytes = null;
    }
    updateFingerprintField(hash, "external-bytes", externalBytes);
  }
  // Codex prefers AGENTS.override.md over AGENTS.md, so both spellings are hashed
  // in that order: an override edit changes the rendered project document exactly
  // as a plain edit does.
  const probeHome = resolveCodexHomeDir();
  const filenames = probeInstructionFilenames(configBytes);
  for (const dir of probeProjectDocDirs(probeHome, configBytes)) {
    for (const name of filenames) {
      // The path goes in the CONTENTS, never in the field name. Only contents are
      // length-framed, so a name built from a path would reintroduce exactly the
      // ambiguity this helper exists to remove. Path and bytes are separate fields
      // because two directories in the walk can both hold an AGENTS.md.
      const path = join(dir, name);
      updateFingerprintField(hash, "doc-path", path);
      updateFingerprintField(hash, "doc-bytes", readFileOrNull(path));
    }
  }
  for (const path of probeSkillManifests(probeHome)) {
    updateFingerprintField(hash, "skill-path", path);
    updateFingerprintField(hash, "skill-bytes", readFileOrNull(path));
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * `SKILL.md` manifests under the home's skills directory.
 *
 * These were written off as unobservable in an earlier version of this function's
 * comment. They are not: Codex reads each manifest's frontmatter and renders its
 * description into `<skills_instructions>`, and a review round demonstrated a live
 * description edit changing the probe's output while the fingerprint stood still.
 *
 * One directory listing plus one `readFileOrNull` per skill, beside a subprocess that
 * costs orders of magnitude more. Sorted, because `readdirSync` order is not a
 * contract and a digest must not depend on it.
 *
 * Only the top-level manifest per skill is read. A skill's bundled scripts and
 * references do not reach the rendered section, so hashing the whole tree would buy
 * redundant invalidations at a real cost on large skill sets.
 */
function probeSkillManifests(home: string): string[] {
  const root = join(home, "skills");
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const manifests: string[] = [];
  for (const entry of entries.sort()) {
    const manifest = join(root, entry, "SKILL.md");
    if (existsSync(manifest)) manifests.push(manifest);
  }
  return manifests;
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
  // The filesystem refused a rename that passed every precondition: a directory on
  // the store path, a mode change, a full disk. Distinct from write_superseded,
  // which means another writer won a race — here nobody won and nothing landed.
  | "write_failed"
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

/**
 * A leading UTF-8 BOM, split off so line editing never steps over it.
 *
 * Codex reads config.toml with Rust `toml_edit`, which accepts a BOM at byte 0 and
 * nowhere else. Inserting the generated block at line index 0 pushed the BOM down
 * to byte 58, the write reported success because our own byte comparison matched
 * what we intended to write, and the next parse failed with
 * "Expected a key but found (0xEF)" — a config file the user could no longer load,
 * produced by a write that told them it worked.
 *
 * Editors on Windows write this byte routinely, so the file is not exotic.
 */
function splitBom(content: string): { bom: string; body: string } {
  return content.startsWith("\ufeff")
    ? { bom: "\ufeff", body: content.slice(1) }
    : { bom: "", body: content };
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
  const { bom, body } = splitBom(content);
  const lines = splitLines(body);
  const limit = firstTableIndex(lines);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^(\\s*${escaped}\\s*=\\s*)(?:true|false)(\\s*(?:#.*)?)$`);
  for (let i = 0; i < limit; i += 1) {
    const m = pattern.exec(lines[i]!);
    if (m) {
      lines[i] = `${m[1]}${value}${m[2]}`;
      return bom + joinLines(lines, eol);
    }
  }
  lines.splice(limit, 0, `${key} = ${value}`);
  return bom + joinLines(lines, eol);
}

/**
 * Set or REMOVE a root-scope basic string. `null` removes the key.
 *
 * Removal is what selecting the default variant does, and it has to be a real deletion
 * rather than an empty string: `model_instructions_file = ""` is a path Codex would try
 * to read, not an absent setting.
 */
function setRootString(content: string, key: string, value: string | null): string {
  const eol = dominantEol(content);
  const { bom, body } = splitBom(content);
  const lines = splitLines(body);
  const limit = firstTableIndex(lines);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}\\s*=\\s*"[^"]*"\\s*(?:#.*)?$`);
  for (let i = 0; i < limit; i += 1) {
    if (!pattern.test(lines[i]!)) continue;
    if (value === null) lines.splice(i, 1);
    else lines[i] = `${key} = ${encodeBasicString(value)}`;
    return bom + joinLines(lines, eol);
  }
  if (value === null) return bom + joinLines(lines, eol);
  lines.splice(limit, 0, `${key} = ${encodeBasicString(value)}`);
  return bom + joinLines(lines, eol);
}

/** Set a boolean inside `[table]`, appending the table when absent. */
function setTableBool(content: string, table: string, key: string, value: boolean): string {
  const eol = dominantEol(content);
  const { bom, body } = splitBom(content);
  const lines = splitLines(body);
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex(l => new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`).test(l));
  if (start === -1) {
    const tail = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    lines.splice(tail, 0, `[${table}]`, `${key} = ${value}`);
    return bom + joinLines(lines, eol);
  }
  const keyEscaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^(\\s*${keyEscaped}\\s*=\\s*)(?:true|false)(\\s*(?:#.*)?)$`);
  let end = start + 1;
  while (end < lines.length && !TABLE_HEADER.test(lines[end]!)) end += 1;
  for (let i = start + 1; i < end; i += 1) {
    const m = pattern.exec(lines[i]!);
    if (m) {
      lines[i] = `${m[1]}${value}${m[2]}`;
      return bom + joinLines(lines, eol);
    }
  }
  lines.splice(end, 0, `${key} = ${value}`);
  return bom + joinLines(lines, eol);
}

/**
 * Replace, insert, or remove the generated two-line block. Canonical form is
 * marker + assignment at the top of the document; replacement is "find the
 * marker, replace the next line" rather than a span search.
 */
function setProjection(content: string | null, projection: string | null): string {
  const base = content ?? "";
  const eol = dominantEol(base);
  // The BOM is held aside for the whole edit. This is the function that produced
  // the corruption: the insert below is at index 0, which put the marker line
  // ahead of a byte that is only legal at byte 0.
  const { bom, body } = splitBom(base);
  const lines = splitLines(body);
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
    return bom + joinLines(lines, eol);
  }

  if (projection === null) return bom + joinLines(lines, eol);
  lines.splice(0, 0, OCX_SECTION_MARKER, `${DEV_INSTRUCTIONS_KEY} = ${encodeBasicString(projection)}`);
  return bom + joinLines(lines, eol);
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

    const snapshot = readPromptLayers({ ...opts, configPath, storePath });
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
    //
    //      Wrapped, because a THROW here used to escape the transaction entirely.
    //      Only `config` readability is pre-checked, so an unwritable STORE — a
    //      directory sitting on its path, a permission change, a full disk — raised
    //      out of `durableWrite` after the config had already been renamed into
    //      place. The caller saw an exception, the config carried a projection whose
    //      store did not exist, and the journal stayed behind claiming an
    //      uncommitted intent. Every later write then failed recovery_required.
    //
    //      Rolling back on the way out restores the pre-state we recorded and drops
    //      the journal, so a failed write leaves the pair exactly as it was found.
    try {
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
    } catch (error) {
      // `rollback` is byte-hash driven and refuses to touch a file it does not
      // recognise, so it is safe to run against a partially applied pair. If it
      // cannot account for what it finds it returns recovery_required, which is the
      // honest answer — better than a silent half-write either way.
      const undone = rollback(record, journalPath, "write_failed");
      return { ...undone, detail: error instanceof Error ? error.message : String(error) } as WriteResult;
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
    // The FULL opts, not just the two paths this transaction owns: rebuilding the
    // snapshot from a narrowed object dropped the injected variant directory, so every
    // successful write reported an empty variant list back to its caller.
    return { ok: true, changed: true, snapshot: readPromptLayers({ ...opts, configPath, storePath }) };
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

/**
 * Point `model_instructions_file` at a variant, or remove it for the default.
 *
 * Refusals, each for a reason the GUI cannot be trusted to enforce alone:
 * - an unknown variant id, because the key would name a file Codex cannot read;
 * - the `external` state, because retargeting a key somebody else set silently
 *   discards their base prompt. Adopting it is a separate, explicit act.
 */
export function selectBaseVariant(selection: BaseSelection, revision: string, opts?: Paths): WriteResult {
  if (selection.kind === "external") return { ok: false, error: "unknown_layer", detail: "cannot select the external state" };
  const dir = activeBaseVariantDir(opts);
  return commit(opts, revision, (snapshot, configBytes, storeBytes) => {
    if (snapshot.baseSelection.kind === "external") {
      return { error: "developer_instructions_not_owned", detail: snapshot.baseSelection.path };
    }
    if (selection.kind === "variant") {
      const variant = snapshot.baseVariants.find(v => v.id === selection.id);
      if (!variant) return { error: "unknown_layer", detail: selection.id };
    }
    const next = selection.kind === "default"
      ? null
      : resolve(join(dir, `${selection.id}.md`));
    return {
      nextConfig: setRootString(configBytes ?? "", "model_instructions_file", next),
      nextStore: storeBytes,
    };
  });
}

/** How many authored variants a user may keep. Two plus the default is the ask. */
export const MAX_BASE_VARIANTS = 2;

/**
 * Write or delete one authored variant body.
 *
 * Ordering is deliberate and was learned from a defect in this same module: the FILE is
 * written and verified before `config.toml` is ever pointed at it. Pointing first would
 * leave the key naming a file that may not exist, which is a worse failure than a written
 * file nothing references yet.
 *
 * Deleting the variant that is currently SELECTED also clears the key in the same
 * transaction, so the config can never outlive the file it names.
 */
export function writeBaseVariant(
  input: { id: string | null; title: string; body: string } | { id: string; delete: true },
  revision: string,
  opts?: Paths,
): WriteResult {
  const dir = activeBaseVariantDir(opts);
  const deleting = "delete" in input;
  if (!deleting) {
    const normalized = normalizeBody(input.body);
    const invalid = findInvalidCharacter(normalized);
    if (invalid !== null) {
      return { ok: false, error: "invalid_characters", detail: `at code point ${invalid.position}` };
    }
  }
  const existing = readBaseVariants(opts);
  const targetId = deleting
    ? input.id
    : input.id ?? newBaseVariantId(existing);
  if (!BASE_VARIANT_ID.test(targetId)) return { ok: false, error: "unknown_layer", detail: targetId };
  if (deleting && !existing.some(v => v.id === targetId)) {
    return { ok: false, error: "unknown_layer", detail: targetId };
  }
  if (!deleting && input.id === null && existing.length >= MAX_BASE_VARIANTS) {
    return { ok: false, error: "unknown_layer", detail: `at most ${MAX_BASE_VARIANTS} variants` };
  }
  const path = join(dir, `${targetId}.md`);
  const before = readFileOrNull(path);
  const next = deleting
    ? null
    : `# ${input.title.replace(/[\r\n]+/g, " ").trim() || targetId}\n${normalizeBody(input.body)}`;

  // Whether this id is the live selection has to be decided while the file still
  // EXISTS. Deleting first made `resolveBaseSelection` fall through to `external` - the
  // path no longer matched a known variant - so the config half saw a state it refuses
  // to touch and left the key pointing at a file that was already gone.
  const selectedBefore = resolveBaseSelection(readFileOrNull(activeConfigPath(opts)), existing, opts);
  const clearingKey = deleting
    && selectedBefore.kind === "variant"
    && selectedBefore.id === targetId;

  // On a CREATE or EDIT the file goes first: pointing config.toml at a file that does
  // not exist yet is worse than writing a file nothing references. On a DELETE the
  // order is reversed for the same reason read the other way - the key must stop
  // naming the file before the file disappears.
  if (!deleting) {
    ensureDir(path);
    try {
      durableWrite(path, next!);
    } catch (error) {
      return { ok: false, error: "write_failed", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  const result = commit(opts, revision, (_snapshot, configBytes, storeBytes) => ({
    nextConfig: clearingKey
      ? setRootString(configBytes ?? "", "model_instructions_file", null)
      : configBytes,
    nextStore: storeBytes,
  }));

  if (!result.ok) {
    // Undo the file half rather than leaving a variant the caller was told was not
    // written. A delete has not touched the file yet, so there is nothing to undo.
    if (!deleting) {
      try {
        if (before === null) durableDelete(path);
        else durableWrite(path, before);
      } catch { /* the returned error already tells the caller to look */ }
    }
    return result;
  }

  if (deleting) {
    try {
      durableDelete(path);
    } catch (error) {
      // The key is already clear, so the prompt is correct; the stale file is inert.
      return { ok: false, error: "write_failed", detail: error instanceof Error ? error.message : String(error) };
    }
    // Re-read so the caller sees the variant actually gone.
    return { ok: true, changed: true, snapshot: readPromptLayers(opts) };
  }
  return result;
}

function newBaseVariantId(existing: readonly BaseVariant[]): string {
  const taken = new Set(existing.map(v => v.id));
  for (;;) {
    const id = randomBytes(4).toString("hex").slice(0, 6);
    if (!taken.has(id)) return id;
  }
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
