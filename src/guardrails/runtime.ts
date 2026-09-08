import { createHash } from "node:crypto";
import type { OcxConfig, OcxGuardrailsConfig } from "../types";
import { guardrailsRegistryOptions } from "./config-schema";
import { createGuardrailsRegistry } from "./registry";
import type { GuardrailsRegistry } from "./types";

export interface GuardrailsRuntimeSnapshot {
  config: Readonly<OcxGuardrailsConfig>;
  enabled: boolean;
  failurePolicy: "block" | "passthrough";
  generation: number;
  mode: "enforce" | "detect";
  policyRevision: string;
  registry: GuardrailsRegistry;
}

export interface GuardrailsRuntimeSnapshotLease {
  readonly snapshot: GuardrailsRuntimeSnapshot;
  release(): void;
}

let nextGeneration = 1;
const snapshots = new WeakMap<OcxConfig, GuardrailsRuntimeSnapshot>();
const lifetimes = new WeakMap<GuardrailsRuntimeSnapshot, {
  disposed: boolean;
  leases: number;
  retired: boolean;
}>();

function lifetime(snapshot: GuardrailsRuntimeSnapshot) {
  const existing = lifetimes.get(snapshot);
  if (existing) return existing;
  const created = { disposed: false, leases: 0, retired: false };
  lifetimes.set(snapshot, created);
  return created;
}

function disposeWhenIdle(snapshot: GuardrailsRuntimeSnapshot): void {
  const state = lifetime(snapshot);
  if (!state.retired || state.leases !== 0 || state.disposed) return;
  state.disposed = true;
  snapshot.registry.dispose();
}

function retireGuardrailsRuntimeSnapshot(snapshot: GuardrailsRuntimeSnapshot): void {
  const state = lifetime(snapshot);
  state.retired = true;
  disposeWhenIdle(snapshot);
}

function frozenSnapshotConfig(config: OcxGuardrailsConfig): Readonly<OcxGuardrailsConfig> {
  const snapshot = structuredClone(config);
  if (snapshot.enabledDataTypes) Object.freeze(snapshot.enabledDataTypes);
  if (snapshot.disabledBuiltinRuleIds) Object.freeze(snapshot.disabledBuiltinRuleIds);
  if (snapshot.customRules) {
    for (const rule of snapshot.customRules) {
      Object.freeze(rule.keywords);
      Object.freeze(rule.banlist);
      Object.freeze(rule.validators);
      Object.freeze(rule.masking.captureGroups);
      Object.freeze(rule.masking);
      Object.freeze(rule);
    }
    Object.freeze(snapshot.customRules);
  }
  return Object.freeze(snapshot);
}

function canonicalPolicyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalPolicyValue);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) canonical[key] = canonicalPolicyValue(source[key]);
  return canonical;
}

export function guardrailsPolicyRevision(config: OcxGuardrailsConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalPolicyValue(config)))
    .digest("hex");
}

export function compileGuardrailsRuntimeSnapshot(config: OcxGuardrailsConfig): GuardrailsRuntimeSnapshot {
  const snapshot = Object.freeze({
    config: frozenSnapshotConfig(config),
    enabled: config.enabled === true,
    mode: config.mode ?? "enforce",
    failurePolicy: config.failurePolicy ?? "block",
    generation: nextGeneration++,
    registry: createGuardrailsRegistry(guardrailsRegistryOptions(config)),
    policyRevision: guardrailsPolicyRevision(config),
  });
  lifetime(snapshot);
  return snapshot;
}

export function publishGuardrailsRuntimeSnapshot(
  config: OcxConfig,
  snapshot: GuardrailsRuntimeSnapshot | undefined,
): void {
  const previous = snapshots.get(config);
  if (snapshot) snapshots.set(config, snapshot);
  else snapshots.delete(config);
  if (previous && previous !== snapshot) retireGuardrailsRuntimeSnapshot(previous);
}

/** Lazy data-path lookup. Disabled config returns before YAML/WASM compilation. */
export function guardrailsRuntimeSnapshot(config: OcxConfig): GuardrailsRuntimeSnapshot | undefined {
  if (config.guardrails?.enabled !== true) return undefined;
  const cached = snapshots.get(config);
  if (cached) return cached;
  const snapshot = compileGuardrailsRuntimeSnapshot(config.guardrails);
  snapshots.set(config, snapshot);
  return snapshot;
}

/** Retain an immutable runtime snapshot until the active request finishes scanning. */
export function retainGuardrailsRuntimeSnapshot(snapshot: GuardrailsRuntimeSnapshot): GuardrailsRuntimeSnapshotLease {
  const state = lifetime(snapshot);
  if (state.disposed) throw new Error("Guardrails runtime snapshot was already disposed");
  state.leases += 1;
  let released = false;
  return {
    snapshot,
    release() {
      if (released) return;
      released = true;
      state.leases -= 1;
      disposeWhenIdle(snapshot);
    },
  };
}

export function leaseGuardrailsRuntimeSnapshot(config: OcxConfig): GuardrailsRuntimeSnapshotLease | undefined {
  const snapshot = guardrailsRuntimeSnapshot(config);
  return snapshot ? retainGuardrailsRuntimeSnapshot(snapshot) : undefined;
}

export function disposeGuardrailsRuntimeSnapshot(snapshot: GuardrailsRuntimeSnapshot): void {
  retireGuardrailsRuntimeSnapshot(snapshot);
}
