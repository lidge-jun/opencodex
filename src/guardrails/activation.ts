import type { OcxConfig, OcxGuardrailsConfig } from "../types";
import { isValidGuardrailsProviderId } from "../config/provider-name";
import type { GuardrailsRuntimeSnapshot, GuardrailsRuntimeSnapshotLease } from "./runtime";

type GuardrailsRuntimeModule = typeof import("./runtime");
type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type CapturedGuardrailsPolicy = DeepReadonly<OcxGuardrailsConfig>;
const disabledPolicy: CapturedGuardrailsPolicy = Object.freeze({ enabled: false });

const defaultRuntimeModuleLoader = (): Promise<GuardrailsRuntimeModule> => import("./runtime");
let runtimeModuleLoader = defaultRuntimeModuleLoader;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function runtimePolicyConfig(captured: CapturedGuardrailsPolicy): OcxGuardrailsConfig {
  return captured as OcxGuardrailsConfig;
}

/** Capture Guardrails intent, including disabled admission, independently of later live config. */
export function captureGuardrailsPolicy(
  config: OcxConfig,
): CapturedGuardrailsPolicy {
  return config.guardrails?.enabled === true
    ? deepFreeze(structuredClone(config.guardrails))
    : disabledPolicy;
}

/**
 * Unknown provider identity is protected until routing can classify it. A
 * valid, explicitly excluded provider is the only selected-scope fast path.
 */
export function guardrailsPolicyProtectsProvider(
  captured: CapturedGuardrailsPolicy | undefined,
  providerId: string | undefined,
): boolean {
  if (captured?.enabled !== true) return false;
  if (captured.providerScope?.mode !== "selected") return true;
  if (providerId === undefined || !isValidGuardrailsProviderId(providerId)) return true;
  return captured.providerScope.providerIds.includes(providerId);
}

function snapshotForCapturedPolicy(
  config: OcxConfig,
  captured: CapturedGuardrailsPolicy,
  runtime: GuardrailsRuntimeModule,
): { snapshot: GuardrailsRuntimeSnapshot; transient: boolean } {
  const runtimeConfig = runtimePolicyConfig(captured);
  const expectedRevision = runtime.guardrailsPolicyRevision(runtimeConfig);
  const currentRevision = config.guardrails?.enabled === true
    ? runtime.guardrailsPolicyRevision(config.guardrails)
    : undefined;
  const current = currentRevision === expectedRevision
    ? runtime.guardrailsRuntimeSnapshot(config)
    : undefined;
  return current?.policyRevision === expectedRevision
    ? { snapshot: current, transient: false }
    : { snapshot: runtime.compileGuardrailsRuntimeSnapshot(runtimeConfig), transient: true };
}

/** Deterministic dynamic-import race seam; production callers never set this. */
export function setGuardrailsRuntimeModuleLoaderForTests(
  loader?: () => Promise<GuardrailsRuntimeModule>,
): void {
  runtimeModuleLoader = loader ?? defaultRuntimeModuleLoader;
}

/**
 * Retain an already captured snapshot without putting the RE2 runtime back on
 * the disabled request path through a static import.
 */
export async function retainCapturedGuardrailsRuntimeSnapshot(
  snapshot: GuardrailsRuntimeSnapshot,
): Promise<GuardrailsRuntimeSnapshotLease> {
  const runtime = await runtimeModuleLoader();
  return runtime.retainGuardrailsRuntimeSnapshot(snapshot);
}

/**
 * Resolve a previously captured policy after routing. A known excluded
 * provider returns before the dynamic import boundary.
 */
export async function activeCapturedGuardrailsRuntimeSnapshot(
  config: OcxConfig,
  captured: CapturedGuardrailsPolicy | undefined,
  providerId: string | undefined,
): Promise<GuardrailsRuntimeSnapshot | undefined> {
  if (!captured || !guardrailsPolicyProtectsProvider(captured, providerId)) return undefined;
  const runtime = await runtimeModuleLoader();
  return snapshotForCapturedPolicy(config, captured, runtime).snapshot;
}

/** Acquire a request-scoped lease for a captured, provider-classified policy. */
export async function leaseCapturedGuardrailsRuntimeSnapshot(
  config: OcxConfig,
  captured: CapturedGuardrailsPolicy | undefined,
  providerId: string | undefined,
): Promise<GuardrailsRuntimeSnapshotLease | undefined> {
  if (!captured || !guardrailsPolicyProtectsProvider(captured, providerId)) return undefined;
  const runtime = await runtimeModuleLoader();
  const selected = snapshotForCapturedPolicy(config, captured, runtime);
  const lease = runtime.retainGuardrailsRuntimeSnapshot(selected.snapshot);
  if (selected.transient) {
    runtime.disposeGuardrailsRuntimeSnapshot(selected.snapshot);
  }
  return lease;
}

/**
 * Keep RE2/WASM out of the ordinary proxy startup path. The runtime module is
 * loaded only after the persisted feature flag is explicitly enabled.
 */
export async function activeGuardrailsRuntimeSnapshot(
  config: OcxConfig,
): Promise<GuardrailsRuntimeSnapshot | undefined> {
  const captured = captureGuardrailsPolicy(config);
  return activeCapturedGuardrailsRuntimeSnapshot(config, captured, undefined);
}

/** Acquire a request-scoped lease so a hot reload cannot dispose its RE2 matchers mid-scan. */
export async function leaseActiveGuardrailsRuntimeSnapshot(
  config: OcxConfig,
): Promise<GuardrailsRuntimeSnapshotLease | undefined> {
  const captured = captureGuardrailsPolicy(config);
  return leaseCapturedGuardrailsRuntimeSnapshot(config, captured, undefined);
}
