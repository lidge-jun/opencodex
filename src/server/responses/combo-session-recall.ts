/** Process-local recall of the last completed combo response on an explicit session lane. */
import { getCombo, targetKey } from "../../combos/types";
import { captureConfigGeneration, type GenerationContext } from "../../lib/state-store-sweeper";
import type { OcxConfig, OcxComboTarget } from "../../types";

interface ComboRecallEntry {
  comboId: string;
  target: Pick<OcxComboTarget, "provider" | "model">;
  responseModel: string;
  at: number;
}

const RECALL_CAPACITY = 256;
const RECALL_TTL_MS = 30 * 60 * 1000;
const recall = new Map<string, ComboRecallEntry>();
let lastReconciledGeneration = 0;
let liveOwners: Pick<GenerationContext, "comboIds" | "comboTargets" | "providerNames"> | undefined;

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
  const entry = { comboId, target: { provider: target.provider, model: target.model }, responseModel, at: Date.now() };
  if (liveOwners && !ownsEntry(liveOwners, entry)) return;
  recall.delete(lane);
  recall.set(lane, entry);
  while (recall.size > RECALL_CAPACITY) {
    const oldest = recall.keys().next().value;
    if (oldest === undefined) break;
    recall.delete(oldest);
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
    recall.delete(lane);
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
      recall.delete(lane);
      removed += 1;
    }
  }
  return removed;
}

/** Test-only reset, alongside the combo rotation/cooldown resets. */
export function clearComboRecallForTests(): void {
  recall.clear();
  lastReconciledGeneration = 0;
  liveOwners = undefined;
}
