/**
 * The one registry that turns a routing code into a plain sentence fragment.
 *
 * Three vocabularies reach this tab and none of them is closed: exclusion codes from the routing
 * trace (`skip`), `errorCode` values from provider attempts (`fail`), and `selected.reason` from
 * the router (`why`). A code the registry does not list is returned as `undefined` so the caller
 * shows the raw text in `<code>`, never a blank and never a guess.
 */
import type { TKey } from "../../i18n/shared";

export type ReasonKind = "skip" | "fail" | "why";

export const ROUTE_REASONS: Record<ReasonKind, Readonly<Record<string, TKey>>> = {
  skip: {
    cooldown: "routeLive.rCooldown",
    disabled: "routeLive.rDisabled",
    "not-selected": "routeLive.rNotSelected",
    paused: "routeLive.rPaused",
    "needs-reauth": "routeLive.rNeedsReauth",
    "quota-exhausted": "routeLive.rQuotaExhausted",
    "model-unlisted": "routeLive.rModelUnlisted",
    unconfigured: "routeLive.rUnconfigured",
    "already-attempted": "routeLive.rAlreadyAttempted",
    "capability-unsatisfied": "routeLive.rCapability",
    "cost-limit": "routeLive.rCostLimit",
    "route-unavailable": "routeLive.rRouteUnavailable",
  },
  fail: {
    rate_limit_exceeded: "routeLive.fRate",
    insufficient_quota: "routeLive.fQuota",
    usage_limit_reached: "routeLive.fQuota",
    invalid_api_key: "routeLive.fAuth",
    authentication_error: "routeLive.fAuth",
    permission_denied: "routeLive.fPermission",
    model_not_found: "routeLive.fModelMissing",
    context_length_exceeded: "routeLive.fContext",
    upstream_server_error: "routeLive.fServer",
    upstream_error: "routeLive.fServer",
    upstream_unavailable: "routeLive.fServer",
    upstream_timeout: "routeLive.fTimeout",
    server_is_overloaded: "routeLive.fOverloaded",
    client_cancelled: "routeLive.fCancelled",
    client_closed_request: "routeLive.fCancelled",
  },
  why: {
    "combo-pick": "routeLive.whyComboPick",
    "policy-selected": "routeLive.whyPolicySelected",
    "no-eligible-candidate": "routeLive.whyNoEligible",
    "blocked-model-redirect": "routeLive.whyBlockedRedirect",
    "combo-tool-loop-pin": "routeLive.whyComboToolLoopPin",
    "jev-session-pin": "routeLive.whyJevSessionPin",
    "explicit-provider": "routeLive.whyExplicitProvider",
    "default-provider": "routeLive.whyDefaultProvider",
  },
};

export function reasonKey(kind: ReasonKind, code: string): TKey | undefined {
  return Object.hasOwn(ROUTE_REASONS[kind], code) ? ROUTE_REASONS[kind][code] : undefined;
}
