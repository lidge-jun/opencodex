import type { OcxConfig } from "../types";
import { sanitizeLogMetadataString } from "../lib/redact";

export type AdvisorTrigger = "manual" | "preflight" | "repair_failure";
export interface AdvisorActivity {
  id: string;
  startedAt: number;
  trigger: AdvisorTrigger;
  workerModel: string;
  advisorModel: string;
  requestedEffort: string;
  /** Adapter serialization evidence, not a claim about the provider's hidden reasoning. */
  effectiveEffort: string | null;
  status: "running" | "ok" | "failed" | "cancelled" | "blocked";
  durationMs: number | null;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  blockReason?: "consent" | "settings" | "budget" | "limit" | "duplicate";
}

/** Metadata only. No prompts, advice, commands, task/thread ids, errors, or hidden reasoning. */
export function createAdvisorActivityStore() {
  const entries: AdvisorActivity[] = [];
  const retain = (now: number) => {
    while (entries.length && (entries.length > 100 || entries[0]!.startedAt < now - 86_400_000)) entries.shift();
  };
  return {
    start(input: Pick<AdvisorActivity, "trigger" | "workerModel" | "advisorModel" | "requestedEffort">, now = Date.now()) {
      const entry: AdvisorActivity = {
        id: crypto.randomUUID(), startedAt: now, ...input,
        workerModel: sanitizeLogMetadataString(input.workerModel, 200) ?? "unknown",
        advisorModel: sanitizeLogMetadataString(input.advisorModel, 200) ?? "unknown",
        effectiveEffort: null, status: "running", durationMs: null,
      };
      entries.push(entry);
      retain(now);
      return entry.id;
    },
    finish(id: string, outcome: Pick<AdvisorActivity, "status" | "durationMs"> & Partial<Pick<AdvisorActivity, "usage" | "effectiveEffort" | "blockReason">>) {
      const entry = entries.find(item => item.id === id);
      if (entry) Object.assign(entry, outcome);
    },
    snapshot(now = Date.now()): AdvisorActivity[] {
      retain(now);
      return entries.toReversed().map(entry => ({ ...entry, ...(entry.usage ? { usage: { ...entry.usage } } : {}) }));
    },
  };
}

export type AdvisorActivityStore = ReturnType<typeof createAdvisorActivityStore>;
const stores = new WeakMap<Pick<OcxConfig, "advisor">, AdvisorActivityStore>();
export function advisorActivityStore(config: Pick<OcxConfig, "advisor">): AdvisorActivityStore {
  let store = stores.get(config);
  if (!store) { store = createAdvisorActivityStore(); stores.set(config, store); }
  return store;
}
