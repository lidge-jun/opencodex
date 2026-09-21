/** Process-local recall of the last completed combo response on an explicit session lane. */
import { getCombo, targetKey } from "../../combos/types";
import { captureConfigGeneration, type GenerationContext } from "../../lib/state-store-sweeper";
import type { OcxConfig, OcxComboTarget } from "../../types";

interface ComboRecallEntry {
  comboId: string;
  target: Pick<OcxComboTarget, "provider" | "model">;
  responseModel: string;
  at: number;
  /** UTF-8 size of `responseModel`, the only client-influenced field of unbounded length. */
  bytes: number;
}

const RECALL_CAPACITY = 256;
const RECALL_TTL_MS = 30 * 60 * 1000;
/**
 * A model id is provider-reported and arrives on the response, so nothing upstream of here
 * bounds its length. Lane keys are already SHA-256 digests, so the model string is the only
 * field that can grow, and 256 lanes alone do not bound the bytes they hold.
 */
const RECALL_MODEL_BYTES_MAX = 1024;
const RECALL_TOTAL_BYTES_MAX = 64 * 1024;
const recall = new Map<string, ComboRecallEntry>();
let recallBytes = 0;
let lastReconciledGeneration = 0;
let liveOwners: Pick<GenerationContext, "comboIds" | "comboTargets" | "providerNames"> | undefined;

/** Every removal path goes through here so the byte counter can never drift from the map. */
function deleteEntry(lane: string): boolean {
  const entry = recall.get(lane);
  if (!entry) return false;
  recall.delete(lane);
  recallBytes -= entry.bytes;
  return true;
}

/**
 * UTF-8 size of a remembered model id, or null when it is too large to retain.
 *
 * The code-unit test runs first and is the part that matters: a UTF-8 encoding is never smaller
 * than the code-unit count, so an oversized string is rejected without encoding it, and the
 * bound cannot be defeated by paying the allocation it exists to prevent.
 */
function boundedModelBytes(responseModel: string): number | null {
  if (responseModel.length > RECALL_MODEL_BYTES_MAX) return null;
  const bytes = Buffer.byteLength(responseModel, "utf8");
  return bytes > RECALL_MODEL_BYTES_MAX ? null : bytes;
}

function ownsEntry(context: Pick<GenerationContext, "comboIds" | "comboTargets" | "providerNames">, entry: ComboRecallEntry): boolean {
  return context.comboIds.has(entry.comboId)
    && context.providerNames.has(entry.target.provider)
    && context.comboTargets.has(`${entry.comboId}::${targetKey(entry.target)}`);
}

export function rememberComboForLane(
  lane: string | undefined,
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  responseModel: string,
  writerGeneration: number,
): void {
  if (!lane || !comboId || !responseModel.trim()) return;
  // Reject even a same-named recreated owner: its previous in-flight turn is obsolete.
  if (writerGeneration < Math.max(lastReconciledGeneration, captureConfigGeneration())) return;
  // An unretainable model id DECLINES the write; it must not clear the lane. Every other
  // rejection above returns the same way, and clearing here would let a late completion erase
  // a newer selection that this function has no ordering information to compare against.
  const bytes = boundedModelBytes(responseModel);
  if (bytes === null) return;
  const entry = {
    comboId,
    target: { provider: target.provider, model: target.model },
    responseModel,
    at: Date.now(),
    bytes,
  };
  if (liveOwners && !ownsEntry(liveOwners, entry)) return;
  deleteEntry(lane);
  recall.set(lane, entry);
  recallBytes += bytes;
  // Insertion order is recency order, because every write re-inserts its lane at the back.
  // Evicting from the front therefore drops the least recently written lane, never this one:
  // a single entry is capped well below the aggregate budget, so it always fits.
  while (recall.size > RECALL_CAPACITY || recallBytes > RECALL_TOTAL_BYTES_MAX) {
    const oldest = recall.keys().next().value;
    if (oldest === undefined || oldest === lane) break;
    deleteEntry(oldest);
  }
}

export function recallComboForLane(
  config: OcxConfig,
  lane: string | undefined,
  model: string,
): string | undefined {
  if (!lane || !model || model.includes("/")) return undefined;
  const entry = recall.get(lane);
  if (!entry) return undefined;
  const combo = getCombo(config, entry.comboId);
  const provider = config.providers[entry.target.provider];
  if (Date.now() - entry.at >= RECALL_TTL_MS
    || !Object.hasOwn(config.providers, entry.target.provider)
    || !provider || provider.disabled === true
    || !combo?.targets.some(target => targetKey(target) === targetKey(entry.target))) {
    deleteEntry(lane);
    return undefined;
  }
  return entry.responseModel === model ? entry.comboId : undefined;
}

/**
 * Periodic expiry. Without it a lane that is never read again and never touched by a config
 * reconciliation holds its entry for the life of the process: the existing TTL is only
 * evaluated on read or on generation change.
 */
export function sweepExpiredComboRecall(now: number): number {
  let removed = 0;
  for (const [lane, entry] of recall) {
    if (now - entry.at >= RECALL_TTL_MS && deleteEntry(lane)) removed += 1;
  }
  return removed;
}

export function reconcileComboRecall(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  lastReconciledGeneration = context.generation;
  liveOwners = {
    comboIds: new Set(context.comboIds),
    comboTargets: new Set(context.comboTargets),
    providerNames: new Set(context.providerNames),
  };
  let removed = 0;
  for (const [lane, entry] of recall) {
    if (!ownsEntry(context, entry) || Date.now() - entry.at >= RECALL_TTL_MS) {
      if (deleteEntry(lane)) removed += 1;
    }
  }
  return removed;
}

/** Test-only reset, alongside the combo rotation/cooldown resets. */
export function clearComboRecallForTests(): void {
  recall.clear();
  recallBytes = 0;
  lastReconciledGeneration = 0;
  liveOwners = undefined;
}
