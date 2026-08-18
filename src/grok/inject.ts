import { constants, copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../config";
import { applyEol, dominantEol, isLoopbackHostname, providerBaseHost } from "../codex/inject";

export interface GrokInjectModel {
  id: string;
  name?: string;
  contextWindow?: number;
}

export interface GrokInjectResult {
  ok: boolean;
  changed: boolean;
  message: string;
  skippedReason?: "no-grok-home" | "orphaned-marker" | "non-loopback";
}

const BEGIN_MARKER = "# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>";
const END_MARKER = "# <<< opencodex managed block <<<";
// grok 0.2.101 verified live (2026-07-23): [model_providers.<id>] inheritance parses but the
// inherited base_url is NOT applied to inference routing — the turn falls through to the default
// cli-chat-proxy and 401s. Per-model direct fields DO route. So every [model.*] block carries its
// own base_url/api_backend/api_key and no [model_providers] table is emitted at all.

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
/**
 * User-owned model table headers. Also matches array-of-table (`[[model.x]]`) and sub-table
 * (`[model.x.sub]`) spellings. `[[model.x]]` genuinely collides with a generated `[model.x]`,
 * and one collision makes grok reject the ENTIRE config layer ("duplicate key"), taking every
 * unrelated user setting with it; `[model.x.sub]` does not strictly collide, but reserving it
 * costs only a suffixed alias and keeps us clear of the user's namespace.
 *
 * Every character class here is newline-free ON PURPOSE. With `[^\]]*` the optional sub-table
 * tail runs past the end of its own line, so an unclosed `[model.…` inside a multiline string
 * swallows the following lines — including a real `[model.<alias>]` header, which then goes
 * unreserved and produces the very duplicate-key config this scan exists to prevent.
 */
const MODEL_TABLE_HEADER = new RegExp(
  String.raw`^[ \t]*\[\[?[ \t]*(${KEY_SEGMENT})[ \t]*\.[ \t]*(${KEY_SEGMENT})[ \t]*(?:\.[^\]\r\n]*)?\]\]?[ \t]*(?:#.*)?$`,
  "gm",
);

/**
 * ANY table header, capturing its full dotted key. Used to compute table SPANS: a table
 * body runs from its own header to the next header of any kind, so the orphan sweep can
 * remove a whole table instead of a guessed line range (a partial removal would re-parent
 * the leftover keys onto the preceding table).
 */
const ANY_TABLE_HEADER = /^[ \t]*\[\[?[ \t]*([^\]\r\n]*?)[ \t]*\]\]?[ \t]*(?:#.*)?$/gm;

/** Resolve a header key segment (bare / basic / literal) to the key it actually addresses. */
function canonicalKeySegment(raw: string): string {
  if (raw.startsWith('"')) return decodeTomlBasicString(raw.slice(1, -1));
  if (raw.startsWith("'")) return raw.slice(1, -1); // literal strings have no escapes
  return raw;
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
  for (const match of outsideManagedRegion.matchAll(MODEL_TABLE_HEADER)) {
    if (canonicalKeySegment(match[1]!) !== "model") continue;
    aliases.add(canonicalKeySegment(match[2]!));
  }
  return aliases;
}

/**
 * The api_key literal every generated entry carries. It is the STRONG ownership signal:
 * a value we mint, that a human has no reason to type by hand.
 */
const OPENCODEX_API_KEY = "opencodex-loopback";

/** A plain `[model.<alias>]` table outside the fence that opencodex itself wrote. */
interface OrphanTable {
  alias: string;
  /** The model id this entry routes to — used to find its replacement alias. */
  modelId: string | undefined;
  /** Offsets into the NORMALIZED content: header start .. next header start (or EOF). */
  start: number;
  end: number;
}

/** `key = "value"` / `key = value` pairs at the top level of one table body. */
function tableBodyKeys(body: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const line of body.split("\n")) {
    const match = /^[ \t]*([A-Za-z0-9_-]+)[ \t]*=[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!match) continue;
    const raw = match[2]!;
    const value = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2
      ? decodeTomlBasicString(raw.slice(1, -1))
      : raw;
    if (!keys.has(match[1]!)) keys.set(match[1]!, value);
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
 * hand-written user model:
 *   - a plain `[model.x]` header (never `[[model.x]]` / `[model.x.sub]` — those spellings
 *     mark human authorship and stay reserved);
 *   - `api_key` equal to our own literal;
 *   - a loopback `base_url`, so an entry that merely copied our key while pointing at a
 *     remote host is left alone.
 * A loopback base_url ALONE is not enough: aiming your own model at the local proxy is a
 * legitimate thing to do.
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
  const headers: Array<{ index: number; length: number; segments: string[]; array: boolean }> = [];
  for (const match of content.matchAll(ANY_TABLE_HEADER)) {
    headers.push({
      index: match.index!,
      length: match[0].length,
      segments: match[1]!.split(".").map(part => canonicalKeySegment(part.trim())),
      array: match[0].trimStart().startsWith("[["),
    });
  }
  for (const [position, header] of headers.entries()) {
    if (header.array || header.segments.length !== 2 || header.segments[0] !== "model") continue;
    // Inside the fence the regular splice already owns it.
    if (region && header.index >= region.start && header.index < region.end) continue;
    const bodyEnd = clampEnd(header.index, headers[position + 1]?.index ?? content.length);
    const keys = tableBodyKeys(content.slice(header.index + header.length, bodyEnd));
    if (keys.get("api_key") !== OPENCODEX_API_KEY) continue;
    if (!isLoopbackBaseUrl(keys.get("base_url"))) continue;
    // Swallow the entry's OWN sub-tables (`[model.<alias>.extra_headers]`). Grok writes
    // them when it re-serializes the file, and leaving one behind keeps the alias
    // reserved by `userModelAliases` — so the sweep would remove the parent and STILL
    // allocate a suffixed duplicate, which is the exact #511 loop we came to close.
    let end = bodyEnd;
    for (let next = position + 1; next < headers.length; next += 1) {
      const child = headers[next]!;
      // Only a PRE-fence parent may be cut short by the fence. Without the parent test a
      // below-fence orphan would break on its first child (every index is past the fence),
      // leaving the sub-table behind to keep the alias reserved — the -2 loop again.
      if (fenceStart >= 0 && header.index < fenceStart && child.index >= fenceStart) break;
      if (child.segments.length <= 2) break;
      if (child.segments[0] !== "model" || child.segments[1] !== header.segments[1]) break;
      end = clampEnd(header.index, headers[next + 1]?.index ?? content.length);
    }
    orphans.push({ alias: header.segments[1]!, modelId: keys.get("model"), start: header.index, end });
  }
  return orphans;
}

/** Remove whole tables, back to front so earlier offsets stay valid. */
function removeOrphanTables(content: string, orphans: OrphanTable[]): string {
  let next = content;
  for (const orphan of [...orphans].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, orphan.start) + next.slice(orphan.end);
  }
  return next;
}

/**
 * Repoint `default` / `fork_secondary_model` at the alias that survived.
 *
 * Removing an adopted orphan that `[models] default` names would leave Grok pointing at
 * a model that no longer exists — and on a real machine `default` DOES name one, so this
 * is the common path rather than an edge case.
 */
function rewriteAliasReferences(content: string, renames: Map<string, string>): string {
  if (renames.size === 0) return content;
  return content.replace(
    /^([ \t]*(?:default|fork_secondary_model)[ \t]*=[ \t]*")([^"]*)(")/gm,
    (whole, prefix: string, value: string, suffix: string) => {
      const replacement = renames.get(value);
      return replacement ? `${prefix}${replacement}${suffix}` : whole;
    },
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
    const isFirst = lines.length === 1;
    lines.push(
      ...(isFirst ? [] : [""]),
      `[model.${alias}]`,
      `model = ${tomlString(model.id)}`,
      `base_url = ${tomlString(baseUrl)}`,
      'api_backend = "responses"',
      'api_key = "opencodex-loopback"',
      `name = ${tomlString(model.name ?? `OCX ${model.id}`)}`,
      // Best-effort attribution tag for the usage dashboard. Upstream Grok sends
      // extra_headers verbatim on inference calls (11-custom-models.md). This is NOT a
      // security boundary — any loopback client could send the same header.
      'extra_headers = { "x-opencodex-grok" = "1" }',
    );
    if (Number.isFinite(model.contextWindow) && (model.contextWindow ?? 0) > 0) {
      lines.push(`context_window = ${model.contextWindow}`);
    }
  }

  lines.push(END_MARKER);
  return lines.join("\n");
}

export function injectGrokConfig(
  port: number,
  models: GrokInjectModel[],
  opts: { grokHome?: string; hostname?: string; excluded?: ReadonlySet<string> } = {},
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

    // Adopt our own pre-fence entries (#511) BEFORE reserving user aliases, so the stale
    // duplicate is replaced instead of routed around forever. Runs inside the normalized
    // window so the user's dominant EOL is still restored below.
    const orphans = findOpencodexOrphans(originalContent, originalRegion);
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

    // Repoint `default` / `fork_secondary_model` at whichever alias survived. A removed
    // model with no replacement keeps its reference untouched — a stale name in a working
    // file beats a dangling one.
    if (orphans.length > 0) {
      const survivors = new Map<string, string>();
      for (const match of nextContent.matchAll(MODEL_TABLE_HEADER)) {
        if (canonicalKeySegment(match[1]!) !== "model") continue;
        const alias = canonicalKeySegment(match[2]!);
        const body = nextContent.slice(match.index! + match[0].length);
        const modelId = tableBodyKeys(body.slice(0, body.search(/^[ \t]*\[/m) + 1 || body.length)).get("model");
        if (modelId !== undefined && !survivors.has(modelId)) survivors.set(modelId, alias);
      }
      const renames = new Map<string, string>();
      for (const orphan of orphans) {
        const replacement = orphan.modelId === undefined ? undefined : survivors.get(orphan.modelId);
        if (replacement && replacement !== orphan.alias) renames.set(orphan.alias, replacement);
      }
      nextContent = rewriteAliasReferences(nextContent, renames);
    }

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
    const region = findManagedRegion(content);
    if (!region) {
      return { ok: true, changed: false, message: "No opencodex managed block found in Grok config." };
    }
    if (region.orphaned) return orphanedMarkerResult("cleanup");

    let removalEnd = region.end;
    if (content.startsWith("\n", removalEnd)) removalEnd += 1;
    let prefix = content.slice(0, region.start);
    const restOfFile = content.slice(removalEnd);
    // Undo the single separator newline injection added. Two cases, mirroring inject:
    //   "X\n"  -> "X\n" + "\n" + block  => prefix ends "\n\n", drop one.
    //   "X"    -> "X"   + "\n" + block  => prefix ends "\n" at EOF, drop it.
    // A block the user has appended content after is left alone: we never shrink their bytes.
    if (prefix.endsWith("\n\n")) prefix = prefix.slice(0, -1);
    else if (restOfFile.length === 0 && prefix.endsWith("\n")) prefix = prefix.slice(0, -1);
    const stripped = prefix + restOfFile;
    atomicWriteFile(configPath, applyEol(stripped, eol));

    return {
      ok: true,
      changed: true,
      message: "Removed the opencodex managed block from Grok config.",
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
