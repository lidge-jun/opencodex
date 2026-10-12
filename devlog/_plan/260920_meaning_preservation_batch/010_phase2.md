# Phase 2 — the ten consolidation bundles

Status: OPEN. Phase 1 (items 1-6) runs in lanes A and B under [000_plan.md](000_plan.md). This file
opens items 7-16 of the post-2.60.0 assessment. These are **not ten new pull requests**. Each bundle
is a unit of existing issues and pull requests to reuse, with only the shared part reviewed
together.

## Delivery topology is unchanged

One branch, ordered commits, one pull request to `dev` per lane. No native stack, no child pull
request chain. Carried contributor work needs a `Co-authored-by` trailer in a branch commit;
superseded pull requests are closed by the coordinator only after the lane lands.

## Why these groupings and not one bundle per lane

Bundles 7 and 14 both want the same substrate. Item 7 divides a failure into pre-header,
headers-only, protocol prelude, semantic output, side effect and terminal, and decides resend
permission per stage. Item 14 wants a logical request to attempt to physical send to terminal
record with one cause dictionary. Two lanes defining that separately would typecheck on each branch
and contradict each other in the merge — the exact class that blocked 2.60.0. They stay in one lane.

Bundles 8 and 9 are the same question asked twice: an observation attributed to an account or
credential generation must not survive its replacement. A refusal learned from the previous account
and a warm cache binding dropped on a threshold hint are the same attribution defect at different
layers.

Bundle 13 consumes the request-scoped route decision that lane B is building for #5087. Starting it
before lane B lands would fork that authority, so it is scheduled after.

## Lanes

| Lane | Bundles | Existing items to reuse |
| --- | --- | --- |
| C | 7 retry stage table, 14 one event model | #4942, #4989, #5245, #2366, #3748, #3983, #5063; issues #4191, #5180 |
| D | 8 account and credential generation, 9 cache affinity and diagnostics | #5214, #5145, #5229, #5209, #4793; issues #3375, #5178, #3433, #3765 |
| E | 10 Devin output budget, 11 adapter queue memory, 12 per-key permission | #5189, #5182; issues #5190, #5049 |
| F (after B) | 13 per-provider egress, 15 CodeBuddy and native wire | #3901, #5148, #5147, #5188; issues #2894, #5146, #5097, #5096 |
| G (after B) | 16 onboarding, update and screen consolidation | #5016, #4560, #5068; issues #2811, #5215, #5216 |

## Ownership boundaries between concurrent lanes

These exist because the lanes share a checkout-independent surface and would otherwise collide.

- Lane C owns send accounting: `sendCount`, request-wide send budget and the stage and cause
  vocabulary. Lanes D and E consume it and do not redefine it.
- Lane D owns #4793 and every per-model cache view. Lane C derives cache projections from the
  recorder without editing that surface.
- Lane E owns the adapter event queue budget and the Devin and coding-agent limits. It does not
  touch retry classification.
- A collision that cannot be resolved inside these boundaries goes to the coordinator rather than
  being settled unilaterally in one branch.

## Acceptance that is easy to fake and must not be

Each bundle has a completion condition that a passing request does not demonstrate.

- 7: an uncertain resend after output or a side effect is never automatically permitted; 429, quota,
  policy refusal and ciphertext refusal stay distinguishable; the provider's stated reason and the
  actual send count agree, with no duplicated parent and child counter.
- 8: a refusal or capability observation from a replaced account does not transfer; a cancelled
  request's late refresh does not overwrite another request's binding; false, unknown and absent
  stay distinct.
- 9: passing a threshold alone does not drop a warm binding, while real exhaustion does; input
  change, account change and transformation change are distinguishable; a prefix fingerprint never
  becomes a public or durable correlation key.
- 10: with the caller omitting a limit, the configured effective output cap reaches the wire, and an
  explicit small cap survives; the history ceiling keeps its own meaning.
- 11: slow consumers, one large event, accumulated coalescing and a cancel race all stay bounded
  with no unreleased counter, and a normal long stream is not capped by total length.
- 12: an alias, combo child, fallback or compact route cannot reach a forbidden model or provider;
  filtering `/models` is not completion; an inference key never gains management authority.

## Release shape

The first stabilization release carries items 1-6 plus only the small, reproduced fixes from 8, 10
and 11. Items 7, 9, 12, 13 and 14 form the second group. Items 15 and 16 are the optional extension
and do not precede the fidelity work. A new large control plane, a full manager rewrite and a
multi-tenant conversion stay out of this stabilization and are not closed as unwanted.

## Execution constraints

Unchanged from phase 1: no local suites, individual tests, typecheck, build, install or live `ocx`
execution; verification is static source review plus exact-head hosted CI; pushes use
`--no-verify`; only the coordinator merges and closes issues.
