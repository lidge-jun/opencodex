import { nonBlankStringArrayConfigError, normalizeNonBlankStringArray } from "../../config/provider-validation";
import type { OcxProviderConfig } from "../../types";

/**
 * What a provider save keeps (#5563).
 *
 * `POST /api/providers` with an existing name replaces the stored row with a candidate built from
 * the request. The dashboard form cannot send the fields below, so a save that omits them used
 * to drop them from a custom provider, or reset them to the registry seed through
 * `enrichProviderFromCatalog` for a registry provider. The live-config reconcile cannot restore
 * them afterwards: the disk row equals its baseline, so the three-way merge keeps the value the
 * save wrote.
 *
 * These five settings record how one upstream behaves. An overwrite that keeps the destination
 * carries each one the request omits, including an explicit `[]` or `false`. An overwrite that
 * moves the provider to another destination carries none of them: they describe the previous
 * upstream, and registry enrichment already fills what is known about the new one. The same
 * destination rule gates the stored `apiKeyPool`, whose keys were issued for the previous
 * destination. A value the request sends always wins, and the rest of the old row is never merged
 * into the candidate.
 */
export const PROVIDER_COMPAT_CARRY_FIELDS = [
  "preserveReasoningContentModels",
  "requiresReasoningPlaceholderModels",
  "foldDeveloperRoleToSystem",
  "reasoningWireFormat",
  "omitReasoningEffortWithToolsModels",
] as const satisfies readonly (keyof OcxProviderConfig)[];

export type ProviderCompatCarryField = typeof PROVIDER_COMPAT_CARRY_FIELDS[number];

/** The only `reasoningWireFormat` value the adapters understand. */
export const PROVIDER_REASONING_WIRE_FORMATS: readonly NonNullable<OcxProviderConfig["reasoningWireFormat"]>[] = [
  "gateway-object",
];

/**
 * Request ownership, sampled before `enrichProviderFromCatalog`. After enrichment "the client
 * omitted this" and "the registry supplied it" look the same.
 */
export interface ProviderOverwriteSample {
  readonly submitted: ReadonlySet<ProviderCompatCarryField>;
  readonly namesAuthMode: boolean;
}

export function sampleProviderOverwrite(provider: object): ProviderOverwriteSample {
  return {
    submitted: new Set(PROVIDER_COMPAT_CARRY_FIELDS.filter(field => Object.hasOwn(provider, field))),
    namesAuthMode: Object.hasOwn(provider, "authMode"),
  };
}

function normalizedDestinationUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/**
 * Whether an overwrite keeps the provider on the same upstream: same adapter, same base URL
 * (scheme and host compared case-insensitively, trailing slashes ignored) and, when the request
 * names one, the same auth mode. The dashboard form sends `authMode` only for key and forward
 * auth, so an omitted value is not evidence of a move; a stored row without `authMode` is a
 * key-auth row.
 */
export function providerOverwriteKeepsDestination(
  candidate: Pick<OcxProviderConfig, "adapter" | "baseUrl" | "authMode">,
  stored: Pick<OcxProviderConfig, "adapter" | "baseUrl" | "authMode"> | undefined,
  sample: ProviderOverwriteSample,
): boolean {
  if (!stored) return false;
  if ((candidate.adapter ?? "").trim() !== (stored.adapter ?? "").trim()) return false;
  if (normalizedDestinationUrl(candidate.baseUrl) !== normalizedDestinationUrl(stored.baseUrl)) return false;
  if (sample.namesAuthMode && (candidate.authMode ?? "key") !== (stored.authMode ?? "key")) return false;
  return true;
}

/**
 * Carry the stored compatibility settings the request omitted. `live` must be the row read after
 * the route's DNS await, so a PATCH that saved one of them during the wait is kept.
 */
export function carryProviderCompatFields(
  candidate: OcxProviderConfig,
  live: OcxProviderConfig | undefined,
  sample: ProviderOverwriteSample,
): void {
  if (!live || !providerOverwriteKeepsDestination(candidate, live, sample)) return;
  const target = candidate as unknown as Record<string, unknown>;
  for (const field of PROVIDER_COMPAT_CARRY_FIELDS) {
    if (sample.submitted.has(field)) continue;
    const stored = live[field];
    if (stored === undefined) continue;
    target[field] = Array.isArray(stored) ? [...stored] : stored;
  }
}

const REASONING_LIST_FIELDS = ["preserveReasoningContentModels", "requiresReasoningPlaceholderModels"] as const;

/**
 * Type checks for a POST that does send one of the settings. `omitReasoningEffortWithToolsModels`
 * is already checked by `providerManagementConfigError`.
 */
export function providerCompatFieldConfigError(provider: Record<string, unknown>): string | null {
  for (const field of REASONING_LIST_FIELDS) {
    const error = nonBlankStringArrayConfigError(provider[field], field);
    if (error) return error;
  }
  const fold = provider.foldDeveloperRoleToSystem;
  if (fold !== undefined && typeof fold !== "boolean") return "foldDeveloperRoleToSystem must be a boolean";
  const wire = provider.reasoningWireFormat;
  if (wire !== undefined && !PROVIDER_REASONING_WIRE_FORMATS.includes(wire as never)) {
    return `reasoningWireFormat must be one of: ${PROVIDER_REASONING_WIRE_FORMATS.join(", ")}`;
  }
  return null;
}

/**
 * PATCH branches for the settings the field mask did not know. `null` clears a field. For the two
 * reasoning lists an empty array is kept rather than deleted: it is the explicit opt-out that stops
 * the registry seed from filling the field back in (see the note under OAUTH_RECONCILE_FIELDS in
 * src/oauth/index.ts).
 */
export function applyProviderCompatPatchFields(
  rawBody: Record<string, unknown>,
  next: OcxProviderConfig,
): { touched: boolean } | { error: string } {
  let touched = false;
  for (const field of REASONING_LIST_FIELDS) {
    if (!Object.hasOwn(rawBody, field)) continue;
    const value = rawBody[field];
    if (value === null) {
      delete next[field];
    } else {
      const error = nonBlankStringArrayConfigError(value, field);
      if (error) return { error };
      next[field] = normalizeNonBlankStringArray(value as string[]);
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "foldDeveloperRoleToSystem")) {
    const value = rawBody.foldDeveloperRoleToSystem;
    if (value === null) delete next.foldDeveloperRoleToSystem;
    else if (typeof value === "boolean") next.foldDeveloperRoleToSystem = value;
    else return { error: "foldDeveloperRoleToSystem must be a boolean" };
    touched = true;
  }
  if (Object.hasOwn(rawBody, "reasoningWireFormat")) {
    const value = rawBody.reasoningWireFormat;
    if (value === null) {
      delete next.reasoningWireFormat;
    } else {
      const format = PROVIDER_REASONING_WIRE_FORMATS.find(candidate => candidate === value);
      if (!format) return { error: `reasoningWireFormat must be one of: ${PROVIDER_REASONING_WIRE_FORMATS.join(", ")}` };
      next.reasoningWireFormat = format;
    }
    touched = true;
  }
  return { touched };
}
