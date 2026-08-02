/**
 * The filesystem seam shared by the reader and the writer.
 *
 * It lives in WP2 rather than beside the writer because `readIntegrationState`
 * needs it too, and a reader that disagreed with the writer about what counts
 * as an absent file is exactly how an unreadable config gets overwritten.
 *
 * Design of record: devlog/_plan/260802_client_toggle_api/021 §5-6.
 */
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import type { ConfigFormat } from "../clients/config-export";
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

/** Parse a client config, tolerating absence. PARSE_FAILED on garbage. */
export function parseConfig(text: string | null, format: ConfigFormat): unknown | typeof PARSE_FAILED {
  if (text === null || text.trim().length === 0) return {};
  try {
    switch (format) {
      case "json": return JSON.parse(text);
      case "json5": return Bun.JSON5.parse(text);
      case "yaml": return Bun.YAML.parse(text);
      case "toml": return Bun.TOML.parse(text);
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
