import { nonBlankStringArrayConfigError, normalizeNonBlankStringArray } from "../../config/provider-validation";
import {
  retryOn429PolicyConfigError,
  retryOnResetPolicyConfigError,
  transientRetryOn5xxPolicyConfigError,
} from "../../config/load-degrade";
import type { OcxProviderConfig } from "../../types";

/**
 * The retry policies. They are the one carried group the PATCH field mask did not know, and they
 * are `"editor"` fields, so before this a save that dropped one left no API path to put it back.
 * Each validator is the same strict check the loader's schema applies, so the mask cannot store a
 * block that a later load would reject.
 */
const RETRY_POLICY_FIELDS = ["retryOn429", "transientRetryOn5xx", "retryOnReset"] as const satisfies
  readonly (keyof OcxProviderConfig)[];

const RETRY_POLICY_VALIDATORS = {
  retryOn429: retryOn429PolicyConfigError,
  transientRetryOn5xx: transientRetryOn5xxPolicyConfigError,
  retryOnReset: retryOnResetPolicyConfigError,
} as const satisfies Record<typeof RETRY_POLICY_FIELDS[number], (policy: unknown) => string | null>;

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
 * `hideRawReasoning` is an operator display policy, so every overwrite of the same provider name
 * carries it when omitted, even when the destination changes. The compatibility settings below
 * record how one upstream behaves. An overwrite that keeps the destination
 * carries each one the request omits, including an explicit `[]` or `false`. An overwrite that
 * moves the provider to another destination carries none of them: they describe the previous
 * upstream, and registry enrichment already fills what is known about the new one. The same
 * destination rule gates the stored `apiKeyPool`, whose keys were issued for the previous
 * destination. A value the request sends always wins, and the rest of the old row is never merged
 * into the candidate.
 *
 * The three retry policies join them on the same terms, and for a sharper reason: they are
 * `"editor"` fields that had no branch in the PATCH field mask, so a save that dropped one left no
 * API path to put it back. The mask branch below restores that path, and validates each policy
 * against the loader's own schema — PATCH never runs the schema, and a malformed block would not
 * degrade to "absent": the load would fail and the default config would take the whole provider
 * table.
 */
export const PROVIDER_COMPAT_CARRY_FIELDS = [
  "preserveReasoningContentModels",
  "requiresReasoningPlaceholderModels",
  "foldDeveloperRoleToSystem",
  "reasoningWireFormat",
  "omitReasoningEffortWithToolsModels",
  ...RETRY_POLICY_FIELDS,
] as const satisfies readonly (keyof OcxProviderConfig)[];

export const PROVIDER_DISPLAY_CARRY_FIELDS = ["hideRawReasoning"] as const satisfies readonly (keyof OcxProviderConfig)[];

export type ProviderCompatCarryField = typeof PROVIDER_COMPAT_CARRY_FIELDS[number];
type ProviderDisplayCarryField = typeof PROVIDER_DISPLAY_CARRY_FIELDS[number];

/** The only `reasoningWireFormat` value the adapters understand. */
export const PROVIDER_REASONING_WIRE_FORMATS: readonly NonNullable<OcxProviderConfig["reasoningWireFormat"]>[] = [
  "gateway-object",
];

/**
 * Request ownership, sampled before `enrichProviderFromCatalog`. After enrichment "the client
 * omitted this" and "the registry supplied it" look the same.
 */
export interface ProviderOverwriteSample {
  readonly submitted: ReadonlySet<ProviderCompatCarryField | ProviderDisplayCarryField>;
  readonly namesAuthMode: boolean;
}

export function sampleProviderOverwrite(provider: object): ProviderOverwriteSample {
  return {
    submitted: new Set([...PROVIDER_COMPAT_CARRY_FIELDS, ...PROVIDER_DISPLAY_CARRY_FIELDS].filter(field => Object.hasOwn(provider, field))),
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
 * Carry the stored display policy on every overwrite, then the omitted compatibility settings
 * only when the destination is unchanged. `live` must be the row read after
 * the route's DNS await, so a PATCH that saved one of them during the wait is kept.
 */
export function carryProviderCompatFields(
  candidate: OcxProviderConfig,
  live: OcxProviderConfig | undefined,
  sample: ProviderOverwriteSample,
): void {
  if (!live) return;
  const target = candidate as unknown as Record<string, unknown>;
  for (const field of PROVIDER_DISPLAY_CARRY_FIELDS) {
    if (sample.submitted.has(field)) continue;
    const stored = live[field];
    if (stored !== undefined) target[field] = stored;
  }
  if (!providerOverwriteKeepsDestination(candidate, live, sample)) return;
  for (const field of PROVIDER_COMPAT_CARRY_FIELDS) {
    if (sample.submitted.has(field)) continue;
    const stored = live[field];
    if (stored === undefined) continue;
    // Arrays and the retry-policy objects are copied rather than aliased, like `requestPacing`
    // in the route: a later edit of one row must not reach the other through a shared value.
    target[field] = Array.isArray(stored)
      ? [...stored]
      : stored !== null && typeof stored === "object"
        ? structuredClone(stored)
        : stored;
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
  const hideRawReasoning = provider.hideRawReasoning;
  if (hideRawReasoning !== undefined && typeof hideRawReasoning !== "boolean") return "hideRawReasoning must be a boolean";
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
  if (Object.hasOwn(rawBody, "hideRawReasoning")) {
    const value = rawBody.hideRawReasoning;
    if (value === null) delete next.hideRawReasoning;
    else if (typeof value === "boolean") next.hideRawReasoning = value;
    else return { error: "hideRawReasoning must be a boolean" };
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
  // The retry policies. They are validated here, like `requestPacing` and `upstreamHttpVersion`,
  // because PATCH does not run the config schema: only POST does, through
  // `validateConfigCandidate`. A malformed block that reached disk would fail the load and take
  // the whole provider table to the default config with it, so the mask refuses it rather than
  // storing something the loader will reject. `null` leaves the row entirely: the schema reads an
  // absent block as "off", so deleting the key is what disables one, not storing `{enabled:false}`.
  for (const field of RETRY_POLICY_FIELDS) {
    if (!Object.hasOwn(rawBody, field)) continue;
    const value = rawBody[field];
    if (value === null) {
      delete next[field];
    } else {
      const error = RETRY_POLICY_VALIDATORS[field](value);
      if (error) return { error };
      next[field] = structuredClone(value) as OcxProviderConfig[typeof field];
    }
    touched = true;
  }
  return { touched };
}
