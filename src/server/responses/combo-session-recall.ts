/** Process-local recall of the last completed combo response on an explicit session lane. */
import { getCombo, targetKey } from "../../combos/types";
import { captureConfigGeneration, type GenerationContext } from "../../lib/state-store-sweeper";
import type { OcxConfig, OcxComboTarget } from "../../types";

interface ComboRecallEntry {
  comboId: string;
  target: Pick<OcxComboTarget, "provider" | "model">;
  responseModel: string;
  responseModelBytes: number;
  at: number;
}

const RECALL_CAPACITY = 256;
const RECALL_TTL_MS = 30 * 60 * 1000;
const RECALL_MODEL_MAX_BYTES = 1024;
const RECALL_MODEL_TOTAL_BYTES = 64 * 1024;
const recall = new Map<string, ComboRecallEntry>();
let retainedModelBytes = 0;
let lastReconciledGeneration = 0;
let liveOwners: Pick<GenerationContext, "comboIds" | "comboTargets" | "providerNames"> | undefined;

function ownsEntry(context: Pick<GenerationContext, "comboIds" | "comboTargets" | "providerNames">, entry: ComboRecallEntry): boolean {
  return context.comboIds.has(entry.comboId)
    && context.providerNames.has(entry.target.provider)
    && context.comboTargets.has(`${entry.comboId}::${targetKey(entry.target)}`);
}

function deleteEntry(lane: string): boolean {
  const entry = recall.get(lane);
  if (!entry) return false;
  retainedModelBytes -= entry.responseModelBytes;
  return recall.delete(lane);
}

function boundedModelBytes(model: string): number | undefined {
  // Check code units before trimming or encoding to avoid another unbounded copy.
  if (model.length > RECALL_MODEL_MAX_BYTES) return undefined;
  const bytes = new TextEncoder().encode(model).byteLength;
  return bytes <= RECALL_MODEL_MAX_BYTES ? bytes : undefined;
}

export function rememberComboForLane(
  lane: string | undefined,
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  responseModel: string,
  writerGeneration: number,
): void {
  if (!lane || !comboId) return;
  // Reject even a same-named recreated owner: its previous in-flight turn is obsolete.
  if (writerGeneration < Math.max(lastReconciledGeneration, captureConfigGeneration())) return;
  const entry = { comboId, target: { provider: target.provider, model: target.model }, responseModel, responseModelBytes: 0, at: Date.now() };
  if (liveOwners && !ownsEntry(liveOwners, entry)) return;
  // Whitespace-only completions were always a no-op; test before the size branch so an
  // oversized blank cannot fall into the clear path, and without allocating a trimmed copy.
  if (!/\S/u.test(responseModel)) return;
  const modelBytes = boundedModelBytes(responseModel);
  if (modelBytes === undefined) {
    // This accepted completion supersedes the lane even when its model cannot be retained.
    deleteEntry(lane);
    return;
  }
  entry.responseModelBytes = modelBytes;
  deleteEntry(lane);
  recall.set(lane, entry);
  retainedModelBytes += modelBytes;
  while (recall.size > RECALL_CAPACITY || retainedModelBytes > RECALL_MODEL_TOTAL_BYTES) {
    const oldest = recall.keys().next().value;
    if (oldest === undefined) break;
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
      deleteEntry(lane);
      removed += 1;
    }
  }
  return removed;
}

export function sweepExpiredComboRecall(now: number): number {
  let removed = 0;
  for (const [lane, entry] of recall) {
    if (now - entry.at < RECALL_TTL_MS) continue;
    deleteEntry(lane);
    removed += 1;
  }
  return removed;
}

/** Test-only reset, alongside the combo rotation/cooldown resets. */
export function clearComboRecallForTests(): void {
  recall.clear();
  retainedModelBytes = 0;
  lastReconciledGeneration = 0;
  liveOwners = undefined;
}
