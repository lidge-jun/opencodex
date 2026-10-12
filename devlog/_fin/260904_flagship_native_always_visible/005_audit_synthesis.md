# 005 — Audit synthesis (round 1: FAIL)

An adversarial auditor returned FAIL with four blockers. Three are accepted outright; one is
accepted with a correction to the auditor's own framing. Every claim was re-checked in-tree.

## Accepted 1 — the reason given for keeping the minimums map was false

`000_research.md` justified keeping the three entries in
`ACCOUNT_GATED_NATIVE_MODEL_MINIMUM_CLIENT_VERSIONS` by claiming that emptying it would
reintroduce #3022 "against Daybreak". That is wrong. The map has only ever held the trio, and
`gpt-daybreak-blue-latest` is deliberately absent — the comment at its definition says so, and a
test pins `has(DAYBREAK) === false`. Daybreak was never protected by that map and cannot be.

Writing that into a code comment would have been worse than leaving it out: it would have become
the load-bearing explanation for the next maintainer, and it is false.

The honest reason to keep the entries is narrower. `hasUnknownGatedAbsence` fires only when the
asking `client_version` is below the recorded minimum, and after #3442 every version-less
resolution is clamped to the floor, which equals that minimum. So the guard is reachable only
through tier 1 — a client that self-declares an older version. For that client the entries keep
the under-versioned escape hatch alive, which is why they stay.

The residual cost, which the plan never named: such a client drops the whole account roster to
the 15-second failure TTL instead of the 5-minute success TTL, a 20x refetch amplification,
bounded to four concurrent flights per account. After ungating, that amplification buys nothing
for the trio, because their absence no longer affects any projection. It is small, bounded, and
only reachable from a self-declared old client, so it is accepted and recorded rather than
engineered away.

## Accepted 2 — a real subagent hazard the plan missed

`subagent-model-fallback.ts` gates `preserveDrainingMainCandidate` on membership in the gated
set. During a native-main drain with no non-main candidate, main is currently retained as a
read-free sentinel so final auth returns a maintenance error and the atomic claim is respected.
Ungated, that predicate goes false, control reaches `return true`, the model reads as
unavailable, and the fallback chain rewrites to the next model.

That is the operator's configured subagent model being silently swapped mid-drain — exactly the
failure mode `AGENTS.md` warns about for this chain. It is not "one 400"; it is a different model
answering than the operator chose.

**Decision: preserve the sentinel on a predicate that is not the gated set.** The drain fence
exists to stop a routed fallback from bypassing the atomic main claim, and that reasoning has
nothing to do with entitlement. The condition becomes membership in the native OpenAI set, which
is what it always meant. A regression covers it.

## Accepted 3 — two more readers now listed

`subagentFallbackNeedsModelEntitlements` returns false for a trio-only chain, so the dispatch
skips entitlement resolution entirely. And the `accountGatedModel` affinity diagnostic silently
reclassifies the trio — telemetry only, but a recorded semantic change. Both are added to the
mechanism section.

## Accepted 4 — test list extended, and the "visible refusal" claim narrowed

Two suites added: `codex-convergence-account-selectors.test.ts` (`expectCanonicalContent` now
*requires* the trio in a rosterless fixture, inverting what it was built to prove) and
`subagent-roster-retention.test.ts`.

The auditor is right that "a visible refusal beats a silent disappearance" was stated too
broadly. `gpt-5.6-luna` is the default web-search sidecar model and the shadow-call source
model, so for a single-account user who does not own it, an always-visible row can be selected as
a default and produce recurring upstream errors where the row used to be simply absent.

That is not a reason to reverse the decision — the owner asked for these models to be listed
unconditionally, and the silent-disappearance failure is what prompted it. Two of this session's
own subagent dispatches died on `401 No eligible Codex account supports this model`. But the
claim in `000` is narrowed to what is actually true: a visible refusal beats a silent
disappearance *for a user who owns the model and was denied it by missing evidence*, which is the
case this change exists to fix. The default-model consequence is recorded rather than glossed.

## Verified sound

Wire normalization is untouched, the floor arithmetic reproduces exactly
(`derived AFTER = null`, `composed AFTER = 0.144.0`), and no catalog validation, sync or desktop
projection rejects an entitlement-unconfirmed slug, so there is no startup or convergence failure
path.
