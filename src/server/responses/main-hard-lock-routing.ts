import type { OcxConfig } from "../../types";
import { resolveComboId } from "../../combos";
import { isBareOpenAiFamilyModel, previewRouteModel, routeConcreteModel } from "../../router";
import { resolveChosenTarget } from "./shadow-target-availability";
import { getRoutingProfile, resolvePolicyProfileId, type NormalizedRoutingProfile } from "../../routing/profile";
import { NATIVE_RESERVE_MODEL } from "../../codex/catalog/native-models";
import {
  getMainAccountHardLockStatus,
  resolveMainAccountHardLockFallback,
} from "../../codex/main-account-hard-lock";
import { codexQuotaScopeForModel } from "../../codex/routing/health-store";
import { getEligiblePoolAccounts } from "../../codex/routing/selection";
import { OPENAI_CODEX_PROVIDER_ID, isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { providerCodexAccountMode } from "../../providers/registry";
import { FallbackRefusedError, guardFallbackHop, type FallbackAdmission, type FallbackTarget } from "../../routing/fallback-policy";
/** Resolves to a synchronous ownership proof, or null when the caller does not own the locked main. */
export type MainHardLockCallerCheck = (sourceModel: string) => Promise<(() => boolean) | null>;

function isConfiguredComboSelector(config: OcxConfig, modelId: string): boolean {
  const comboId = resolveComboId(config, modelId);
  return Boolean(comboId && Object.hasOwn(config.combos ?? {}, comboId));
}

function targetsBlockedCanonicalOpenAi(config: OcxConfig, modelId: string): boolean {
  if (isBareOpenAiFamilyModel(modelId) && !isConfiguredComboSelector(config, modelId)) return true;
  const slash = modelId.indexOf("/");
  if (slash <= 0) return false;
  const providerName = modelId.slice(0, slash);
  const rest = modelId.slice(slash + 1);
  if (providerName !== OPENAI_CODEX_PROVIDER_ID || !isBareOpenAiFamilyModel(rest)) return false;
  const provider = config.providers?.[OPENAI_CODEX_PROVIDER_ID];
  return !provider || isCanonicalOpenAiForwardProvider({
    ...provider,
    ...(provider.authMode === undefined ? { authMode: "forward" as const } : {}),
  });
}

/**
 * What one rewritten request carries so the log can show the model the client asked for
 * while the pipeline routes the fallback. The rewrite happens before combo dispatch reads
 * `model`, so the rest of the pipeline sees an ordinary request for the target selector.
 */
export interface MainHardLockFallbackOverride {
  sourceModel: string;
  targetModel: string;
}

function rawModelOf(body: unknown): { raw: Record<string, unknown>; model: string } | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const raw = body as Record<string, unknown>;
  return typeof raw.model === "string" && raw.model.trim().length > 0
    ? { raw, model: raw.model }
    : undefined;
}

/**
 * Extended main-account hard-lock settings: when the lock blocks and no Codex account can
 * serve the request, rewrite it to the configured fallback model instead of letting the
 * dispatch refuse.
 *
 * Every guard bounds the rewrite to exactly the traffic the lock would otherwise fail, so
 * the setting can never widen what the lock protects:
 *
 * - The lock must be enabled AND reading `blocked` right now — `ready`, `unknown` and the
 *   explicit opt-out all admit, and the release is this same observation, so the reroute
 *   ends on its own the moment the blocking windows drop below their thresholds.
 * - `getEligiblePoolAccounts` is the selection choke point the dispatch itself consults,
 *   so "the pool can serve it" is one shared answer, not a second opinion: a usable pool
 *   account (or any eligible account) keeps the request on Codex, and a pool drained to
 *   empty is what makes the fallback the request's only way through. The main account is
 *   already excluded there while blocked.
 * - Only bare Codex-native selectors qualify. Provider-qualified rows, combos, account
 *   namespaces and policy routes name their own destination on purpose; rewriting those
 *   would override an explicit choice, so they keep the lock's refusal.
 * - A Codex-native fallback target is refused outright: rerouting gpt-* to gpt-* would
 *   re-enter the same refusal, and the honest behavior is the refusal, not a loop.
 * - Luna Reserve keeps its own admission policy (`assertReserveAdmission`); its helper
 *   traffic is not operator chat and must not silently change models.
 */
export async function applyMainHardLockFallbackOverride(
  body: unknown,
  config: OcxConfig,
  now?: number,
  callerCheck?: MainHardLockCallerCheck,
  admission?: FallbackAdmission,
): Promise<MainHardLockFallbackOverride | null> {
  const parsed = rawModelOf(body);
  if (!parsed) return null;
  const fallback = resolveMainAccountHardLockFallback(config);
  if (!fallback) return null;
  if (targetsBlockedCanonicalOpenAi(config, fallback.model)) return null;
  if (!isBareOpenAiFamilyModel(parsed.model)
    || parsed.model === NATIVE_RESERVE_MODEL
    || isConfiguredComboSelector(config, parsed.model)) return null;
  const accountMode = providerCodexAccountMode(
    OPENAI_CODEX_PROVIDER_ID,
    config.providers?.[OPENAI_CODEX_PROVIDER_ID],
  );
  if (accountMode === "direct") {
    // Direct may forward a different caller's healthy credential. Only stored-main substitution
    // or an observed-main match owes this lock. Recheck usage after the startup binding wait.
    const stillOwnsLockedMain = callerCheck ? await callerCheck(parsed.model) : null;
    // Everything from here to the rewrite is synchronous, so this proof cannot go stale before it.
    if (!stillOwnsLockedMain?.()) return null;
    if (getMainAccountHardLockStatus(config, now ?? Date.now()).state !== "blocked") return null;
  } else {
    if (getMainAccountHardLockStatus(config, now ?? Date.now()).state !== "blocked") return null;
    if (getEligiblePoolAccounts(config, undefined, now ?? Date.now(), codexQuotaScopeForModel(parsed.model)).length > 0) return null;
  }

  // Combos and policies keep their own dispatch admission and declared failover/evidence.
  // Other chosen targets must resolve now; a removed qualifier cannot become a default send.
  const policyId = resolvePolicyProfileId(config, fallback.model);
  if (!isConfiguredComboSelector(config, fallback.model)
    && !(policyId && getRoutingProfile(config, policyId))) {
    try {
      const target = resolveChosenTarget(fallback.model, model => previewRouteModel(config, model));
      if ("unavailable" in target) return null;
    } catch {
      // An unavailable target keeps the source lock's refusal without touching the body.
      return null;
    }
  }

  // OCX-11: the reroute is a proactive model hop; refused, the request is answered with the
  // fallback refusal and the body is left untouched.
  const hop = guardFallbackHop(config, {
    site: "hard-lock",
    route: parsed.model,
    from: { provider: OPENAI_CODEX_PROVIDER_ID, model: parsed.model },
    to: hardLockTargetOf(config, parsed.model, fallback.model),
    trigger: "hard_lock",
    admission,
    ...(now !== undefined ? { now } : {}),
  });
  if (!hop.ok) throw new FallbackRefusedError(hop.response);
  // The rewrite is this site's admission: the body now names the fallback model.
  hop.commit();

  parsed.raw.model = fallback.model;
  if (fallback.reasoningEffort !== undefined) {
    const reasoning = parsed.raw.reasoning;
    parsed.raw.reasoning = {
      ...(reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)
        ? reasoning as Record<string, unknown>
        : {}),
      effort: fallback.reasoningEffort,
    };
  }
  return { sourceModel: parsed.model, targetModel: fallback.model };
}

/**
 * The hop's destination for the fallback policy, read from config only. A routing profile picks
 * its candidate from request-history evidence, and evaluating it here would open that index under
 * OPENCODEX_HOME just to classify the hop (on Windows the open handle then outlives the request's
 * home); the profile's own dispatch still evaluates it. Its declared candidates are classified
 * instead, as the hop the profile could take: a candidate on another provider makes it a provider
 * hop. Combos, account namespaces and concrete targets resolve from config alone.
 */
function hardLockTargetOf(config: OcxConfig, sourceModel: string, model: string): FallbackTarget {
  const policyId = resolvePolicyProfileId(config, model);
  const profile = policyId ? getRoutingProfile(config, policyId) : undefined;
  if (profile) return profileHopTarget(config, sourceModel, profile);
  try {
    const route = previewRouteModel(config, model);
    return { provider: route.providerName, model: route.modelId };
  } catch {
    const slash = model.indexOf("/");
    return slash > 0 ? { provider: model.slice(0, slash), model: model.slice(slash + 1) } : { provider: "", model };
  }
}

function profileHopTarget(config: OcxConfig, sourceModel: string, profile: NormalizedRoutingProfile): FallbackTarget {
  const targets = profile.candidates.map((candidate): FallbackTarget => {
    try {
      const route = routeConcreteModel(config, candidate.provider + "/" + candidate.model);
      return { provider: route.providerName, model: route.modelId };
    } catch {
      return { provider: candidate.provider, model: candidate.model };
    }
  });
  return targets.find(target => target.provider !== OPENAI_CODEX_PROVIDER_ID)
    ?? targets.find(target => target.model !== sourceModel)
    ?? { provider: OPENAI_CODEX_PROVIDER_ID, model: sourceModel };
}
