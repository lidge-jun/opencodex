/**
 * Single-flight gate for CODEX_HOME storage mutations (cleanup, restore, policy).
 *
 * Manual cleanup, trash restore, and (Phase 3) policy-driven cleanup share one
 * in-flight slot per resolved CODEX_HOME. A second caller receives
 * `storage_mutation_busy` immediately — no per-operation queues.
 */
import { resolve } from "node:path";
import { resolveCodexHomeDir } from "../codex/home";
import { createAdmissionGate, type AdmissionLease, type AdmissionMetrics } from "../lib/admission";

export type StorageMutationKind = "cleanup" | "restore" | "policy";

export type StorageMutationBusyError = "storage_mutation_busy";

export interface StorageMutationCoordinatorTestHooks {
  /** Block after acquiring the slot, before mutation work (race tests). */
  blockMs?: number;
  /** Test-only cross-thread handshake after one mutation kind acquires its slot. */
  pauseAfterAcquire?: {
    kind: StorageMutationKind;
    readyPath: string;
    releasePath: string;
  };
}

interface ActiveSlot {
  kind: StorageMutationKind;
  startedAt: number;
  lease: AdmissionLease;
}

export const MAX_ACTIVE_STORAGE_HOME_SLOTS = 32;
const slots = new Map<string, ActiveSlot>();
const slotGate = createAdmissionGate("storage_home_slots", MAX_ACTIVE_STORAGE_HOME_SLOTS);
let releaseMisses = 0;
let testHooks: StorageMutationCoordinatorTestHooks | null = null;

function slotKey(codexHome?: string): string {
  return resolve(codexHome ?? resolveCodexHomeDir());
}

export function setStorageMutationCoordinatorTestHooks(
  hooks: StorageMutationCoordinatorTestHooks | null,
): void {
  testHooks = hooks;
}

export function resetStorageMutationCoordinatorForTests(): void {
  testHooks = null;
  for (const slot of slots.values()) slot.lease.release();
  slots.clear();
}

export function storageMutationAdmissionMetrics(): AdmissionMetrics {
  const metrics = slotGate.metrics();
  return { ...metrics, releaseMisses: metrics.releaseMisses + releaseMisses };
}

export function getActiveStorageMutation(
  codexHome?: string,
): { kind: StorageMutationKind; startedAt: number } | null {
  const active = slots.get(slotKey(codexHome));
  return active ? { kind: active.kind, startedAt: active.startedAt } : null;
}

export function tryBeginStorageMutation(
  kind: StorageMutationKind,
  codexHome?: string,
): { acquired: true; lease: AdmissionLease } | { acquired: false; error: StorageMutationBusyError } {
  const key = slotKey(codexHome);
  if (slots.has(key)) {
    return { acquired: false, error: "storage_mutation_busy" };
  }
  const lease = slotGate.tryAcquire();
  if (!lease) return { acquired: false, error: "storage_mutation_busy" };
  let active = true;
  const ownerLease: AdmissionLease = {
    release() {
      if (!active) return;
      active = false;
      const owner = slots.get(key);
      if (owner?.lease === ownerLease) slots.delete(key);
      lease.release();
    },
  };
  slots.set(key, { kind, startedAt: Date.now(), lease: ownerLease });
  return { acquired: true, lease: ownerLease };
}

export function endStorageMutation(codexHome?: string): void {
  const key = slotKey(codexHome);
  const slot = slots.get(key);
  if (!slot) {
    releaseMisses += 1;
    return;
  }
  slots.delete(key);
  slot.lease.release();
}

async function applyCoordinatorBlock(kind: StorageMutationKind): Promise<void> {
  const pause = testHooks?.pauseAfterAcquire;
  if (pause?.kind === kind) {
    await Bun.write(pause.readyPath, "ready\n");
    while (!Bun.file(pause.releasePath).size) await Bun.sleep(10);
  }
  const blockMs = testHooks?.blockMs;
  if (typeof blockMs === "number" && Number.isFinite(blockMs) && blockMs > 0) {
    await Bun.sleep(Math.floor(blockMs));
  }
}

/**
 * Phase 3 policy worker integration — wrap policy-driven cleanup FS/DB work.
 * Returns `{ ok: false, error: 'storage_mutation_busy' }` when another mutation
 * holds the CODEX_HOME slot.
 */
export async function runPolicyStorageMutation<T>(
  codexHome: string | undefined,
  work: () => T | Promise<T>,
): Promise<T | { ok: false; error: StorageMutationBusyError }> {
  const gate = tryBeginStorageMutation("policy", codexHome);
  if (!gate.acquired) {
    return { ok: false, error: "storage_mutation_busy" };
  }
  try {
    await applyCoordinatorBlock("policy");
    return await work();
  } finally {
    gate.lease.release();
  }
}

export async function withStorageMutationSlot<T>(
  kind: StorageMutationKind,
  codexHome: string | undefined,
  work: () => T | Promise<T>,
): Promise<T | { ok: false; error: StorageMutationBusyError }> {
  const gate = tryBeginStorageMutation(kind, codexHome);
  if (!gate.acquired) {
    return { ok: false, error: "storage_mutation_busy" };
  }
  try {
    await applyCoordinatorBlock(kind);
    return await work();
  } finally {
    gate.lease.release();
  }
}
