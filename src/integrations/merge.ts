/**
 * Additive merge and surgical removal of the fragments opencodex owns.
 *
 * The rule that shapes this file: we insert exactly the paths our builder
 * named, and we delete exactly the paths a record says we wrote. Nothing here
 * ever scans for a prefix — a user's own `opencodex/...` entry is not ours to
 * remove, and inferring ownership from a name is how a config editor destroys
 * work it did not create.
 *
 * Design of record: devlog/_fin/260802_client_toggle_api/031_wp3_writer_impl.md.
 */
import type { ManagedContribution } from "../clients/config-export";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structured clone via JSON: our documents are plain data by construction. */
function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Write `value` at `path`, creating intermediate objects. Returns a new document. */
export function setPath(doc: unknown, path: readonly string[], value: unknown): unknown {
  if (path.length === 0) throw new Error("setPath needs a non-empty path");
  const root: Record<string, unknown> = isPlainRecord(doc) ? clone(doc) : {};
  let cursor = root;
  for (const key of path.slice(0, -1)) {
    const next = cursor[key];
    if (!isPlainRecord(next)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]!] = clone(value);
  return root;
}

/**
 * Delete `path`, optionally pruning containers that WE created.
 *
 * Two properties have to hold at once, and they pull in opposite directions.
 * A user who wrote `providers: {}` before we existed still has it after a
 * disable — pruning it because our entry left it empty would delete their
 * line. But a container we conjured ourselves (Kimi's `models` map exists only
 * because our aliases need somewhere to live) must not survive as empty
 * residue in a file the user never asked us to restructure.
 *
 * `createdContainers` is the difference: paths recorded at apply time as
 * absent beforehand. Anything not in that set is treated as the user's.
 */
export function deletePath(
  doc: unknown,
  path: readonly string[],
  createdContainers: ReadonlySet<string> = new Set(),
): { doc: unknown; removed: boolean } {
  if (!isPlainRecord(doc) || path.length === 0) return { doc, removed: false };
  const root = clone(doc) as Record<string, unknown>;
  const chain: Record<string, unknown>[] = [root];
  let cursor: Record<string, unknown> = root;
  for (const key of path.slice(0, -1)) {
    const next = cursor[key];
    if (!isPlainRecord(next)) return { doc: root, removed: false };
    cursor = next;
    chain.push(cursor);
  }
  const leaf = path[path.length - 1]!;
  if (!(leaf in cursor)) return { doc: root, removed: false };
  delete cursor[leaf];
  /*
   * Walk back up, pruning only containers this deletion emptied AND that we
   * created. The root is never pruned.
   */
  for (let index = chain.length - 1; index >= 1; index -= 1) {
    const container = chain[index]!;
    if (Object.keys(container).length > 0) break;
    const containerPath = path.slice(0, index).join("\u0000");
    if (!createdContainers.has(containerPath)) break;
    delete chain[index - 1]![path[index - 1]!];
  }
  return { doc: root, removed: true };
}

/** Insert every fragment. Everything else in the document is preserved. */
export function mergeContribution(doc: unknown, contribution: ManagedContribution): unknown {
  let next = doc;
  for (const fragment of contribution.fragments) next = setPath(next, fragment.path, fragment.value);
  return next;
}

/**
 * Remove exactly the RECORDED paths — never a prefix scan. An entry that
 * matches our naming but has no recorded path is not ours: it reads as
 * `conflict` and survives untouched.
 */
export function removeFragments(
  doc: unknown,
  paths: readonly (readonly string[])[],
  createdContainers: ReadonlySet<string> = new Set(),
): { doc: unknown; removed: boolean } {
  let next = doc;
  let removed = false;
  for (const path of paths) {
    const result = deletePath(next, path, createdContainers);
    next = result.doc;
    removed = removed || result.removed;
  }
  return { doc: next, removed };
}

/**
 * Container paths a contribution would have to CREATE in `doc`.
 *
 * Computed before the merge, because afterwards every container exists and the
 * question is unanswerable. Recorded on the ownership record so a later
 * disable can tell its own scaffolding from the user's structure.
 */
export function createdContainerPaths(
  doc: unknown,
  contribution: ManagedContribution,
): string[] {
  const created = new Set<string>();
  for (const fragment of contribution.fragments) {
    let cursor: unknown = doc;
    for (let depth = 0; depth < fragment.path.length - 1; depth += 1) {
      const key = fragment.path[depth]!;
      const next = isPlainRecord(cursor) ? cursor[key] : undefined;
      if (!isPlainRecord(next)) {
        created.add(fragment.path.slice(0, depth + 1).join("\u0000"));
        cursor = undefined;
        continue;
      }
      cursor = next;
    }
  }
  return [...created];
}
