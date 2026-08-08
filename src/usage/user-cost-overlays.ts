/**
 * Runtime registry for user-configured provider cost overlays
 * (`providers.<name>.modelCosts` in config.json — per-model prices in ocx's
 * flat `modelXxx` convention, mirroring opencode's per-model pricing).
 *
 * The usage cost estimator stays pure: it receives overlays as parameters and
 * defaults to this registry, which is refreshed at the config chokepoints
 * (loadConfig and every persist path). A refresh that actually changes the
 * rows replaces the active array with a NEW identity and bumps a version
 * counter, so the estimator's memo and the /api/usage summary cache skip stale
 * rows without cross-module invalidation. Refreshes with byte-identical rows
 * are no-ops: config is reloaded at many chokepoints and an unchanged reload
 * must not churn the version (see refreshUserCostOverlays). The configured
 * provider-name set is part of the change identity: adding or removing a
 * provider changes which names may collapse to a label base in the resolver,
 * so it bumps the version even when no overlay row changed.
 *
 * Display-time estimation only — these rows never affect billing.
 */
import type { OcxConfig, ProviderCostOverlay } from "../types";
import { MAX_COST4_RATE, type ExpectedPriceOverlay } from "./expected-prices";
import { redactSecretString } from "../lib/redact";

const EMPTY: readonly ExpectedPriceOverlay[] = [];

let active: readonly ExpectedPriceOverlay[] = EMPTY;
let activeSignature = "";
let activeConfigured = new Set<string>();
let version = 0;

/** True when `value` is a complete cost entry: all four rates are non-negative finite numbers. */
function validCost4(value: unknown): value is ProviderCostOverlay {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (["input", "output", "cacheRead", "cacheWrite"] as const)
    .every(key => typeof entry[key] === "number"
      && Number.isFinite(entry[key])
      && entry[key] >= 0
      && entry[key] <= MAX_COST4_RATE);
}

/**
 * Rebuild the active user-overlay rows from the current config. Malformed rows
 * are skipped (config validation reports them separately); a provider with no
 * overlay contributes nothing.
 */
export function refreshUserCostOverlays(config: OcxConfig): void {
  const rows: ExpectedPriceOverlay[] = [];
  const providers = config.providers;
  if (providers) {
    for (const [providerName, provider] of Object.entries(providers)) {
      const costs = provider?.modelCosts;
      if (!costs || typeof costs !== "object" || Array.isArray(costs)) continue;
      for (const [modelId, cost4] of Object.entries(costs)) {
        if (!modelId.trim() || !validCost4(cost4)) continue;
        rows.push({
          provider: providerName,
          modelId,
          // Copy ONLY the four validated rate fields: a hand-edited row may
          // carry extra properties (e.g. a misplaced apiKey) that must never
          // reach display estimates or /api/logs through the registry.
          cost4: {
            input: cost4.input,
            output: cost4.output,
            cacheRead: cost4.cacheRead,
            cacheWrite: cost4.cacheWrite,
          },
          // Display provenance only: redact token-shaped provider/model ids so
          // the source string can never echo a pasted key. Matching still uses
          // the raw fields, and the change-detection signature below MUST keep
          // them raw — distinct ids would otherwise collapse to "[REDACTED]"
          // and skip the version bump.
          source: `config:providers.${redactSecretString(providerName)}.modelCosts[${redactSecretString(modelId)}]`,
          verifiedAt: "user-configured",
          status: "verified",
        });
      }
    }
  }
  // Config is re-loaded at many chokepoints (server start, migrations, persist
  // paths). Bumping the version on every load — even when nothing changed —
  // would invalidate the /api/usage summary cache on unrelated reloads and
  // churn the cost memo. Only a real overlay change bumps the version, so the
  // cache survives reloads of an unchanged config.
  // The signature MUST compare the raw matching fields: two different
  // secret-shaped ids would both redact to "[REDACTED]" and falsely look
  // unchanged, skipping the version bump and serving stale estimates. The
  // signature is process-local state and is never serialized to a response;
  // only the display `source` above is redacted.
  // The configured provider-name set is part of the identity too: adding or
  // removing a provider (even one without an overlay) changes which names are
  // allowed to collapse to a label base, so the resolver memo and the
  // /api/usage summary cache must be invalidated on that change as well.
  const configuredNames = Object.keys(providers ?? {}).sort();
  const signature = `${JSON.stringify(configuredNames)}\u0000${JSON.stringify(rows)}`;
  if (signature === activeSignature) return;
  activeSignature = signature;
  active = rows;
  activeConfigured = new Set(configuredNames);
  version++;
}

/** Active user-configured overlay rows (stable identity until the next refresh). */
export function activeUserCostOverlays(): readonly ExpectedPriceOverlay[] {
  return active;
}

/** Monotonic version bumped on every refresh; used by the estimator memo key. */
export function userCostOverlayVersion(): number {
  return version;
}

/** Configured provider names from the last refresh (pricing-namespace identity). */
export function activeConfiguredProviders(): ReadonlySet<string> {
  return activeConfigured;
}
