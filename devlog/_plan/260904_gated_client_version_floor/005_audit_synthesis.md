# 005 — Audit synthesis (round 1: FAIL)

An adversarial plan auditor returned FAIL with six blockers. Four are accepted and change the
plan; two are corrected. Each was checked against the tree before acceptance.

## Accepted 1 — tier 2 is not background-only, and the plan must say what it is

The draft justified the clamp as "background discovery only". That is false.
`isDirectCallerEntitledToCodexModel` (~line 997) and both authorization paths in
`src/codex/auth-context.ts` (caller-owned Direct at ~408, stored-main substitution at ~435)
reach tier 2 as well, because they are inbound requests that simply do not carry a
`client_version`. So the clamp does change request-path authorization.

It should. The distinction that matters is not background-vs-inbound, it is **which question
is being asked**:

- *Does this ACCOUNT own gpt-5.6?* is a property of the account. Upstream merely happens to
  filter its answer by `client_version`, so asking under a stale version returns a wrong
  answer to a question the version has no bearing on.
- *Can THIS CLIENT drive gpt-5.6?* is a property of the client, and only an inbound
  `client_version` can answer it.

A caller that supplies no version is asking the first question. Flooring it is therefore
correct on every one of those paths, not a side effect to be tolerated. The plan now states
this as the policy rather than mis-describing the call sites.

## Accepted 2 — WP3 promised something the fix does not deliver

The draft claimed `/v1/models?client_version=0.141.0` would list the 5.6 rows. It will not,
and it should not. Tier 1 returns the inbound version verbatim and short-circuits before
tier 2 (~line 190). A client that declares itself 0.141.0 is answered as 0.141.0.

That is deliberate, and flooring tier 1 was considered and rejected:

- It would advertise rows to a client that told us it cannot drive them (#2548).
- It would break the existing recorded contract in
  `"an omitted gated slug below its minimum is unknown and uses the failure TTL"`, which
  supplies `0.140.0` as inbound and requires `unknown`, not `denied`. Flooring tier 1 would
  record `0.144.0` on the cache entry and flip that to `denied` on the 5-minute TTL.

So the honest scope is: every path that does not carry an inbound version is fixed. A stale
client that announces its own version keeps being answered for that version, and the real
remedy there is upgrading the CLI. WP3's acceptance list is corrected accordingly.

## Accepted 3 — the regression list mislabelled controls as regressions

Only cases 1 and 2 are RED-before-fix. Cases 3-6 are invariant controls that pass both
before and after; the memo-purity case is outright vacuous against this defect because
`memoizeRuntimeVersionForTests` returns `memoizedPersistedRuntimeVersion` directly and never
passes through the resolver. Relabelled: 1-2 regressions with a mutation proof, 3-5 controls,
6 dropped as vacuous. A control that cannot fail is not evidence, and calling it one inflates
the apparent coverage of the change.

## Accepted 4 — cache identity changes and the plan did not say so

The resolved version is part of `cacheKeyFor` (~line 394) and of the in-flight coalescing key
(~line 632), and distinct versions are capped at four per account. After the clamp, an inbound
`0.141.0` request and an unversioned caller occupy two different entries and no longer
coalesce. That is required for correctness — they are different questions — but it is a real
consequence and now has a test.

## Corrected 5 — the effort-clamp wording overstated the evidence

The auditor is right that `codex debug models --bundled` proves the 0.141.0 bundled catalog
does not *advertise* `max`/`ultra`, not that the binary cannot parse them. Wording in
`000_research.md` softened to what was measured. The decision is unchanged and conservative:
keep the clamp. Shipping a model whose advertised ladder the local runtime does not list is
the #2548 failure mode, and removing the clamp to make a row look complete would trade a
visible gap for a failing request.

## Corrected 6 — dashboard first-poll degradation is pre-existing

`model-rows.ts` waits ~3s while an entitlement fetch may take up to 8s, so a cold first poll
can return without the rows. True, and unchanged by this work — it is a property of the
freshness wait, not of the version floor. Recorded here so it is not rediscovered as a
regression; WP3 asserts eventual visibility on a warm read rather than pretending the first
cold poll is deterministic.
