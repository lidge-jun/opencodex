import { createHash } from "node:crypto";
import { EMPTY_TOOL_OUTPUT_ANNOTATION, isWhitespaceOnlyTextPartArray } from "../empty-tool-output-annotation";
import { isPlainObject } from "./internal";

const MAX_RESPONSES_CALL_ID_LENGTH = 64;

const REPAIRED_CALL_ID_PREFIX = "call_ocx_";
const REPAIRED_CALL_ID_DIGEST_LENGTH = MAX_RESPONSES_CALL_ID_LENGTH - REPAIRED_CALL_ID_PREFIX.length;

/**
 * The ChatGPT Responses backend rejects input `call_id` values longer than 64 characters. Codex
 * sidechat/fork replay can namespace call ids from routed providers past that limit. Forward mode
 * already sends explicit replay input without `previous_response_id`, so it is safe to replace each
 * oversized id and every matching call/output occurrence with one deterministic request-local alias.
 * Raw API-key continuations are intentionally excluded because an output-only continuation may
 * reference a call stored upstream under the original id. Proxy-expanded API-key replays are
 * explicit and stateless here, so they are safe to repair too.
 */
export function repairOversizedReplayCallIds(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;

  const occupied = new Set<string>();
  for (const item of body.input) {
    if (!isPlainObject(item) || typeof item.call_id !== "string") continue;
    if (item.call_id.length <= MAX_RESPONSES_CALL_ID_LENGTH) occupied.add(item.call_id);
  }

  const aliases = new Map<string, string>();
  let changed = false;
  const input = body.input.map(item => {
    if (!isPlainObject(item) || typeof item.call_id !== "string") return item;
    const original = item.call_id;
    if (original.length <= MAX_RESPONSES_CALL_ID_LENGTH) return item;

    let alias = aliases.get(original);
    if (!alias) {
      let salt = 0;
      do {
        const hashInput = salt === 0 ? original : `${original}\0${salt}`;
        const digest = createHash("sha256").update(hashInput).digest("hex");
        alias = `${REPAIRED_CALL_ID_PREFIX}${digest.slice(0, REPAIRED_CALL_ID_DIGEST_LENGTH)}`;
        salt += 1;
      } while (occupied.has(alias));
      aliases.set(original, alias);
      occupied.add(alias);
    }

    changed = true;
    return { ...item, call_id: alias };
  });

  return changed ? { ...body, input } : body;
}

/** Flatten a Responses tool-output `output` value (string or content-part array) to plain text. */
function toolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return JSON.stringify(output ?? "");
  return output.map(part => {
    if (!isPlainObject(part)) return "";
    if (typeof part.text === "string") return part.text;
    if (part.type === "refusal" && typeof part.refusal === "string") return `[refusal] ${part.refusal}`;
    return "";
  }).filter(Boolean).join("\n");
}

/** True when an output can be losslessly represented as user-message content. */
function isRepairableToolOutput(output: unknown): output is string | Record<string, unknown>[] {
  if (typeof output === "string") return true;
  if (!Array.isArray(output)) return false;
  return output.every(part => {
    if (!isPlainObject(part)) return false;
    if (typeof part.type !== "string") return false;
    if (["output_text", "text", "input_text"].includes(part.type)) {
      return typeof part.text === "string";
    }
    if (part.type === "refusal") return typeof part.refusal === "string";
    if (part.type === "encrypted_content") return typeof part.encrypted_content === "string";
    if (part.type !== "input_image") return false;
    const imageUrl = part.image_url;
    const fileId = part.file_id;
    const imageUrlIsString = typeof imageUrl === "string";
    const fileIdIsString = typeof fileId === "string";
    const hasUsableSource = (imageUrlIsString && imageUrl.length > 0)
      || (fileIdIsString && fileId.length > 0);
    const validSource = hasUsableSource
      && (part.image_url === undefined || imageUrlIsString)
      && (part.file_id === undefined || fileIdIsString);
    const validDetail = part.detail === undefined
      || (typeof part.detail === "string"
        && ["auto", "low", "high", "original"].includes(part.detail));
    return validSource && validDetail;
  });
}

/** Convert orphaned tool output to user-message content without discarding valid images. */
function orphanedToolOutputContent(output: unknown, callId = ""): Record<string, unknown>[] {
  const marker = `[tool output for ${callId || "unknown call"}]`;
  if (typeof output !== "string" && !Array.isArray(output)) {
    return [{ type: "input_text", text: marker }];
  }
  if (!Array.isArray(output)) {
    return [{ type: "input_text", text: `${marker}\n${toolOutputText(output)}` }];
  }

  const content: Record<string, unknown>[] = [{ type: "input_text", text: marker }];
  for (const part of output) {
    if (!isPlainObject(part)) continue;
    if (part.type === "input_image") {
      content.push(part);
    } else if (part.type === "encrypted_content" && typeof part.encrypted_content === "string") {
      content.push({ type: "input_text", text: "[encrypted content omitted]" });
    } else if (typeof part.text === "string") {
      content.push({ type: "input_text", text: part.text });
    } else if (part.type === "refusal" && typeof part.refusal === "string") {
      content.push({ type: "input_text", text: `[refusal] ${part.refusal}` });
    }
  }
  return content;
}

/** True when a Responses tool output item is present but carries no usable content. */
function isToolOutputEmpty(output: unknown): boolean {
  if (typeof output === "string") return output.trim() === "";
  if (Array.isArray(output)) {
    // Mirror the Chat wire rule through the shared contract: only a pure
    // text/refusal part array whose joined content trims empty is annotated.
    // input_image, encrypted_content, input_file and any other non-text part is
    // real output and must never be replaced.
    return isWhitespaceOnlyTextPartArray(output);
  }
  // A missing or null `output` is not a present-but-empty result: it is an
  // incomplete payload. Leave it untouched so the upstream contract fails
  // closed, and the orphan repair can surface it honestly instead of claiming
  // the tool ran with no output.
  return false;
}

/**
 * Rewrite present-but-empty tool outputs to an explicit annotation. Synthetic
 * missing-result placeholders are non-empty and pass through untouched. No-op unless
 * the provider opts in (`annotateEmptyToolOutputs`).
 */
export function annotateEmptyResponsesToolOutputs(body: unknown, enabled: boolean): unknown {
  if (!enabled || !isPlainObject(body) || !Array.isArray(body.input)) return body;
  let changed = false;
  const input = body.input.map(item => {
    if (!isPlainObject(item) || (item.type !== "function_call_output" && item.type !== "custom_tool_call_output")) return item;
    if (!isToolOutputEmpty(item.output)) return item;
    changed = true;
    return { ...item, output: EMPTY_TOOL_OUTPUT_ANNOTATION };
  });
  return changed ? { ...body, input } : body;
}

/**
 * Preserve the text of structurally invalid tool-output items before they reach a strict
 * Responses parser. Stateful destinations may legitimately receive an output whose matching
 * call lives behind `previous_response_id`, so ordinary orphan repair cannot run universally.
 * A missing or empty `call_id`, however, cannot identify stored state on any destination.
 */
export function repairUnidentifiedToolOutputItems(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  let changed = false;
  const input = body.input.map(item => {
    if (!isPlainObject(item)
      || (item.type !== "function_call_output" && item.type !== "custom_tool_call_output")
      || (typeof item.call_id === "string" && item.call_id.length > 0)) {
      return item;
    }
    if (!isRepairableToolOutput(item.output)) return item;
    changed = true;
    return {
      type: "message",
      role: "user",
      content: orphanedToolOutputContent(item.output),
    };
  });
  return changed ? { ...body, input } : body;
}

/**
 * Repair a forward-mode input array whose continuation context was lost. When the replay
 * expansion misses (proxy restart, unrecorded prior turn), previous_response_id is stripped
 * (the ChatGPT backend rejects it), so the delta may carry items that reference now-absent
 * prior items and 400 upstream:
 * - `function_call`/`local_shell_call`/`custom_tool_call` without their paired output item
 *   ("No tool output found for tool call <call_id>"). A stateless upstream cannot resolve
 *   the pair from its own storage, so a placeholder output is synthesized to keep the
 *   turn continuable without pretending the result was real. Synthetic outputs are
 *   emitted after the complete parallel call batch, in call order alongside any real
 *   outputs, so the adjacency normalizer can still recognize the batch as one
 *   reasoning-bearing assistant turn (#1477). Gated on
 *   `synthesizeMissingCallOutputs` (stateless AND non-forward wires); forward replay keeps
 *   fail-closed behavior.
 * - `function_call_output`/`custom_tool_call_output` without their paired call item
 *   ("No tool call found for function call output with call_id ..."). Converted to user
 *   messages so the result text survives. `function_call_output` also pairs with
 *   `local_shell_call` (codex-rs emits shell outputs as function_call_output).
 * - `reasoning` items ("Item 'rs_*' ... was provided without its required following item").
 *   Dropped, but only when `dropReasoning` (unexpanded miss): on a replay hit the prior
 *   reasoning chain is intact and must be preserved.
 * Runs on every forward request; with intact pairs it returns the original reference.
 */
/**
 * Repair a replayed `web_search_call` action that is missing either key.
 *
 * `webSearchAction()` in the bridge now emits both keys, but that only helps items
 * created after the fix. A conversation that already recorded
 * `{type:"search", query:"..."}` or `{type:"search", queries:[...]}` replays that stored
 * item on every subsequent turn. DeepSeek's native Responses parser requires `queries`
 * (#930) and Console Go's validator requires `query` (#3071), so upgrading alone leaves
 * those threads permanently 400ing in one direction or the other. The repair runs both
 * ways.
 *
 * Input items carry a loose schema, so a stored `queries` is not necessarily an array of
 * strings. A partly- or wholly-malformed array is left alone rather than used as a source
 * for the singular field: writing `query: 123` would satisfy the presence check and still
 * fail the validator this repair exists to satisfy, and deriving `query` from
 * `["a", 42]` would satisfy Console Go while leaving DeepSeek to reject the same replay.
 * An empty `queries: []` canonicalizes to the shape the bridge emits for an empty search,
 * keeping an existing `query` when the item has one.
 *
 * Runs on every Responses request, on both `input` items and the `action` nested inside
 * them. Returns the original reference when nothing needs repair, so the common path
 * allocates nothing.
 */
export function backfillWebSearchQueries(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  let changed = false;
  const input = body.input.map(item => {
    if (!isPlainObject(item) || item.type !== "web_search_call") return item;
    const action = item.action;
    if (!isPlainObject(action) || action.type !== "search") return item;
    // Repair whichever side is missing so both strict parsers pass:
    // DeepSeek native Responses requires `queries`; Console Go requires `query`.
    const rep: Record<string, unknown> = { ...action };
    let itemChanged = false;
    const hasQuery = typeof action.query === "string";
    const queries = Array.isArray(action.queries) ? action.queries : undefined;
    if (queries !== undefined && queries.length === 0) {
      // An empty array satisfies neither validator. Canonicalize to the empty-search
      // shape the bridge emits, keeping an existing query rather than discarding it.
      const query = hasQuery ? action.query as string : "";
      rep.query = query;
      rep.queries = [query];
      itemChanged = true;
    } else if (!hasQuery && queries !== undefined) {
      // A plural array is only a usable source for the singular field when EVERY member
      // is a string: deriving `query` from a partly-malformed array would satisfy Console
      // Go while leaving DeepSeek to reject the same replay. Wholly malformed arrays are
      // left untouched — coercing or dropping members would invent semantics the stored
      // item never had.
      if (queries.every(entry => typeof entry === "string")) {
        rep.query = queries[0];            // multi-query item recorded before the fix
        itemChanged = true;
      }
    } else if (hasQuery && queries === undefined) {
      rep.queries = [action.query];        // single-query item recorded before the fix
      itemChanged = true;
    }
    if (itemChanged) changed = true;
    return itemChanged ? { ...item, action: rep } : item;
  });
  return changed ? { ...body, input } : body;
}

export function repairOrphanedInputItems(body: unknown, dropReasoning: boolean, synthesizeMissingCallOutputs = false): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  const input = body.input;

  const functionCallIds = new Set<string>();
  const customCallIds = new Set<string>();
  const functionOutputIds = new Set<string>();
  const customOutputIds = new Set<string>();
  for (const item of input) {
    if (!isPlainObject(item) || typeof item.call_id !== "string") continue;
    if (item.type === "function_call" || item.type === "local_shell_call") functionCallIds.add(item.call_id);
    else if (item.type === "custom_tool_call") customCallIds.add(item.call_id);
    else if (item.type === "function_call_output") functionOutputIds.add(item.call_id);
    else if (item.type === "custom_tool_call_output") customOutputIds.add(item.call_id);
  }

  let changed = false;
  const repaired: unknown[] = [];
  const syntheticKeys = new Set<string>();
  const pendingSyntheticOutputs: unknown[] = [];
  const flushPendingSyntheticOutputs = (): void => {
    if (pendingSyntheticOutputs.length === 0) return;
    repaired.push(...pendingSyntheticOutputs);
    pendingSyntheticOutputs.length = 0;
  };
  for (const item of input) {
    if (!isPlainObject(item)) { flushPendingSyntheticOutputs(); repaired.push(item); continue; }
    if (dropReasoning && item.type === "reasoning") { changed = true; continue; }
    const isFnOutput = item.type === "function_call_output";
    const isCustomOutput = item.type === "custom_tool_call_output";
    if (isFnOutput || isCustomOutput) {
      flushPendingSyntheticOutputs();
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      const paired = isFnOutput ? functionCallIds.has(callId) : customCallIds.has(callId);
      const usableOutput = isRepairableToolOutput(item.output);
      // A known orphan call is still useful as a labeled user message even when its output is
      // incomplete. With no call id and no output, preserve the invalid item so validation fails
      // closed rather than pretending any tool result exists.
      const knownNullOutput = callId.length > 0 && item.output == null;
      if (!paired && (knownNullOutput || usableOutput)) {
        changed = true;
        repaired.push({
          type: "message",
          role: "user",
          content: orphanedToolOutputContent(item.output, callId),
        });
        continue;
      }
    }
    const isFnCall = item.type === "function_call" || item.type === "local_shell_call";
    const isCustomCall = item.type === "custom_tool_call";
    if (isFnCall || isCustomCall) {
      repaired.push(item);
      if (synthesizeMissingCallOutputs) {
        const callId = typeof item.call_id === "string" ? item.call_id : "";
        const hasOutput = isFnCall ? functionOutputIds.has(callId) : customOutputIds.has(callId);
        if (!hasOutput && callId) {
          changed = true;
          const name = typeof item.name === "string" && item.name.length > 0 ? item.name : callId;
          const text = `[ocx] no tool result was recorded for "${name}"; execution status unknown — do not treat this as success, failure, or user-provided input.`;
          syntheticKeys.add(`${isFnCall ? "function" : "custom"}:${callId}`);
          pendingSyntheticOutputs.push(isFnCall
            ? { type: "function_call_output", call_id: callId, output: text }
            : { type: "custom_tool_call_output", call_id: callId, output: text });
        }
      }
      continue;
    }
    flushPendingSyntheticOutputs();
    repaired.push(item);
  }
  flushPendingSyntheticOutputs();

  const callKeyOf = (item: unknown): string | null => {
    if (!isPlainObject(item) || typeof item.call_id !== "string") return null;
    if (item.type === "function_call" || item.type === "local_shell_call") return `function:${item.call_id}`;
    if (item.type === "custom_tool_call") return `custom:${item.call_id}`;
    return null;
  };
  const outputKeyOf = (item: unknown): string | null => {
    if (!isPlainObject(item) || typeof item.call_id !== "string") return null;
    if (item.type === "function_call_output") return `function:${item.call_id}`;
    if (item.type === "custom_tool_call_output") return `custom:${item.call_id}`;
    return null;
  };
  const reorderBatchOutputs = (items: unknown[]): unknown[] => {
    const ordered: unknown[] = [];
    const claimedOutputIndexes = new Set<number>();
    const outputIndexesByKey = new Map<string, { indexes: number[]; offset: number }>();
    for (let outputIndex = 0; outputIndex < items.length; outputIndex += 1) {
      const outputKey = outputKeyOf(items[outputIndex]);
      if (outputKey === null) continue;
      const bucket = outputIndexesByKey.get(outputKey);
      if (bucket) bucket.indexes.push(outputIndex);
      else outputIndexesByKey.set(outputKey, { indexes: [outputIndex], offset: 0 });
    }
    let index = 0;
    while (index < items.length) {
      if (claimedOutputIndexes.has(index)) { index += 1; continue; }
      const key = callKeyOf(items[index]);
      if (key === null) { ordered.push(items[index]); index += 1; continue; }
      const batch: unknown[] = [];
      const batchKeys: string[] = [];
      let cursor = index;
      while (cursor < items.length) {
        const nextKey = callKeyOf(items[cursor]);
        if (nextKey === null) break;
        batch.push(items[cursor]);
        batchKeys.push(nextKey);
        cursor += 1;
      }
      const hasSynthetic = batchKeys.some(batchKey => syntheticKeys.has(batchKey));
      if (!hasSynthetic) {
        ordered.push(...batch);
        index = cursor;
        continue;
      }
      const batchOutputs: unknown[] = [];
      for (const batchKey of batchKeys) {
        const bucket = outputIndexesByKey.get(batchKey);
        if (!bucket) continue;
        while (bucket.offset < bucket.indexes.length && bucket.indexes[bucket.offset]! < cursor) {
          bucket.offset += 1;
        }
        while (bucket.offset < bucket.indexes.length) {
          const outputIndex = bucket.indexes[bucket.offset]!;
          bucket.offset += 1;
          if (claimedOutputIndexes.has(outputIndex)) continue;
          claimedOutputIndexes.add(outputIndex);
          batchOutputs.push(items[outputIndex]);
          break;
        }
      }
      ordered.push(...batch, ...batchOutputs);
      index = cursor;
    }
    return ordered;
  };

  return changed ? { ...body, input: reorderBatchOutputs(repaired) } : body;
}

/**
 * Make unambiguous Responses tool batches contiguous for upstream parsers that require it.
 *
 * [Decision Log]
 * - 목적과 의도: Keep Codex hook-injected developer context without splitting a parallel tool-call turn away from its reasoning or making a strict upstream reject matching results.
 * - 기존 구현 및 제약 조건: The orphan repair verifies only pair presence, while the original pair-by-pair reorder turned `reasoning, call A, call B, output A, output B` into two assistant turns and made DeepSeek reject call B for missing reasoning (#1477).
 * - 검토한 주요 대안: Disable parallel calls (DeepSeek always enables them); duplicate reasoning per call; reorder each pair; or normalize the complete unambiguous call batch.
 * - 선택한 방식: Treat calls emitted before the first matched result as one batch, emit all calls followed by their matched outputs, and preserve intervening non-tool items immediately after the batch.
 * - 다른 대안 대신 이 방식을 선택한 이유: Batch normalization matches the Responses parallel-call shape without fabricating reasoning, while the provider gate and unique-pair requirement keep the blast radius narrow.
 * - 장점, 단점 및 영향: DeepSeek keeps one reasoning-bearing assistant turn for parallel calls and still accepts hook-interleaved single calls; tolerant providers stay byte/order equivalent, and duplicate, missing, or backwards call/result pairs are not guessed.
 */
export function normalizeResponsesToolResultAdjacency(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  const input = body.input;
  const calls = new Map<string, number[]>();
  const outputs = new Map<string, number[]>();

  const appendIndex = (map: Map<string, number[]>, key: string, index: number): void => {
    const existing = map.get(key);
    if (existing) existing.push(index);
    else map.set(key, [index]);
  };

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!isPlainObject(item) || typeof item.call_id !== "string" || item.call_id.length === 0) continue;
    if (item.type === "function_call" || item.type === "local_shell_call") {
      appendIndex(calls, `function:${item.call_id}`, index);
    } else if (item.type === "custom_tool_call") {
      appendIndex(calls, `custom:${item.call_id}`, index);
    } else if (item.type === "function_call_output") {
      appendIndex(outputs, `function:${item.call_id}`, index);
    } else if (item.type === "custom_tool_call_output") {
      appendIndex(outputs, `custom:${item.call_id}`, index);
    }
  }

  const pairs: Array<{ callIndex: number; outputIndex: number }> = [];
  for (const [key, callIndices] of calls) {
    const outputIndices = outputs.get(key);
    if (!outputIndices) return body;
    if (callIndices.length !== 1 || outputIndices.length !== 1) return body;
    const callIndex = callIndices[0]!;
    const outputIndex = outputIndices[0]!;
    if (outputIndex <= callIndex) return body;
    pairs.push({ callIndex, outputIndex });
  }
  // Reject any collected output that lacks exactly one matching call. A lone or
  // duplicated output is ambiguous, and normalizing on top of it could sever a
  // result from the reasoning-bearing call turn it belongs to.
  for (const [key, outputIndices] of outputs) {
    const callIndices = calls.get(key);
    if (!callIndices || callIndices.length !== 1 || outputIndices.length !== 1) return body;
  }
  pairs.sort((left, right) => left.callIndex - right.callIndex);

  const movedIndices = new Set<number>();
  const batchAt = new Map<number, unknown[]>();
  for (let cursor = 0; cursor < pairs.length;) {
    const group = [pairs[cursor]!];
    let firstOutputIndex = pairs[cursor]!.outputIndex;
    let next = cursor + 1;
    while (next < pairs.length && pairs[next]!.callIndex < firstOutputIndex) {
      group.push(pairs[next]!);
      firstOutputIndex = Math.min(firstOutputIndex, pairs[next]!.outputIndex);
      next += 1;
    }

    // Within one reasoning turn the outputs must appear in the same order as their
    // calls. If they are reversed, normalizing would fabricate a new output order;
    // leave the ambiguous history untouched instead.
    for (let groupIndex = 1; groupIndex < group.length; groupIndex += 1) {
      if (group[groupIndex]!.outputIndex < group[groupIndex - 1]!.outputIndex) return body;
    }

    const batch = [
      ...group.map(pair => input[pair.callIndex]),
      ...group.map(pair => input[pair.outputIndex]),
    ];
    const anchor = group[0]!.callIndex;
    const alreadyContiguous = batch.every((item, offset) => input[anchor + offset] === item);
    if (!alreadyContiguous) {
      batchAt.set(anchor, batch);
      for (const pair of group) {
        movedIndices.add(pair.callIndex);
        movedIndices.add(pair.outputIndex);
      }
    }
    cursor = next;
  }
  if (batchAt.size === 0) return body;

  const normalized: unknown[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const batch = batchAt.get(index);
    if (batch) normalized.push(...batch);
    if (!movedIndices.has(index)) normalized.push(input[index]);
  }
  return { ...body, input: normalized };
}
