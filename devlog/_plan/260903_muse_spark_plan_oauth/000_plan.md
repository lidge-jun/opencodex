# Meta Muse Spark: direct Model API provider + plan-credential question

- Date: 2026-09-03
- Session: `01a064b2-91b5-7272-b9ef-4db66bb46921`
- Work class: **C4** — wp4 raised it: a live credential read, an OAuth flow, a GUI consent gate, a privacy-scan rule, and billing metadata now move together.
- Status: **A (wp4)**. wp0 closed; wp1 merged as `ff1ac6b8c` (#3321); wp2 closed `NOOP` and is superseded (see below); wp4 in audit.

## Loop spec

- Archetype: satisfy-spec integration. wp2's open question resolved to a recorded negative, then reopened under owner authorization as wp4.
- Trigger: the user asked whether Meta's Muse Spark *plan* can be attached, after `878f75417` landed Muse Spark 1.3 through the Command Code and OpenCode Zen resellers.
- Goal: reach Muse Spark **directly** on Meta's own endpoint (wp1, done), and — under explicit owner authorization — reuse the Muse Code CLI credential behind a high-risk ToS warning (wp4).
- Non-goals: touching generated metadata, changing any `*-free` Zen id, retiring or redefaulting any model, altering the merged 1.3 work, wiring Meta's session-bound console GraphQL, and the passive quota cache (that is wp5).
- Authorization boundary: **wp1 issued no key and entered no billing detail.** wp4 exists only because the repository owner completed the Muse Code login and payment on his own account and instructed that it ship with a warning. No agent-initiated credential or billing action is in scope.
- Verifier: the canonical gate in `030` — focused `bun test` on the touched suites, `bun run test:changed`, `bun x tsc --noEmit`, `bun run privacy:scan`, and the `docs-site` frozen-lockfile install plus build. **The repository-wide local suite is forbidden by standing user instruction**; exact-head GitHub CI is the authoritative gate.
- Stop condition: every work-phase closed, and each of the three implementation PRs — wp1 (merged), wp4, wp5 — green on its exact head SHA and merged into `dev`.
- Memory artifact: this unit folder.
- Terminal outcomes: wp1 `DONE` (merged). wp2 `NOOP`, superseded by wp4. wp4 and wp5 target `DONE`. `BLOCKED` remains available if CI or branch protection refuses for an unrelated reason.
- Escalation: each A gate dispatches one independent read-only reviewer on `gpt-5.6-sol` at high effort. Two failed correction loops on the same packet stops the phase and reports.

## Revision after the A-gate audit (round 1: FAIL, 8 blockers)

An independent `gpt-5.6-sol` reviewer failed the first draft, and a third-party user
report arrived in the same window. Between them, the plan changed shape:

| Was | Now | Why |
|---|---|---|
| provider id `meta` | `meta-model` | `meta/muse-spark-1.3` is a LIVE Command Code selector; `router.ts:676` would have hijacked it, and `init.ts:72` would have derived `META_API_KEY` — the CLI's variable, not the API's |
| `liveModels: true` | `false` | no authenticated `/v1/models` payload was ever seen; Meta serves image and voice families on the same base URL |
| effort array only | plus identity `modelReasoningEffortMap` | `reasoning-effort.ts:171` rewrites `minimal` to `low`; the array assertion passed while the wire was wrong |
| "no OAuth exists" | a device-code-shaped login exists | `muse login` opens `auth.meta.com/oauth/device`; the docs simply do not mention it. Finding it did not make it usable — see below |
| 2-layer stack | 1 PR | the disclosure folds into wp1, and wp2 ships no code |
| wp3 as a work-phase | delivery ceremony inside each phase | delivery is not independently implementable |

**The correction worth naming.** `001` §G concluded no third-party OAuth flow existed,
from a docs-site search returning *No matching results* and Authentication's flat "every
request needs an API key". Both readings were accurate; the inference was not. Installing
the CLI and running `muse login --help` disproved it in one command. Absence from a
vendor's docs is not absence from the product — and the reviewer catching the adjacent
SDK claim is what sent me to check.

## The decision this plan turns on

A reseller path already works. `command-code/meta-muse-spark-1.3` and `opencode-go/muse-spark-1.3-contributor` shipped in #3317, so nothing here is about *reaching* the model. What is missing is the direct route and, more importantly, an answer to the question the user actually asked.

**The plan credential is scoped out by the vendor, in writing.** `dev.meta.ai/docs/muse-code/subscriptions` states it twice:

> The subscription applies to the Muse Code API key that is automatically connected in the Muse Code CLI onboarding process. **This credential is for use with Muse Code only.** Any additional API keys you create under your Meta Model API account will be billed through pay-as-you-go.

> Your subscription **only works through the Muse Code CLI** while signed in with your Meta Model API account.

That is a licence boundary, not a technical one — and it survives the OAuth discovery
intact. The two questions are now cleanly separable:

- **Mechanism:** could opencodex hold this credential? A device-code-shaped login
  exists, so possibly. **Not measured, deliberately** — see below.
- **Entitlement:** may it be spent outside Muse Code? The vendor has answered no.

Only the second question decides whether anything ships, and it is already answered. So
the mechanism was left unmeasured rather than tested: an experiment that can only
discover whether enforcement is absent cannot produce a result that licenses shipping.
wp2 closed `NOOP` on that basis (`020`).

A third-party user report (Threads, 2026-09-03) claims pay-as-you-go bills through by
default under the plan, and that the endpoints are not separated. Both are **unverified**
and neither changes the outcome — the second is precisely the enforcement-absence
observation above.

The user-visible consequence lands in wp1 regardless: the provider note says outright
that a Muse Code subscription does not apply and every call is metered.

## The second decision: wire shape

Meta publishes an OpenAI-compatible surface at `https://api.meta.ai/v1` carrying both `POST /v1/responses` and `POST /v1/chat/completions`, and the quickstart hands the OpenAI SDK that exact `base_url`. Responses is the documented recommendation for agentic work ("the recommended default for new work"), and it is the surface that carries `input_image` and reasoning replay.

So the provider is `adapter: "openai-responses"`, not `openai-chat`. Registering it as a Chat provider would work but would forfeit the reasoning-replay and native-multimodal path the vendor recommends, and it would diverge from how `openai-apikey` is already registered against the same wire.

## Work-phase map (dependency-ordered, PHASE-SPLIT-01)

| Phase | Doc | Delivers | PR |
|---|---|---|---|
| wp0 | this folder + `001`, `002` | claim ledger, feasibility research, diff-level decade docs | — |
| wp1 | `010_wp1_direct_provider.md` | `meta-model` key provider, ladder + wire map, parity/pricing/docs updates, behavior tests | PR 1 — **merged** as `ff1ac6b8c` (#3321) |
| wp2 | `020_wp2_device_oauth.md` | closed `NOOP` on the evidence available at the time | none |
| wp4 | `003` + `040_wp4_muse_oauth_provider.md` | `meta-muse` OAuth provider, import-only, behind the high-risk ToS warning | PR 2, base `dev` |
| wp5 | `050_wp5_passive_muse_quota.md` | passive subscription-quota cache from the `response.subscription_usage` SSE event | PR 3, base `dev`, after wp4 |

## wp4: the owner reopened wp2, and that is a different act

`020` closed on the reasoning that proving a credential works is not the same as being
allowed to use it. **That reasoning is not withdrawn.** Its reopen conditions listed only
first-party vendor changes because they were written for the case where an *agent* would
be making the call.

The repository owner has since completed the Muse Code login and the payment setup on his
own account and asked for this to ship with a warning. A user spending his own ToS risk
deliberately is not the same act as an agent spending it unilaterally, and opencodex
already models exactly that distinction — `gui/src/oauth-tos-risk.ts` carries
`anthropic` and `google-antigravity` in `HIGH_RISK` for the same reason.

Measurements that became possible only after that login are in `003`. Two of them changed
the design: the OAuth `access_token` 401s while a sibling `api_key` works, so the
provider ships a static key rather than a refresh loop; and Meta reports subscription
window usage only as an SSE event on streaming turns, so no on-demand quota probe is
possible — reading it needs a passive cache, which is wp5.

**Independent PRs, no stack (`DEV-STACK-01`).** wp1 merged as `ff1ac6b8c`. wp4 and wp5
follow as separate PRs off `dev`: wp5 depends on wp4 in time (it needs the provider to
exist) but not in diff — it touches the streaming path and the quota cache, files wp4
never opens — so stacking would impose a false merge order rather than aid review.
`030` is delivery procedure, not a work-phase.

## Why wp2 closed instead of shipping

A real `muse login` **does** open a browser device-approval flow — the docs simply never
mention it, and the first draft of `001` §G wrongly concluded no such flow existed.

Finding it did not make it usable. The round-2 audit put it plainly: proving a credential
is technically reusable is not the same as being allowed to reuse it. The experiment I
had planned — extract the credential, fire it at `api.meta.ai`, ship if it returns 200 —
tested whether **enforcement was absent**, not whether **use was permitted**. Meta
answered the second question in writing before anyone asked: "This credential is for use
with Muse Code only."

So no credential was extracted, no login was completed, and a targeted check confirms
none exists on this machine. The finding ships as `020` plus the user-facing disclosure
in wp1's note.

## Scope

### IN

- `src/providers/registry.ts` — one new entry plus its effort/window/modality constants and wire map
- `tests/provider-registry-parity.test.ts` — the hardcoded key-provider roster
- `src/usage/expected-prices.ts` + `tests/usage-cost.test.ts` — two `meta-model` rows in wp1 (64 → 66) and two `meta-muse` rows in wp4 (66 → 68)
- `docs-site/` English provider table (`src/AGENTS.md:29` requires it)
- `tests/` — a focused suite beside the existing provider tests
- `src/oauth/` — `meta-muse.ts` (NEW) and one `OAUTH_PROVIDERS` entry, in wp4 only.
- `gui/src/oauth-tos-risk.ts` + `gui/src/pages/Providers.tsx` — the high-risk warning and its reauth path (wp4).
- `scripts/privacy-scan.ts` — a detector for the measured `LLM|` key shape (wp4).
- `devlog/_plan/260903_muse_spark_plan_oauth/`

### OUT

- `muse serve` / the MSP SDK — a stdio JSON-RPC **agent session** host, not a model endpoint. Bridging it would mean re-hosting an agent runtime inside a proxy and discarding the part that makes it an agent (`002`).
- Translated `docs-site` locales — English source only.
- `src/generated/model-metadata.ts`, `scripts/model-metadata.source.json` — generated from a vendor snapshot; hand-editing them is forbidden by the repo's own convention.
- (`src/usage/expected-prices.ts` moved to IN. `src/usage/cost.ts:267` resolves a generated-metadata alias first, and `meta-model` has none, so an unpriced row falls through and reports no cost at all. Two overlays are required, not optional.)
- Muse Voice Transcribe (`wss://api.meta.ai/v1/asr/realtime`, `POST /v1/asr/transcribe`) — a different transport, out of scope.

## Accept criteria (goalplan c-1 through c-6)

1. `c1` — this unit carries 000-range research plus a diff-level decade doc per implementation phase.
2. `c2` — every registry fact traces to a published vendor statement in `001`.
3. `c3` (wp1 only) — no API key is issued and no billing detail is entered by the agent; wp4 runs under the owner’s own completed login and payment, per the authorization boundary above.
4. `c4` — the plan-credential question is answered by working wiring or a recorded negative with the blocking evidence. Met first by `020`'s negative; **re-answered by wp4** as working wiring under owner authorization.
5. `c5` — `tsc` exits 0, focused tests pass, the full local suite is never run.
6. `c6` — the implementation PR green at its exact head SHA and merged into `dev`.
7. `c7` (wp4) — the `meta-muse` login imports the CLI credential, every GUI login path is gated behind the high-risk warning, both models resolve a price, and no credential value reaches a log, error, status object, or the repository.
8. `c8` (wp5) — the `response.subscription_usage` event is parsed through `normalizePercent`/`normalizeResetAt`, cached under the account that actually served the turn, and displayed with its observation time; no path issues an inference call to refresh a quota.
