import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { getConfigDir } from "../config/paths";
import { samePathIdentity } from "./user-identity";

/**
 * One OpenCodex home per Codex home (#6529).
 *
 * The catalog in CODEX_HOME is a projection of ONE config. Nothing used to say which: a process
 * with another OPENCODEX_HOME (an empty one reads defaults that route nothing) took the same
 * catalog permit as the live service and replaced the user's routed catalog with its own view.
 * The injection journal is the one record every injected Codex home has, and it is removed by
 * restore, so it carries the binding: the OPENCODEX_HOME that injected this Codex home. The catalog
 * permit (K) checks it before every catalog, backup or cache write, so every writer is covered.
 *
 * Kept free of the config barrel: K imports this, and K is imported by the catalog writers.
 */
export const CODEX_HOME_JOURNAL_FILE = "opencodex-journal.json";

const MAX_JOURNAL_BYTES = 1024 * 1024;

/** The OPENCODEX_HOME this process writes from, as its physical directory when it exists. */
export function currentOpencodexHome(): string {
  const configured = getConfigDir();
  try {
    return realpathSync.native(configured);
  } catch {
    return resolve(configured);
  }
}

export type CodexHomeOwnership =
  /** No journal, or a journal written before the binding existed. */
  | { readonly kind: "unbound" }
  | { readonly kind: "owned" }
  /** The recorded home no longer exists, so nothing can come back to claim it. */
  | { readonly kind: "stale"; readonly boundHome: string }
  | { readonly kind: "foreign"; readonly boundHome: string };

/** The OPENCODEX_HOME recorded in a journal, read-only: an unreadable journal is evidence, not ours to clean. */
export function journaledOpencodexHome(journalPath: string): string | null {
  try {
    const bytes = readFileSync(journalPath);
    if (bytes.length > MAX_JOURNAL_BYTES) return null;
    const journal: unknown = JSON.parse(bytes.toString("utf8"));
    if (journal === null || typeof journal !== "object") return null;
    const home = (journal as { opencodexHome?: unknown }).opencodexHome;
    return typeof home === "string" && home.length > 0 ? home : null;
  } catch {
    return null;
  }
}

export function inspectCodexHomeOwner(
  canonicalCodexHome: string,
  current: string = currentOpencodexHome(),
): CodexHomeOwnership {
  const boundHome = journaledOpencodexHome(join(canonicalCodexHome, CODEX_HOME_JOURNAL_FILE));
  if (boundHome === null) return { kind: "unbound" };
  if (samePathIdentity(boundHome, current)) return { kind: "owned" };
  let physical: string;
  try {
    physical = realpathSync.native(boundHome);
  } catch {
    return existsSync(boundHome) ? { kind: "foreign", boundHome } : { kind: "stale", boundHome };
  }
  // The same directory recorded under another spelling (a symlinked home) is the same owner.
  return samePathIdentity(physical, current) ? { kind: "owned" } : { kind: "foreign", boundHome };
}

/**
 * The binding an injection records: the existing owner stays, a missing or stale one is replaced
 * by the injecting home. A foreign injection never takes the binding over; it has to restore from
 * the owning home first, or the owning home has to be gone.
 */
export function opencodexHomeForInjection(recorded: string | undefined, current: string = currentOpencodexHome()): string {
  if (recorded === undefined || recorded.length === 0) return current;
  if (samePathIdentity(recorded, current)) return recorded;
  try {
    realpathSync.native(recorded);
    return recorded;
  } catch {
    return existsSync(recorded) ? recorded : current;
  }
}
