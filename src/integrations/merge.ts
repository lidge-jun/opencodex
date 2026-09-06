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

/**
 * `[field=value]` addresses the ONE element of a sequence whose `field` equals
 * `value`. Raycast keeps its providers as a YAML list, so the element is the
 * smallest thing we can own there; an index would move under us the moment
 * the user reordered their own entries. Any other segment is a plain key.
 */
const ARRAY_SELECTOR = /^\[([A-Za-z_][A-Za-z0-9_]*)=([^\]]+)\]$/u;

export type PathSegment =
  | { kind: "key"; key: string }
  | { kind: "select"; field: string; value: string };

export function parseSegment(raw: string): PathSegment {
  const match = ARRAY_SELECTOR.exec(raw);
  if (!match) return { kind: "key", key: raw };
  return { kind: "select", field: match[1]!, value: match[2]! };
}

/**
 * Thrown when a selector matches more than one element. Picking either one
 * would silently rewrite an entry the user may have written; the writer maps
 * this to an `unsafe` refusal instead.
 */
export class AmbiguousSelectorError extends Error {
  constructor(field: string, value: string) {
    super(`more than one entry has ${field}=${value}`);
    this.name = "AmbiguousSelectorError";
  }
}

/** The index of the element a selector names, -1 when none matches. */
function selectIndex(items: readonly unknown[], field: string, value: string): number {
  const matches: number[] = [];
  items.forEach((item, index) => {
    if (isPlainRecord(item) && item[field] === value) matches.push(index);
  });
  if (matches.length > 1) throw new AmbiguousSelectorError(field, value);
  return matches[0] ?? -1;
}

function assertNever(segment: never): never {
  throw new Error(`unknown path segment ${JSON.stringify(segment)}`);
}

/**
 * Write `value` at `path`, creating intermediate containers. Returns a new document.
 *
 * A `key` segment descends through a record, creating `{}` where the slot is
 * absent or holds something else. A `select` segment descends through an
 * array the same way, creating `[]`; a missing element is pushed, a matching
 * one is replaced in place so the user's ordering survives.
 */
export function setPath(doc: unknown, path: readonly string[], value: unknown): unknown {
  if (path.length === 0) throw new Error("setPath needs a non-empty path");
  /*
   * `parent[slot]` is the position the segment just consumed addresses. The
   * root sits in a one-key holder so the first segment needs no special case:
   * a non-record document is replaced by `{}` exactly as before.
   */
  const holder: Record<string, unknown> = { root: isPlainRecord(doc) ? clone(doc) : {} };
  let parent: Record<string, unknown> | unknown[] = holder;
  let slot: string | number = "root";
  const read = (): unknown => (Array.isArray(parent) ? parent[slot as number] : parent[slot as string]);
  const write = (next: unknown): void => {
    if (Array.isArray(parent)) parent[slot as number] = next;
    else parent[slot as string] = next;
  };
  for (const raw of path) {
    const segment = parseSegment(raw);
    switch (segment.kind) {
      case "key": {
        if (!isPlainRecord(read())) write({});
        parent = read() as Record<string, unknown>;
        slot = segment.key;
        break;
      }
      case "select": {
        if (!Array.isArray(read())) write([]);
        const items = read() as unknown[];
        const found = selectIndex(items, segment.field, segment.value);
        parent = items;
        if (found >= 0) {
          slot = found;
        } else {
          // Seed the element so the selector stays true for whatever a deeper
          // segment writes into it; a last-position select replaces it whole.
          slot = items.length;
          items.push({ [segment.field]: segment.value });
        }
        break;
      }
      default:
        return assertNever(segment);
    }
  }
  write(clone(value));
  return holder.root;
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
  // `chain[i]` is the container segment `i` is resolved against; `slots[i]` is
  // the key or index it resolved to, so the prune walk can delete by position.
  const chain: (Record<string, unknown> | unknown[])[] = [root];
  const slots: (string | number)[] = [];
  for (let depth = 0; depth < path.length; depth += 1) {
    const container = chain[depth]!;
    const segment = parseSegment(path[depth]!);
    switch (segment.kind) {
      case "key": {
        if (Array.isArray(container) || !(segment.key in container)) return { doc: root, removed: false };
        slots.push(segment.key);
        chain.push(container[segment.key] as Record<string, unknown> | unknown[]);
        break;
      }
      case "select": {
        if (!Array.isArray(container)) return { doc: root, removed: false };
        const found = selectIndex(container, segment.field, segment.value);
        if (found < 0) return { doc: root, removed: false };
        slots.push(found);
        chain.push(container[found] as Record<string, unknown> | unknown[]);
        break;
      }
      default:
        return assertNever(segment);
    }
    // Only the leaf may be a scalar; walking into one means the path is absent.
    if (depth < path.length - 1) {
      const next = chain[depth + 1];
      if (!isPlainRecord(next) && !Array.isArray(next)) return { doc: root, removed: false };
    }
  }
  const remove = (container: Record<string, unknown> | unknown[], slot: string | number): void => {
    if (Array.isArray(container)) container.splice(slot as number, 1);
    else delete container[slot as string];
  };
  remove(chain[path.length - 1]!, slots[path.length - 1]!);
  /*
   * Walk back up, pruning only containers this deletion emptied AND that we
   * created. The root is never pruned.
   */
  for (let index = path.length - 1; index >= 1; index -= 1) {
    const container = chain[index]!;
    const empty = Array.isArray(container) ? container.length === 0 : Object.keys(container).length === 0;
    if (!empty) break;
    const containerPath = path.slice(0, index).join("\u0000");
    if (!createdContainers.has(containerPath)) break;
    remove(chain[index - 1]!, slots[index - 1]!);
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
      const segment = parseSegment(fragment.path[depth]!);
      let next: unknown;
      switch (segment.kind) {
        case "key": {
          /*
           * The container this key must hold is whatever the NEXT segment
           * descends into: an array when that is a selector, a record
           * otherwise. Either one is ours to create when absent.
           */
          const nextSegment = parseSegment(fragment.path[depth + 1]!);
          next = isPlainRecord(cursor) ? cursor[segment.key] : undefined;
          if (nextSegment.kind === "select" ? !Array.isArray(next) : !isPlainRecord(next)) next = undefined;
          break;
        }
        case "select": {
          // A selector that matches nothing means setPath will push the element.
          next = Array.isArray(cursor)
            ? cursor.find(item => isPlainRecord(item) && item[segment.field] === segment.value)
            : undefined;
          break;
        }
        default:
          return assertNever(segment);
      }
      if (next === undefined) {
        created.add(fragment.path.slice(0, depth + 1).join("\u0000"));
        cursor = undefined;
        continue;
      }
      cursor = next;
    }
  }
  return [...created];
}
