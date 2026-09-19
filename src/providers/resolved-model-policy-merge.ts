import type { OcxProviderConfig } from "../types";
import { MODEL_ADAPTER_OVERRIDE_ALLOWED } from "../types";
import type { InboundWire, ModelWireDefault, ProviderRegistryEntry } from "./registry/types";

export type StaticPolicySource =
  | "operator" | "operator-capability" | "captured-auth"
  | "registry" | "hard-pin" | "provider-default" | "unknown";

export function detachedClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => detachedClone(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => [key, detachedClone(nested)])) as T;
  }
  return value;
}

export function recursivelyFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) recursivelyFreeze(nested);
  return Object.freeze(value);
}

export function scalar<T>(operator: T | undefined, registry: T | undefined): [T | undefined, StaticPolicySource] {
  if (operator !== undefined) return [detachedClone(operator), "operator"];
  if (registry !== undefined) return [detachedClone(registry), "registry"];
  return [undefined, "unknown"];
}

export function mapFill<T>(
  registry: Readonly<Record<string, T>> | undefined,
  operator: Readonly<Record<string, T>> | undefined,
): [Record<string, T> | undefined, StaticPolicySource] {
  if (!registry && !operator) return [undefined, "unknown"];
  return [detachedClone({ ...(registry ?? {}), ...(operator ?? {}) }), operator ? "operator" : "registry"];
}

export function nestedMapFill(
  registry: Readonly<Record<string, Record<string, string>>> | undefined,
  operator: Readonly<Record<string, Record<string, string>>> | undefined,
): [Record<string, Record<string, string>> | undefined, StaticPolicySource] {
  if (!registry && !operator) return [undefined, "unknown"];
  const merged: Record<string, Record<string, string>> = {};
  for (const [key, value] of Object.entries(registry ?? {})) merged[key] = { ...value };
  for (const [key, value] of Object.entries(operator ?? {})) {
    merged[key] = { ...(merged[key] ?? {}), ...value };
  }
  return [merged, operator ? "operator" : "registry"];
}

export function positiveCapMap(
  registry: Readonly<Record<string, number>> | undefined,
  operator: Readonly<Record<string, number>> | undefined,
): [Record<string, number> | undefined, StaticPolicySource] {
  if (!registry && !operator) return [undefined, "unknown"];
  const merged = { ...(registry ?? {}) };
  for (const [key, value] of Object.entries(operator ?? {})) {
    merged[key] = typeof merged[key] === "number" ? Math.min(merged[key]!, value) : value;
  }
  return [merged, operator ? "operator" : "registry"];
}

export function stableUnion(
  registry: readonly string[] | undefined,
  operator: readonly string[] | undefined,
): [string[] | undefined, StaticPolicySource] {
  if (!registry && !operator) return [undefined, "unknown"];
  return [[...new Set([...(registry ?? []), ...(operator ?? [])])], operator ? "operator" : "registry"];
}

export function staticHeaders(
  registry: Readonly<Record<string, string>> | undefined,
  operator: Readonly<Record<string, string>> | undefined,
): [Record<string, string> | undefined, StaticPolicySource] {
  if (!registry && !operator) return [undefined, "unknown"];
  if (!registry) return [{ ...(operator ?? {}) }, "operator"];
  if (!operator) return [{ ...registry }, "registry"];
  const claimed = new Set(Object.keys(operator).map(name => name.toLowerCase()));
  const merged: Record<string, string> = { ...operator };
  for (const [name, value] of Object.entries(registry)) {
    if (!claimed.has(name.toLowerCase())) merged[name] = value;
  }
  return [merged, "operator"];
}

export function resolvedBaseUrl(
  entry: Readonly<ProviderRegistryEntry> | undefined,
  provider: Readonly<OcxProviderConfig>,
): [string, StaticPolicySource] {
  if (!entry) return [provider.baseUrl, "operator"];
  const configured = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
  const configuredIsResolved = configured.length > 0 && !/\{[^}]*\}/.test(configured);
  if (entry.allowBaseUrlOverride && !configuredIsResolved) {
    throw new Error(`Invalid baseUrl for provider "${entry.id}": expected a nonblank URL without unresolved placeholders`);
  }
  return (/\{[^}]*\}/.test(entry.baseUrl) || entry.allowBaseUrlOverride) && configuredIsResolved
    ? [configured, "operator"]
    : [entry.baseUrl, "registry"];
}

export function sameStringArray(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left?.length === right.length && left.every((value, index) => value === right[index]);
}

/** Legacy config-map lookup: exact id, colon family, then case-folded exact id. */
export function legacyModelValue<T>(record: Readonly<Record<string, T>> | undefined, modelId: string): T | undefined {
  if (!record) return undefined;
  if (Object.hasOwn(record, modelId)) return record[modelId];
  const colon = modelId.indexOf(":");
  if (colon > 0 && Object.hasOwn(record, modelId.slice(0, colon))) return record[modelId.slice(0, colon)];
  const folded = modelId.toLowerCase();
  return Object.entries(record).find(([key]) => key.toLowerCase() === folded)?.[1];
}

/** Provenance from the same merged-key walk as legacyModelValue. */
export function legacyModelSource<T>(
  operator: Readonly<Record<string, T>> | undefined,
  registry: Readonly<Record<string, T>> | undefined,
  modelId: string,
): StaticPolicySource {
  const merged = { ...(registry ?? {}), ...(operator ?? {}) };
  let winningKey: string | undefined;
  if (Object.hasOwn(merged, modelId)) winningKey = modelId;
  const colon = modelId.indexOf(":");
  if (winningKey === undefined && colon > 0 && Object.hasOwn(merged, modelId.slice(0, colon))) {
    winningKey = modelId.slice(0, colon);
  }
  if (winningKey === undefined) {
    const folded = modelId.toLowerCase();
    winningKey = Object.keys(merged).find(key => key.toLowerCase() === folded);
  }
  if (winningKey === undefined) return "unknown";
  return Object.hasOwn(operator ?? {}, winningKey) ? "operator" : "registry";
}

export function anthropicFamilyContextWindow(
  record: Readonly<Record<string, number>> | undefined,
  id: string,
): number | undefined {
  if (!record || !id.toLowerCase().startsWith("claude-")) return undefined;
  let candidate = id;
  while (true) {
    const cut = candidate.lastIndexOf("-");
    if (cut <= 0 || !/^\d+$/.test(candidate.slice(cut + 1))) return undefined;
    candidate = candidate.slice(0, cut);
    const value = record[candidate]
      ?? Object.entries(record).find(([key]) => key.toLowerCase() === candidate.toLowerCase())?.[1];
    if (typeof value === "number" && value > 0) return value;
  }
}

export function wireDefault(
  declared: ModelWireDefault | undefined,
  provider: Readonly<OcxProviderConfig>,
  entry: Readonly<ProviderRegistryEntry> | undefined,
  inbound: InboundWire,
  effectiveAuthMode: OcxProviderConfig["authMode"] | undefined,
): string | undefined {
  if (declared === undefined || !MODEL_ADAPTER_OVERRIDE_ALLOWED.has(provider.adapter)) return undefined;
  if (typeof declared !== "string") {
    if (!declared.inbound.includes(inbound)) return undefined;
    const authMode = effectiveAuthMode ?? provider.authMode ?? entry?.authKind;
    if (declared.authModes && authMode && !declared.authModes.includes(authMode)) return undefined;
  }
  const wire = typeof declared === "string" ? declared : declared.wire;
  return MODEL_ADAPTER_OVERRIDE_ALLOWED.has(wire) ? wire : undefined;
}
