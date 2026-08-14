/**
 * The filesystem seam shared by the reader and the writer.
 *
 * It lives in WP2 rather than beside the writer because `readIntegrationState`
 * needs it too, and a reader that disagreed with the writer about what counts
 * as an absent file is exactly how an unreadable config gets overwritten.
 *
 * Design of record: devlog/_fin/260802_client_toggle_api/021 §5-6.
 */
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import type { ConfigFormat } from "../clients/config-export";
import { MAX_JSON_NESTING } from "./serialize";
import { atomicWriteFile } from "../config";
import type { JournalEntry } from "./journal";
import type { OwnershipRecord } from "./ownership";
import type { IntegrationClientId } from "./registry";

/**
 * A parse failure sentinel. This is deliberately ONE symbol exported from ONE
 * module: two `Symbol("parse-failed")` calls produce different values, so a
 * second declaration would not duplicate code — it would make every comparison
 * against it fail, and an unparseable config would be classified `absent` and
 * then overwritten.
 */
export const PARSE_FAILED = Symbol("parse-failed");

/**
 * What `JSON.parse` has already discarded by the time we hold the parsed value,
 * and a rewrite would therefore silently change. Both classes are invisible in
 * the parsed object, which is why this scans the RAW text — same reasoning as
 * the TOML inf/nan guard below.
 *
 * Numbers: `1e999` overflows to Infinity (a rewrite bakes in `null` — the merge
 * layer's JSON clone does it even before the serializer could refuse), `1e-9999`
 * underflows to `+0`, an integer literal may have been rounded (a rewrite then
 * hands consumers that read JSON integers exactly — python, jq, BigInt revivers
 * — a different value), and `-0` re-serializes as `0`. Only literals whose value
 * actually changed are refused: `1e21`, `1e-320` or 2^54 round-trip exactly and
 * stay usable.
 *
 * Duplicate members: `{"a":1,"a":2}` parses to a single `a`, so rewriting the
 * document DELETES the earlier member. That is content loss, not the formatting
 * normalization we promise, and this classifier is what makes the rewrite of a
 * user-edited file reachable at all — so it fails closed here.
 *
 * Depth: the same pass counts container nesting against MAX_JSON_NESTING
 * (shared with the serializer, see serialize.ts). JSON.parse handles hundreds
 * of thousands of levels iteratively, but the downstream merge and
 * JSON.stringify recurse — a 100KB file nested 50k deep sailed through parse
 * and guard, then blew up serialization with a raw RangeError after a
 * multi-GB allocation spike. A hand-written scan rather than a JSON.parse
 * source-access reviver on purpose: the reviver walk recurses internally, so
 * its depth limit would be an unpredictable stack size instead of this
 * deterministic ceiling.
 */
function jsonTextSafeToRewrite(text: string): boolean {
  /**
   * One frame per open container; a Set of member names for objects, null for
   * arrays. Its length is the current nesting depth.
   */
  const containers: Array<Set<string> | null> = [];
  /** The most recent string literal — the member name if a `:` follows. */
  let lastString: string | null = null;
  let inString = false;
  let escaped = false;
  let stringStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") {
        inString = false;
        lastString = text.slice(stringStart, i + 1);
      }
      continue;
    }
    if (ch === "\"") { inString = true; stringStart = i; continue; }
    if (ch === "{" || ch === "[") {
      containers.push(ch === "{" ? new Set<string>() : null);
      if (containers.length > MAX_JSON_NESTING) return false;
      lastString = null;
      continue;
    }
    if (ch === "}" || ch === "]") { containers.pop(); lastString = null; continue; }
    if (ch === ":") {
      const members = containers[containers.length - 1];
      if (members && lastString !== null) {
        /*
         * Decoded, not raw: `"a"` and `"a"` are spellings of ONE member,
         * and JSON.parse keeps only the last of them.
         */
        let name: string;
        try { name = JSON.parse(lastString) as string; } catch { return false; }
        if (members.has(name)) return false;
        members.add(name);
      }
      lastString = null;
      continue;
    }
    if (ch !== "-" && (ch < "0" || ch > "9")) continue;
    let end = i + 1;
    while (end < text.length && /[0-9+\-.eE]/.test(text[end]!)) end += 1;
    const literal = text.slice(i, end);
    i = end - 1;
    const value = Number(literal);
    if (!Number.isFinite(value)) return false;
    if (value === 0) {
      /*
       * `-0` (re-serializes as `0`) and underflow: `1e-9999` is a nonzero
       * value the parse already flattened to `+0`. The significand alone
       * decides, so genuine zero spellings (`0`, `0.0`, `0e10`) stay usable.
       */
      if (literal.startsWith("-") || /[1-9]/.test(literal.split(/[eE]/)[0]!)) return false;
    }
    /*
     * Deliberately plain digit runs only. They are the one spelling real
     * consumers read with exact integer semantics (python's json yields an
     * arbitrary-precision int, jq preserves big integer literals), so baking
     * in the rounded double changes what those consumers extract. Decimal or
     * exponent spellings of the same value (`9007199254740993e0`, `…3.0`) are
     * float semantics for every consumer — they round identically before and
     * after a rewrite, and shortest-round-trip stringify preserves what any
     * reader can observe, so refusing them would only manufacture dead ends
     * (`1e308` is not exactly representable either, yet rewrites losslessly
     * for every possible reader).
     */
    const digits = literal[0] === "-" ? literal.slice(1) : literal;
    if (/^[0-9]{16,}$/.test(digits) && BigInt(literal) !== BigInt(value)) return false;
  }
  return true;
}

/** Parse a client config, tolerating absence. PARSE_FAILED on garbage. */
export function parseConfig(text: string | null, format: ConfigFormat): unknown | typeof PARSE_FAILED {
  if (text === null || text.trim().length === 0) return {};
  try {
    switch (format) {
      case "json": {
        /*
         * Scanned BEFORE parsing: the guard is text-only, and refusing first
         * means a hostile document is never materialized — the depth ceiling
         * would otherwise cap the rewrite only after JSON.parse had already
         * built the 50k-deep object graph. The outcome is unchanged: invalid
         * JSON still returns PARSE_FAILED, from the catch below.
         */
        if (!jsonTextSafeToRewrite(text)) return PARSE_FAILED;
        return JSON.parse(text);
      }
      case "json5": return Bun.JSON5.parse(text);
      case "yaml": return Bun.YAML.parse(text);
      case "toml": {
        /*
         * Bun's TOML parser mangles the special floats before we ever see the
         * document: `inf` comes back as the STRING "inf", `-inf` as the number
         * 0, and `nan` as "nan". Re-serializing that would write those
         * corruptions back to the user's file while reporting success — a
         * silent value change is worse than a refusal, so a document
         * containing them is treated as one we cannot safely rewrite.
         *
         * Detected on the raw text, because by the time it is parsed the
         * evidence is gone.
         */
        if (/(^|[\s,[=])[-+]?(?:inf|nan)(?=[\s,\]]|$)/mi.test(text)) return PARSE_FAILED;
        return Bun.TOML.parse(text);
      }
    }
  } catch {
    return PARSE_FAILED;
  }
}

export type ReadResult =
  | { kind: "text"; text: string }
  | { kind: "missing" }
  | { kind: "failed"; code?: string };

export type StatKind = "file" | "dir" | "other" | "missing" | "failed";

export interface IntegrationIO {
  /**
   * ONLY a missing file yields `missing`. Every other failure (EACCES, EPERM,
   * EISDIR, …) yields `failed`, which callers must treat as unsafe.
   */
  readText: (path: string) => ReadResult;
  /** `failed` is distinct from `missing` for the same reason. */
  statKind: (path: string) => StatKind;
  writeText: (path: string, text: string) => void;
  removeFile: (path: string) => void;
  mkdirp: (path: string) => void;
  now: () => number;
  /** Bookkeeping seams, bound to one store so a test can redirect them. */
  appendJournal: (entry: JournalEntry) => void;
  putRecord: (record: OwnershipRecord) => void;
  dropRecord: (clientId: IntegrationClientId) => void;
}

export type TargetState =
  | { ok: true; before: string | null }
  | { ok: false; why: "not-regular-file" | "read-failed" };

/**
 * Read the target and classify the three failure shapes correctly.
 *
 * The subtle case is a `stat` that succeeds as a file and a `read` that then
 * fails: that is a real file we cannot see, and treating it as absence is how
 * an unreadable config gets clobbered.
 */
export function loadTarget(io: IntegrationIO, configPath: string): TargetState {
  const kind = io.statKind(configPath);
  if (kind === "missing") return { ok: true, before: null };
  if (kind === "failed") return { ok: false, why: "read-failed" };
  if (kind !== "file") return { ok: false, why: "not-regular-file" };
  const read = io.readText(configPath);
  if (read.kind === "text") return { ok: true, before: read.text };
  if (read.kind === "failed") return { ok: false, why: "read-failed" };
  // Raced deletion between the stat and the read.
  return { ok: true, before: null };
}

/**
 * Filesystem half of the seam, split from the store-bound half so there is one
 * place that decides what a failed read or stat MEANS, and one place that
 * decides WHERE bookkeeping goes.
 */
export function fileIO(): Omit<IntegrationIO, "appendJournal" | "putRecord" | "dropRecord"> {
  return {
    readText: path => {
      try {
        return { kind: "text", text: readFileSync(path, "utf8") };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === "ENOENT" ? { kind: "missing" } : { kind: "failed", ...(code ? { code } : {}) };
      }
    },
    statKind: path => {
      try {
        const stats = statSync(path);
        return stats.isFile() ? "file" : stats.isDirectory() ? "dir" : "other";
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "failed";
      }
    },
    writeText: (path, text) => atomicWriteFile(path, text),
    removeFile: path => rmSync(path, { force: true }),
    mkdirp: path => mkdirSync(path, { recursive: true, mode: 0o700 }),
    now: () => Date.now(),
  };
}

/**
 * The full seam: filesystem behavior plus bookkeeping bound to ONE store.
 *
 * Kept together so the IO a writer uses and the store it journals into can
 * never point at different roots — that split is what let an "isolated"
 * operation mutate the real state while a test believed otherwise.
 */
export function defaultIntegrationIO(store: {
  appendJournal: IntegrationIO["appendJournal"];
  putRecord: IntegrationIO["putRecord"];
  dropRecord: IntegrationIO["dropRecord"];
}): IntegrationIO {
  return {
    ...fileIO(),
    appendJournal: entry => store.appendJournal(entry),
    putRecord: record => store.putRecord(record),
    dropRecord: clientId => store.dropRecord(clientId),
  };
}
