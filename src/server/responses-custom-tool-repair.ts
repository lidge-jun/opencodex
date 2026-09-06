import type { TranslatorBudget } from "../lib/translator-budget";
import { mayBecomePatchEnvelope, normalizeApplyPatchDelimiters } from "../responses/apply-patch-envelope";
import { compileCodeModeHelperInput, resolveCodeModeHelperName } from "../responses/code-mode-helper-compat";
import { declaresCodeModeExec } from "../types/tools";
import {
  customToolItemId,
  restoreRoutedCustomCalls,
  routedCustomToolTargetName,
  routedCustomToolWireName,
  unwrapRoutedCustomToolArguments,
} from "../responses/custom-tool-compat";
import {
  replaceSseDataPayload,
  sseDataPayload,
  type SseBlockRewrite,
} from "./sse-payload-rewrite";

/** Exact compact prefix used by our upstream rewriter; progressive matching also
 *  tolerates insignificant JSON whitespace via FREEFORM_WRAP_PREFIX_RE. */
const FREEFORM_WRAP_PREFIX = '{"input":"';
const FREEFORM_WRAP_PREFIX_RE = /^\s*\{\s*"input"\s*:\s*"/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Progressive decode of the freeform `{ "input": "…" }` wrapper.
 * Returns null when the accumulated text does not (yet) match that wrapper so
 * callers suppress deltas and rely on `response.custom_tool_call_input.done`.
 */
function partialCustomToolInput(argumentsText: string): string | null {
  const match = FREEFORM_WRAP_PREFIX_RE.exec(argumentsText);
  if (!match) return null;
  const body = argumentsText.slice(match[0]!.length);
  let output = "";
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === '"') break;
    if (char !== "\\") {
      output += char;
      continue;
    }
    const escaped = body[index + 1];
    if (escaped === undefined) break;
    index += 1;
    if (escaped === "n") output += "\n";
    else if (escaped === "t") output += "\t";
    else if (escaped === "r") output += "\r";
    else if (escaped === "b") output += "\b";
    else if (escaped === "f") output += "\f";
    else if (escaped === "u") {
      const hex = body.slice(index + 1, index + 5);
      if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break;
      output += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
    } else output += escaped;
  }
  return output;
}

function replaceSseEventName(block: string, type: string): string {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  let replaced = false;
  const next = lines.map(line => {
    if (!replaced && line.startsWith("event:")) {
      replaced = true;
      return `event: ${type}`;
    }
    return line;
  });
  return next.join(newline);
}

type OpenCustomCall = {
  argumentsText: string;
  emittedInput: string;
  retainedBytes: number;
};

type PendingArgumentBlock = {
  block: string;
  itemId?: string;
  outputIndex?: number;
  retainedBytes: number;
};

export function createRoutedCustomToolRestoreBlockRewrite(
  names: ReadonlySet<string>,
  budget?: TranslatorBudget,
  repairNames: ReadonlySet<string> = new Set(),
  declaredNames?: ReadonlySet<string>,
): SseBlockRewrite {
  const itemNames = new Map<string, { name: string; aliased: boolean; namespace?: string }>();
  // Native helper aliases and genuine bare code-mode exec calls share completion repair.
  const customExecItemNames = new Map<string, string>();
  const repairItemNames = new Map<string, string>();
  const ordinaryItemIds = new Set<string>();
  const openCalls = new Map<string, OpenCustomCall>();
  let pendingArguments: PendingArgumentBlock[] = [];
  let disposed = false;

  const releaseCall = (itemId: string): void => {
    const open = openCalls.get(itemId);
    if (!open) return;
    if (open.retainedBytes > 0) {
      budget?.releaseRetained(open.retainedBytes, { kind: "retained_collectors" });
    }
    openCalls.delete(itemId);
  };

  const releaseAll = (): void => {
    if (disposed) return;
    disposed = true;
    for (const itemId of openCalls.keys()) releaseCall(itemId);
    const pendingBytes = pendingArguments.reduce((total, pending) => total + pending.retainedBytes, 0);
    if (pendingBytes > 0) {
      budget?.releaseRetained(pendingBytes, { kind: "retained_collectors" });
    }
    pendingArguments = [];
    itemNames.clear();
    customExecItemNames.clear();
    repairItemNames.clear();
    ordinaryItemIds.clear();
  };

  const retainPendingArgument = (
    block: string,
    itemId: string | undefined,
    outputIndex: number | undefined,
  ): void => {
    const retainedBytes = Buffer.byteLength(block, "utf8");
    if (retainedBytes > 0) budget?.chargeRetained(retainedBytes, { kind: "retained_collectors" });
    pendingArguments.push({ block, itemId, outputIndex, retainedBytes });
  };

  const takePendingArguments = (
    itemId: string | undefined,
    outputIndex: number | undefined,
  ): string[] => {
    const matched: PendingArgumentBlock[] = [];
    const remaining: PendingArgumentBlock[] = [];
    for (const pending of pendingArguments) {
      const matches = pending.itemId !== undefined
        ? itemId !== undefined && pending.itemId === itemId
        : outputIndex !== undefined && pending.outputIndex === outputIndex;
      (matches ? matched : remaining).push(pending);
    }
    pendingArguments = remaining;
    const retainedBytes = matched.reduce((total, pending) => total + pending.retainedBytes, 0);
    if (retainedBytes > 0) {
      budget?.releaseRetained(retainedBytes, { kind: "retained_collectors" });
    }
    // Index-matched entries carry no item id. Stamp the resolved id so replay
    // classifies the event instead of buffering it a second time.
    return matched.map(pending => {
      if (pending.itemId !== undefined || itemId === undefined) return pending.block;
      const payload = sseDataPayload(pending.block);
      if (payload === null) return pending.block;
      try {
        const parsed: unknown = JSON.parse(payload);
        if (!isPlainObject(parsed)) return pending.block;
        return replaceSseDataPayload(pending.block, JSON.stringify({ ...parsed, item_id: itemId }));
      } catch {
        return pending.block;
      }
    });
  };

  const rewrite: SseBlockRewrite = (block: string): readonly string[] => {
    if (disposed) return [block];
    const payload = sseDataPayload(block);
    if (payload === null || payload === "[DONE]") return [block];
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return [block];
    }
    if (!isPlainObject(parsed)) return [block];

    const type = typeof parsed.type === "string" ? parsed.type : "";
    const outputIndex = typeof parsed.output_index === "number"
      && Number.isInteger(parsed.output_index)
      && parsed.output_index >= 0
      ? parsed.output_index
      : undefined;
    if (
      (type === "response.output_item.added" || type === "response.output_item.done")
      && isPlainObject(parsed.item)
      && parsed.item.type === "custom_tool_call"
      && typeof parsed.item.name === "string"
    ) {
      const upstreamItemId = typeof parsed.item.id === "string" ? parsed.item.id : undefined;
      const wireName = routedCustomToolWireName(parsed.item);
      const targetName = routedCustomToolTargetName(parsed.item, names, declaredNames);
      const aliased = targetName !== undefined && targetName !== wireName;
      const codeModeExec = targetName === "exec" && parsed.item.name === "exec"
        && parsed.item.namespace === undefined && declaresCodeModeExec(declaredNames);
      if (upstreamItemId && (aliased || codeModeExec)) {
        customExecItemNames.set(upstreamItemId, parsed.item.name);
        if (type === "response.output_item.added") {
          openCalls.set(upstreamItemId, { argumentsText: "", emittedInput: "", retainedBytes: 0 });
        }
      }
      const repairable = wireName !== undefined && repairNames.has(wireName);
      if (upstreamItemId && repairable) repairItemNames.set(upstreamItemId, parsed.item.name);
      const restored = repairable || aliased || codeModeExec
        ? restoreRoutedCustomCalls(parsed, names, repairNames, declaredNames)
        : { value: parsed, changed: false };
      if (type === "response.output_item.done" && upstreamItemId) releaseCall(upstreamItemId);
      return restored.changed
        ? [replaceSseDataPayload(block, JSON.stringify(restored.value))]
        : [block];
    }
    if (
      (type === "response.output_item.added" || type === "response.output_item.done")
      && isPlainObject(parsed.item)
      && parsed.item.type === "function_call"
      && typeof parsed.item.name === "string"
    ) {
      const upstreamItemId = typeof parsed.item.id === "string" ? parsed.item.id : undefined;
      const targetName = routedCustomToolTargetName(parsed.item, names, declaredNames);
      const routed = targetName !== undefined;
      const wireName = routedCustomToolWireName(parsed.item);
      if (upstreamItemId) {
        if (routed) {
          itemNames.set(upstreamItemId, {
            name: parsed.item.name,
            aliased: targetName !== wireName,
            ...(typeof parsed.item.namespace === "string" ? { namespace: parsed.item.namespace } : {}),
          });
          ordinaryItemIds.delete(upstreamItemId);
        } else {
          ordinaryItemIds.add(upstreamItemId);
        }
        if (routed && type === "response.output_item.added") {
          openCalls.set(upstreamItemId, { argumentsText: "", emittedInput: "", retainedBytes: 0 });
        }
      }
      const pending = takePendingArguments(upstreamItemId, outputIndex);
      if (!routed) {
        if (type === "response.output_item.done" && upstreamItemId) ordinaryItemIds.delete(upstreamItemId);
        return [...pending, block];
      }
      if (upstreamItemId && pending.length > 0 && !openCalls.has(upstreamItemId)) {
        openCalls.set(upstreamItemId, { argumentsText: "", emittedInput: "", retainedBytes: 0 });
      }
      const restored = restoreRoutedCustomCalls(parsed, names, repairNames, declaredNames);
      const restoredBlock = restored.changed
        ? replaceSseDataPayload(block, JSON.stringify(restored.value))
        : block;
      const replayed = pending.flatMap(pendingBlock => rewrite(pendingBlock));
      if (type === "response.output_item.done" && upstreamItemId) releaseCall(upstreamItemId);
      return type === "response.output_item.added"
        ? [restoredBlock, ...replayed]
        : [...replayed, restoredBlock];
    }

    const upstreamItemId = typeof parsed.item_id === "string" ? parsed.item_id : undefined;
    if (
      type === "response.custom_tool_call_input.delta"
      && upstreamItemId
      && customExecItemNames.has(upstreamItemId)
    ) {
      const open = openCalls.get(upstreamItemId) ?? { argumentsText: "", emittedInput: "", retainedBytes: 0 };
      const delta = typeof parsed.delta === "string" ? parsed.delta : "";
      const deltaBytes = Buffer.byteLength(delta, "utf8");
      if (deltaBytes > 0) budget?.chargeRetained(deltaBytes, { kind: "retained_collectors" });
      open.argumentsText += delta;
      open.retainedBytes += deltaBytes;
      openCalls.set(upstreamItemId, open);
      if (customExecItemNames.get(upstreamItemId) !== "exec"
        || mayBecomePatchEnvelope(open.argumentsText)
        // JSON.parse accepts whitespace, escaped keys and arbitrary property order.
        // Any object prefix may still wrap a patch; keep it until authoritative completion.
        || open.argumentsText.trimStart() === ""
        || open.argumentsText.trimStart().startsWith("{")) return [];
      // If a held prefix turns out to be ordinary JavaScript, release the entire
      // un-emitted suffix. Native custom input remains byte-exact.
      const inputDelta = open.argumentsText.slice(open.emittedInput.length);
      open.emittedInput = open.argumentsText;
      return inputDelta ? [replaceSseDataPayload(block, JSON.stringify({ ...parsed, delta: inputDelta }))] : [];
    }
    if (
      type === "response.custom_tool_call_input.done"
      && upstreamItemId
      && customExecItemNames.has(upstreamItemId)
    ) {
      const source = typeof parsed.input === "string"
        ? parsed.input
        : openCalls.get(upstreamItemId)?.argumentsText ?? "";
      const name = customExecItemNames.get(upstreamItemId)!;
      const helper = name === "exec"
        ? resolveCodeModeHelperName(undefined, name, source, undefined, declaredNames)
        : name;
      releaseCall(upstreamItemId);
      return [replaceSseDataPayload(block, JSON.stringify({
        ...parsed,
        input: helper ? compileCodeModeHelperInput(source, helper) : source,
      }))];
    }
    if (
      type === "response.custom_tool_call_input.done"
      && upstreamItemId
      && repairItemNames.has(upstreamItemId)
      && typeof parsed.input === "string"
    ) {
      const input = normalizeApplyPatchDelimiters(parsed.input);
      if (input !== parsed.input) {
        return [replaceSseDataPayload(block, JSON.stringify({ ...parsed, input }))];
      }
    }
    const argumentEvent = type === "response.function_call_arguments.delta"
      || type === "response.function_call_arguments.done";
    if (argumentEvent && (!upstreamItemId || (!itemNames.has(upstreamItemId) && !ordinaryItemIds.has(upstreamItemId)))) {
      retainPendingArgument(block, upstreamItemId, outputIndex);
      return [];
    }
    if (
      type === "response.function_call_arguments.delta"
      && upstreamItemId
      && itemNames.has(upstreamItemId)
    ) {
      const open = openCalls.get(upstreamItemId) ?? { argumentsText: "", emittedInput: "", retainedBytes: 0 };
      const delta = typeof parsed.delta === "string" ? parsed.delta : "";
      const deltaBytes = Buffer.byteLength(delta, "utf8");
      if (deltaBytes > 0) budget?.chargeRetained(deltaBytes, { kind: "retained_collectors" });
      open.argumentsText += delta;
      open.retainedBytes += deltaBytes;
      openCalls.set(upstreamItemId, open);
      // A helper alias will become JavaScript at completion, never raw patch/JSON.
      if (itemNames.get(upstreamItemId)?.aliased) return [];
      // Still accumulating toward the compact wrapper, or an unrecognized shape:
      // suppress progressive emission and let the done event carry input.
      if (FREEFORM_WRAP_PREFIX.startsWith(open.argumentsText)) return [];
      const fullInput = partialCustomToolInput(open.argumentsText);
      if (fullInput === null) return [];
      // Hold a buffer that could still become a complete patch envelope. The done event
      // recompiles such a body into an apply_patch helper call, so streaming the envelope
      // bytes first and replacing them at completion is the rewind this path forbids.
      // Mirrors the same hold in `src/bridge.ts`.
      if (
        declaresCodeModeExec(declaredNames)
        && itemNames.get(upstreamItemId)?.namespace === undefined
        && itemNames.get(upstreamItemId)?.name === "exec"
        && mayBecomePatchEnvelope(fullInput)
      ) return [];
      if (!fullInput.startsWith(open.emittedInput) || fullInput.length === open.emittedInput.length) return [];
      const inputDelta = fullInput.slice(open.emittedInput.length);
      open.emittedInput = fullInput;
      const nextType = "response.custom_tool_call_input.delta";
      const next = {
        ...parsed,
        type: nextType,
        item_id: customToolItemId(upstreamItemId),
        delta: inputDelta,
      };
      return [replaceSseDataPayload(replaceSseEventName(block, nextType), JSON.stringify(next))];
    }

    if (
      type === "response.function_call_arguments.done"
      && upstreamItemId
      && itemNames.has(upstreamItemId)
    ) {
      const nextType = "response.custom_tool_call_input.done";
      const source = typeof parsed.arguments === "string"
        ? parsed.arguments
        : openCalls.get(upstreamItemId)?.argumentsText ?? "";
      const { arguments: _arguments, ...rest } = parsed;
      const itemName = itemNames.get(upstreamItemId);
      // Name-based alias first; otherwise a raw patch envelope submitted as the `exec` body
      // resolves to the same apply_patch helper (devlog/_plan/260905_apply_patch_envelope_gap).
      const helper = itemName?.aliased
        ? itemName.name
        : resolveCodeModeHelperName(undefined, itemName?.name ?? "", source, itemName?.namespace, declaredNames);
      const next = {
        ...rest,
        type: nextType,
        item_id: customToolItemId(upstreamItemId),
        input: helper
          ? compileCodeModeHelperInput(source, helper)
          : unwrapRoutedCustomToolArguments(source, itemName?.name ?? "", itemName?.namespace),
      };
      return [replaceSseDataPayload(replaceSseEventName(block, nextType), JSON.stringify(next))];
    }

    const restored = restoreRoutedCustomCalls(parsed, names, repairNames, declaredNames);
    const terminal = type === "response.completed" || type === "response.failed" || type === "response.incomplete";
    if (terminal) releaseAll();
    return restored.changed
      ? [replaceSseDataPayload(block, JSON.stringify(restored.value))]
      : [block];
  };
  rewrite.dispose = releaseAll;
  return rewrite;
}
