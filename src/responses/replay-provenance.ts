/**
 * Decide whether a chained request demonstrably carries the complete stored prefix.
 *
 * Content equality is necessary but not sufficient: a legitimate delta may repeat the
 * same message text. At least one matched Responses item must also retain a protocol
 * identity that a new occurrence cannot reuse (a provider output `id` or tool
 * `call_id`). User-authored message ids are deliberately not provenance.
 */

const MAX_CANONICAL_DEPTH = 256;
const canonicalOverflow = Symbol("canonical-overflow");
const STABLE_CALL_ID_KEYS = ["call_id", "callId"] as const;

/**
 * Canonicalize a replay item iteratively, sorting object keys and normalizing
 * equivalent search shapes. Returns a sentinel when the depth bound is exceeded.
 */
function canonicalValue(value: unknown): unknown {
  type Slot = { value: unknown };
  type Frame =
    | { kind: "node"; node: unknown; slot: Slot; depth: number }
    | { kind: "array"; array: unknown[]; index: number; next: unknown[]; slot: Slot; depth: number }
    | {
        kind: "object";
        keys: Generator<string>;
        record: Record<string, unknown>;
        next: Record<string, unknown>;
        slot: Slot;
        depth: number;
      }
    | { kind: "assign"; next: unknown[] | Record<string, unknown>; position: number | string; slot: Slot };

  function* ownEnumerableKeys(record: Record<string, unknown>): Generator<string> {
    for (const key in record) {
      if (Object.prototype.hasOwnProperty.call(record, key)) yield key;
    }
  }

  let overflowed = false;
  const root: Slot = { value };
  const stack: Frame[] = [{ kind: "node", node: value, slot: root, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "node") {
      const node = frame.node;
      if (Array.isArray(node)) {
        if (frame.depth >= MAX_CANONICAL_DEPTH) {
          overflowed = true;
          frame.slot.value = canonicalOverflow;
        } else {
          stack.push({
            kind: "array",
            array: node,
            index: 0,
            next: new Array<unknown>(node.length),
            slot: frame.slot,
            depth: frame.depth,
          });
        }
      } else if (node && typeof node === "object") {
        if (frame.depth >= MAX_CANONICAL_DEPTH) {
          overflowed = true;
          frame.slot.value = canonicalOverflow;
        } else {
          stack.push({
            kind: "object",
            record: node as Record<string, unknown>,
            keys: ownEnumerableKeys(node as Record<string, unknown>),
            next: Object.create(null),
            slot: frame.slot,
            depth: frame.depth,
          });
        }
      } else {
        frame.slot.value = node;
      }
      continue;
    }

    if (frame.kind === "array") {
      if (frame.index < frame.array.length) {
        const child: Slot = { value: frame.array[frame.index] };
        stack.push({
          kind: "array",
          array: frame.array,
          index: frame.index + 1,
          next: frame.next,
          slot: frame.slot,
          depth: frame.depth,
        });
        stack.push({ kind: "assign", next: frame.next, position: frame.index, slot: child });
        stack.push({ kind: "node", node: frame.array[frame.index], slot: child, depth: frame.depth + 1 });
      } else {
        frame.slot.value = frame.next;
      }
      continue;
    }

    if (frame.kind === "object") {
      const nextKey = frame.keys.next();
      if (!nextKey.done) {
        const child: Slot = { value: frame.record[nextKey.value] };
        stack.push({ ...frame });
        stack.push({ kind: "assign", next: frame.next, position: nextKey.value, slot: child });
        stack.push({ kind: "node", node: child.value, slot: child, depth: frame.depth + 1 });
        continue;
      }

      const normalized: Record<string, unknown> = { ...frame.next };
      if (normalized.type === "search" && typeof normalized.query === "string") {
        normalized.queries = Array.isArray(normalized.queries)
          ? normalized.queries
          : [normalized.query];
      }
      const ordered: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(normalized).sort()) ordered[key] = normalized[key];
      frame.slot.value = ordered;
      continue;
    }

    if (typeof frame.position === "number") {
      (frame.next as unknown[])[frame.position] = frame.slot.value;
    } else {
      (frame.next as Record<string, unknown>)[frame.position] = frame.slot.value;
    }
  }
  return overflowed ? canonicalOverflow : root.value;
}

/** Build the content key used to compare stored and resent replay items. */
function canonicalItemKey(item: unknown): string | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const { id: _id, status: _status, sequence_number: _sequenceNumber, ...stable } =
    item as Record<string, unknown>;
  const canonical = canonicalValue(stable);
  return canonical === canonicalOverflow ? undefined : JSON.stringify(canonical);
}

/**
 * Check whether matching items retain a provider-issued identity that proves
 * they are the same occurrence rather than coincidentally equal content.
 */
function sharesStableIdentity(stored: unknown, request: unknown): boolean {
  if (
    !stored
    || !request
    || typeof stored !== "object"
    || typeof request !== "object"
    || Array.isArray(stored)
    || Array.isArray(request)
  ) return false;
  const storedRecord = stored as Record<string, unknown>;
  const requestRecord = request as Record<string, unknown>;
  const sharesCallId = STABLE_CALL_ID_KEYS.some(key =>
    typeof storedRecord[key] === "string"
    && storedRecord[key] !== ""
    && storedRecord[key] === requestRecord[key]
  );
  if (sharesCallId) return true;
  // User-authored message IDs are not provider provenance: a client may legitimately
  // repeat them. Provider output IDs are stable replay anchors when retained.
  return storedRecord.role !== "user"
    && requestRecord.role !== "user"
    && typeof storedRecord.id === "string"
    && storedRecord.id !== ""
    && storedRecord.id === requestRecord.id;
}

/**
 * Return true only when the request contains the complete stored prefix and at
 * least one provider-output item retains a stable protocol identity.
 */
export function hasProvenCompleteReplayPrefix(
  stored: readonly unknown[],
  requestInput: readonly unknown[],
  providerOutputStart: number | undefined,
): boolean {
  if (
    stored.length === 0
    || requestInput.length < stored.length
    || typeof providerOutputStart !== "number"
    || !Number.isSafeInteger(providerOutputStart)
    || providerOutputStart < 0
    || providerOutputStart >= stored.length
  ) return false;
  let hasStableAnchor = false;
  for (let index = 0; index < stored.length; index += 1) {
    const storedKey = canonicalItemKey(stored[index]);
    const requestKey = canonicalItemKey(requestInput[index]);
    if (storedKey === undefined || storedKey !== requestKey) return false;
    hasStableAnchor ||= index >= providerOutputStart
      && sharesStableIdentity(stored[index], requestInput[index]);
  }
  return hasStableAnchor;
}
