/**
 * How the read-only Codex history preflight opens the state store.
 *
 * Split out of `history-provider.ts` deliberately. That file is the single largest module in
 * `src/codex/` and sits just under the repository's 2000-line ratchet; the reasoning below is
 * load-bearing and long, and appending it there would have pushed the file over. Keeping the
 * open policy in one small module also puts the decision somewhere it can be read on its own,
 * which matters because getting it wrong is silent in both directions.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Database, constants as sqliteConstants } from "bun:sqlite";

/**
 * Read-only open flags that skip WAL shared memory entirely.
 *
 * `immutable=1` has to arrive as a `file:` URI, and a URI filename needs SQLITE_OPEN_URI.
 * Same idiom as the storage scanner, the log-guard inspector and the coordinator doctor, for
 * the same reason: never touch a foreign store's WAL protocol.
 */
const IMMUTABLE_READONLY_FLAGS = sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_URI;

/** Is this the "there is no shared memory and I may not create it" open failure? */
export function isStateDbCantOpenError(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  // Matched on the code with a message fallback, exactly like classifyRecoverableHistoryError:
  // the same SQLite condition reaches us as a code on some platforms and as bare text on others.
  return code === "SQLITE_CANTOPEN" || message.includes("unable to open database file");
}

/**
 * Test-only knob: force the primary read-only open to fail with a supplied error.
 *
 * The fallback below turns on a condition this repository cannot reproduce deterministically
 * from a test: whether a plain read-only open of a cleanly-closed WAL store fails or quietly
 * creates the `-shm` depends on the platform VFS and on the directory the store sits in.
 * Pinning the NARROWING — sidecars absent admits the immutable read, either sidecar present
 * still refuses — therefore needs the failure supplied rather than provoked, or the test would
 * assert the host's SQLite build instead of this decision (#4943).
 */
let openFailureForTests: ((path: string) => unknown) | undefined;
export function setStateDbPreflightOpenFailureForTests(hook: typeof openFailureForTests): void {
  openFailureForTests = hook;
}

/**
 * Open the Codex state store for the read-only preflight.
 *
 * `{ readonly: true }` is tried FIRST and stays the primary path, because it is the only mode
 * that can see a live WAL: it joins the writer's shared memory, so a thread another process
 * just migrated to paginated history is visible here and the preflight refuses on it. An
 * immutable open reads the last checkpointed main database instead. Making that the primary
 * path would trade a refusal for a stale snapshot, and a refusal this preflight fails to
 * observe is a config transition that proceeds over history Codex owns — the exact outcome the
 * whole guard exists to prevent.
 *
 * A WAL store closed cleanly is the case that has no shared memory to join. SQLite cannot
 * create the `-shm` from a read-only connection, so the open fails SQLITE_CANTOPEN on a store
 * that is perfectly healthy, the catch-all in the preflight folds that into
 * `history_injection_preflight_unavailable`, and `ocx sync` refuses on every attempt with no
 * way forward (#4943).
 *
 * So the fallback is admitted only in the state where the absent sidecars are what make an
 * immutable read exact rather than stale: no `-wal` and no `-shm` on disk means no writer is
 * attached and no committed content sits outside the main database, so the main file IS the
 * whole store and the two modes cannot disagree. Either sidecar present keeps the original
 * error and the refusal that follows from it — a `-wal` holds content this connection would
 * not read, and a `-shm` means a writer is attached, and neither is a store this preflight
 * may inspect from a snapshot.
 */
export function openCodexStateForPreflight(resolvedPath: string): Database {
  try {
    const forced = openFailureForTests?.(resolvedPath);
    if (forced) throw forced;
    return new Database(resolvedPath, { readonly: true });
  } catch (error) {
    if (!isStateDbCantOpenError(error)) throw error;
    if (existsSync(`${resolvedPath}-wal`) || existsSync(`${resolvedPath}-shm`)) throw error;
    // pathToFileURL percent-encodes the reserved characters a naive `file:${path}` would
    // misparse as a query or fragment.
    return new Database(`${pathToFileURL(resolvedPath).href}?immutable=1`, IMMUTABLE_READONLY_FLAGS);
  }
}
