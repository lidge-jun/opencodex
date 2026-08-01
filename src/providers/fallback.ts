/**
 * Per-provider fallback for plain (non-combo) requests.
 *
 * A combo already expresses "try these provider/model targets in order", including
 * per-target cooldowns and a hop/stop classification of upstream failures. That engine
 * only runs for models the client explicitly addresses as `combo/<id>`, so a plain
 * request that resolves to a single provider has no second chance: a 429 or a stream
 * that dies without a terminal event (`upstream_server_error`) goes straight back to
 * the caller.
 *
 * This module closes that gap without a second retry mechanism. A provider's `fallback`
 * list is turned into a synthetic combo whose first target is the request's own route,
 * so the normal combo hop loop drives the retry.
 *
 * The synthetic combo id embeds NUL, which `COMBO_ID_PATTERN` rejects. A configured
 * combo can therefore never collide with it, and no client-supplied model string can
 * resolve to it (`resolveComboId` matches only `combo/<id>` or an explicit alias).
 */
import { COMBO_NAMESPACE, targetKey } from "../combos/types";
import type { OcxComboConfig, OcxComboTarget, OcxConfig, OcxProviderConfig } from "../types";

export interface ProviderFallbackIssue {
  path: Array<string | number>;
  message: string;
}

export interface ProviderFallbackPlan {
  comboId: string;
  /** `config` with the synthetic combo injected; safe to pass to the combo hop loop. */
  config: OcxConfig;
}

function syntheticComboId(provider: string, model: string): string {
  return `provider-fallback\u0000${provider}\u0000${model}`;
}

/** True when `id` came from `syntheticComboId` rather than the user's combos map. */
export function isProviderFallbackComboId(id: string): boolean {
  return id.startsWith("provider-fallback\u0000");
}

/** Human-readable form of a combo id for logs and error messages (NUL is not printable). */
export function comboIdLabel(id: string): string {
  if (!isProviderFallbackComboId(id)) return id;
  const [, provider, model] = id.split("\u0000");
  return `fallback:${provider}/${model}`;
}

/**
 * Configured fallback targets for one provider, trimmed and with malformed entries dropped.
 * Validation reports those entries separately; routing must not fail on them.
 */
export function providerFallbackTargets(
  provider: OcxProviderConfig | undefined,
): OcxComboTarget[] {
  if (!Array.isArray(provider?.fallback)) return [];
  const targets: OcxComboTarget[] = [];
  for (const raw of provider.fallback) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const name = typeof raw.provider === "string" ? raw.provider.trim() : "";
    const model = typeof raw.model === "string" ? raw.model.trim() : "";
    if (!name || !model) continue;
    targets.push({ provider: name, model });
  }
  return targets;
}

export function providerFallbackIssues(
  providerName: string,
  raw: unknown,
  providers: Record<string, OcxProviderConfig>,
): ProviderFallbackIssue[] {
  const issues: ProviderFallbackIssue[] = [];
  if (raw === undefined || raw === null) return issues;
  if (!Array.isArray(raw)) {
    issues.push({ path: ["fallback"], message: "fallback must be an array of { provider, model } targets" });
    return issues;
  }

  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push({ path: ["fallback", i], message: `fallback[${i}] must be an object` });
      continue;
    }
    const target = entry as Record<string, unknown>;
    const name = typeof target.provider === "string" ? target.provider.trim() : "";
    const model = typeof target.model === "string" ? target.model.trim() : "";

    if (!name) {
      issues.push({ path: ["fallback", i, "provider"], message: `fallback[${i}].provider is required` });
    } else if (!Object.hasOwn(providers, name)) {
      issues.push({
        path: ["fallback", i, "provider"],
        message: `fallback[${i}].provider "${name}" is not configured`,
      });
    }
    if (!model) {
      issues.push({ path: ["fallback", i, "model"], message: `fallback[${i}].model is required` });
    }
    if (!name || !model) continue;

    // Self-reference would retry the target that just failed, burning a full attempt on a
    // provider the hop loop has already put in cooldown.
    if (name === providerName) {
      issues.push({
        path: ["fallback", i],
        message: `fallback[${i}] must not point back at "${providerName}"`,
      });
    }
    const key = targetKey({ provider: name, model });
    if (seen.has(key)) {
      issues.push({ path: ["fallback", i], message: `duplicate fallback target "${key}"` });
    } else {
      seen.add(key);
    }
  }
  return issues;
}

export function providerFallbackError(
  providerName: string,
  raw: unknown,
  providers: Record<string, OcxProviderConfig>,
): string | null {
  return providerFallbackIssues(providerName, raw, providers)[0]?.message ?? null;
}

/**
 * Build the synthetic combo for a request that routed to `provider`/`model`, or null when the
 * provider has no usable fallback and the request should take the normal single-target path.
 */
export function providerFallbackPlan(
  config: OcxConfig,
  route: { provider: string; modelId: string },
): ProviderFallbackPlan | null {
  // A physical provider literally named "combo" is only kept addressable while no combos
  // exist (preservesPhysicalComboProvider). Injecting one here would silently shadow it.
  if (Object.hasOwn(config.providers, COMBO_NAMESPACE)) return null;

  const configured = providerFallbackTargets(config.providers[route.provider]);
  if (configured.length === 0) return null;

  const usable = (target: OcxComboTarget): boolean => {
    const provider = config.providers[target.provider];
    return !!provider && provider.disabled !== true;
  };
  if (!usable({ provider: route.provider, model: route.modelId })) return null;

  const targets: OcxComboTarget[] = [{ provider: route.provider, model: route.modelId }];
  const seen = new Set<string>([targetKey(targets[0]!)]);
  for (const target of configured) {
    const key = targetKey(target);
    if (seen.has(key) || !usable(target)) continue;
    seen.add(key);
    targets.push(target);
  }
  if (targets.length < 2) return null;

  const comboId = syntheticComboId(route.provider, route.modelId);
  const combo: OcxComboConfig = { targets, strategy: "failover" };
  return {
    comboId,
    config: { ...config, combos: { ...config.combos, [comboId]: combo } },
  };
}
