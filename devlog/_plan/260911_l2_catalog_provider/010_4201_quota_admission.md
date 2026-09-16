# 010 — #4201 work-phase: Responses preset quota admission

Lane L2, branch `codex/260911-l2-catalog-provider`, rebased onto `origin/dev` `ed839a3ee`.

## What the issue asked for

#4201 reports two user-visible gaps behind one subscription. Switching the domestic GLM Coding
Plan from the Chat preset to the Responses preset loses the quota display and the
`glm-5.3-flash` entry, so the same plan looks halved after a wire-format change.

## What landed

Only the quota half.

`keyQuotaReaderForProvider` at `src/providers/quota.ts:2909` gated the Z.AI/BigModel reader on a
provider-name list of `zai`, `glm`, `glm-cn`, `zhipu-bigmodel-coding`. The destination check
`isCanonicalZaiBaseUrl` at `:355` already accepted `https://open.bigmodel.cn/api/v1`, and
`fetchZaiQuota` at `:858` already selects the domestic monitor host and its bare-key
`Authorization` convention for that base. The name list was the whole gap:
`providerApiKeyQuotaMode` returned `unsupported` and `fetchProviderApiKeyQuotas` returned `[]`
before any request existed.

The fix adds the one name. Eligibility stays a conjunction of the name list and the canonical-URL
guard, because that guard is what keeps the bare key from travelling to a lookalike host: a
same-named custom provider resolves no reader and therefore dispatches nothing at all.

Regression: `tests/providers/zhipu-bigmodel-responses-quota.test.ts`, registered in
`scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`. Four cases —
eligibility anchored to the registry entry's own `baseUrl`, the negative controls (custom host,
pay-as-you-go endpoint, disabled, non-key auth modes), the domestic dispatch with a bare
`Authorization` and `redirect: "error"`, and a no-dispatch proof for a same-named custom
destination.

It is a separate file on purpose: `tests/providers/provider-quota.test.ts` is contended by four
open PRs and is not in this lane's owned paths.

## Decision: Flash is not seeded

`glm-5.3-flash` stays out of the Responses roster, so the pull request says `Refs #4201`, not
`Closes`.

The issue itself makes Flash conditional — "should offer `glm-5.3-flash` **if** the domestic
Responses endpoint supports it, with verified context, modalities, and reasoning metadata" — and
this lane has no endpoint-specific evidence. The registry comment at `registry.ts:2640` records
that the static roster is deliberate and that the official Codex example is a local catalog file,
not an HTTP `/models` contract, and the roster oracle at
`tests/providers/provider-registry-parity.test.ts:464` and `:508` locks that shape. The
maintainer review on the issue reaches the same conclusion: admit the quota name now, seed Flash
only after endpoint proof.

Seeding it anyway would mean inventing a context window, modalities and a reasoning ladder for a
model this endpoint has not been observed to serve. That is the fabrication the oracle exists to
prevent, so the honest outcome is a closed quota half and an open, evidence-blocked Flash half.

## Documentation for L7

`docs-site/src/content/docs/guides/providers.md` is L7's path. Two edits follow from this change;
the wording is here so L7 can land it.

At `:947`, the eligible-preset sentence is now stale. Current text:

> **Z.AI GLM Coding Plan quota.** The `zai`, `glm`, `glm-cn`, and `zhipu-bigmodel-coding`
> presets read `GET /api/monitor/usage/quota/limit` and do not follow redirects.

Replacement:

> **Z.AI GLM Coding Plan quota.** The `zai`, `glm`, `glm-cn`, `zhipu-bigmodel-coding`, and
> `zhipu-bigmodel-responses` presets read `GET /api/monitor/usage/quota/limit` and do not follow
> redirects.

In the "BigModel Coding Plan over Responses" section, after the paragraph ending at `:783`, one
sentence closing the parity question the issue raises:

> Quota comes from the same Coding Plan probe as the Chat preset, because it is the same
> subscription: the Responses endpoint `/api/v1` is a canonical destination for that probe and
> uses the same domestic bare-key `Authorization`.

The Flash restriction is already documented at `:788` ("`glm-5.3-flash` is not seeded here
because its exact Responses metadata is not verified"), which is the wording #4201 asks for. No
change needed there beyond keeping it true.

## Overlap reported to the orchestrator

Open draft #4210 by `Ingwannu` (head `b9109a151`, `REVIEW_REQUIRED`) fixes the same selector line.
The packet's recorded decision is to implement #4201 independently and report the overlap rather
than merge the two lines of work, which is what happened: the diffs collide on
`src/providers/quota.ts:2909` because there is no second way to express this fix. #4210 also edits
`tests/providers/provider-quota.test.ts` and `docs-site/.../providers.md`, neither of which this
lane owns. `Ingwannu` is credited with a `Co-authored-by` trailer per `AGENTS.md`, since this
supersedes their quota hunk.

## Verification

Local product suite, typecheck and GUI build: **NOT RUN**, by operator instruction. Hosted CI on
the exact pushed head is the evidence. Two read-only `xai/grok-4.6` subagents reviewed the change:
one for blast radius, second callers and transport correctness, one adversarial pass over the
commit for type, runtime and layout-registration defects.

