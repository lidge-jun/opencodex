# Meta Muse: from credential import to a first-class provider

- Date: 2026-09-03
- Session: `01a0670b-54e5-7d41-9f86-b7cf5983b334`
- Work class: **C4** — the request path, a persisted cache, the management API, and a
  user-visible dashboard surface move together, and the cache is keyed by a credential
  identity that failover can change mid-turn.
- Status: **P (wp0)**.

## Loop spec

- Archetype: satisfy-spec integration. The verifier defines done; there is no metric to
  maximize.
- Trigger: the user opened `http://localhost:10100/#providers`, expected Muse usage to
  render, and found nothing. The investigation documents existed; the code did not.
- Goal: `meta-muse` behaves like a first-class OAuth provider in the dashboard — usage
  windows visible, and every other parity surface either closed or recorded as a
  deliberate, evidence-backed non-goal.
- Non-goals: Meta console GraphQL, Muse Voice/Image models, translated docs locales,
  `meta-model`'s key path, and any inference call issued to obtain a quota.
- Verifier: focused `bun test` on the touched suites, `bun run test:changed`,
  `bun x tsc --noEmit`, `bun run privacy:scan`, `bun run lint:gui`, `cd gui && bun run build`.
  **The repository-wide local suite is forbidden by standing user instruction.**
  Exact-head GitHub CI is the authoritative gate.
- Stop condition: every work-phase closed and each PR green at its exact head SHA and
  merged into `dev`.
- Memory artifact: this unit.
- Terminal outcomes: `DONE` for each phase; `BLOCKED` if CI or branch protection refuses
  for an unrelated reason; `NEEDS_HUMAN` if a display decision needs the user.
- Escalation: each A gate dispatches an independent read-only reviewer on
  `xai/grok-4.6`. Two failed correction loops on the same packet stops the phase.
- HOTL resource bounds: write scope is the IN list below; `gh` for PR and CI; subagents
  are read-only reviewers plus bounded workers with disjoint write scopes. No token or
  wall-clock bound was set, so `BUDGET_EXHAUSTED` is not an available outcome.

## What the predecessor unit got right, and the three things it did not

`260903_muse_spark_plan_oauth/050_wp5_passive_muse_quota.md` designed this feature and
was never built. Its core judgment holds and is adopted wholesale: Meta publishes no
quota endpoint (`003` §E probed 17 paths, all 404), the value arrives only as an SSE
event on a streaming turn, so the seam inverts — writes come from the request path,
reads are cache-only, and refresh does not exist. `supportsPerAccountQuota` must stay
false because that predicate gates `fetchAccountQuota`, whose fallback branch at
`src/providers/quota.ts:1629` sends any non-Kiro/non-Antigravity bearer to Anthropic's
usage endpoint.

Three of its file-change decisions are **wrong against the current tree**, and this unit
corrects them. Each was measured, not reasoned:

| `050` said | Measured | Consequence |
|---|---|---|
| add `onSubscriptionUsage` to `SseInspectorHandlers` in `relay.ts` | `onParsedPayload` already exists (`src/server/relay.ts:834`), fires for **every** parsed frame before terminal handling (`:1020`), and is already threaded through all three passthrough construction sites | **`relay.ts` is not modified at all.** A new handler would duplicate a seam that exists |
| the GUI account row needs new rendering | `ProviderAuthPanel.tsx:517` already renders `QuotaBars` for any account carrying `quota`, and `useProviderAccountPools.ts:100` already requests `?quota=1` for every OAuth provider | wp2 shrinks to the observation-age affordance; bars appear the moment the API returns them |
| `hasPassiveAccountQuota` guards the read path | the read path also runs `fetchProviderAccountQuotas` (`quota.ts:1683`), which **probes**; a passive provider needs a different function, not the same one behind a second flag | wp1 adds a cache-only reader, not an allowlist entry |

The general lesson, and the reason wp0 exists at all: a plan written against a tree
three commits ago names files that have since grown the seam it was going to add.

## The decision this unit turns on

A passive quota is **an observation, not a measurement**. Every other provider's bars
answer "what is true now"; a Muse bar answers "what was true at the last streaming
turn", which may be days old. Rendering the two identically is the one way this feature
can actively mislead — a user reading 4% and deciding to start a long job, when the
real figure moved hours ago.

So observation age is not decoration on this feature; it is the feature's honesty
condition, and it is why wp2 is a work-phase rather than a footnote in wp1.

## Work-phase map (dependency-ordered, PHASE-SPLIT-01)

| Phase | Doc | Delivers | PR |
|---|---|---|---|
| wp0 | this folder + `001` | measured parity inventory, diff-level decade docs | — |
| wp1 | `010_wp1_passive_quota_core.md` | parser, observation seam, generation-fenced write, cache-only read path | PR 1, base `dev` |
| wp2 | `020_wp2_observation_age_ui.md` | the dashboard states the observation age; absent renders nothing | PR 2, base `dev` |
| wp3 | `030_wp3_parity_closeout.md` | remaining surfaces closed or recorded NOT-APPLICABLE with evidence | PR 3, base `dev` |

wp1 → wp2 → wp3 is a real dependency chain: wp2 renders what wp1 caches, wp3's docs and
provider-note corrections are only true once both have landed. They are **independent
PRs off `dev`, not a stack** (`DEV-STACK-01`): wp1 is server-side, wp2 is
`gui/` plus one API field, wp3 is prose and small allowlists. The diffs do not overlap,
so stacking would impose a false merge order.

## Scope

### IN

- `src/providers/muse-subscription-usage.ts` (NEW) — the parser
- `src/providers/quota.ts` — `hasPassiveAccountQuota`, `recordPassiveAccountQuota`,
  `readPassiveProviderAccountQuotas`
- `src/server/responses/core.ts` — the observation handler on the existing
  `noteInspectedPayload` seam
- `src/server/management/oauth-account-routes.ts` — cache-only enrichment for a passive
  provider
- `gui/src/components/QuotaBars.tsx`, `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`,
  `gui/src/i18n/en.ts` (+ the other locale files' single new key)
- `src/providers/registry.ts` — the `meta-muse` note's quota sentence, in wp3 only
- `docs-site/src/content/docs/guides/providers.md` — English only
- `tests/` — focused suites beside the existing provider tests
- `devlog/_plan/260903_muse_provider_parity/`

### OUT

- `src/server/relay.ts` — the seam already exists; see the correction table above
- `src/generated/model-metadata.ts`, `scripts/model-metadata.source.json` — generated
- `supportsPerAccountQuota` — must stay false; `tests/meta-muse-oauth.test.ts:92` locks it
- `src/adapters/openai-responses.ts` — the translated path drops the event
  (`004` Q3, ANSWERED: no). Documented gap, not a silent one
- Meta console GraphQL (`fb_dtsg` + rotating `doc_id`), Muse Voice/Image, translated
  docs locales, `meta-model`'s key path
- `src/lab/` must stay off the core request path — `core.ts` is one of the three files
  `tests/core-lab-boundary.test.ts` guards, and this unit edits it

## Accept criteria

1. `c1` (wp0) — this unit holds 000-range measured research plus one diff-level decade
   doc per implementation phase; the wp0 commit contains no production code.
2. `c2` (wp1) — the parser maps both windows through `normalizePercent` /
   `normalizeResetAt`, drops `tier`, returns `null` (never throws) on junk, and routes a
   non-300-minute window to `customWindows` rather than the five-hour slot.
3. `c3` (wp1) — the write lands under the account that **served** the turn, is discarded
   when the config generation moved, persists across restart, and
   `supportsPerAccountQuota("meta-muse")` stays false.
4. `c4` (wp1) — no code path issues an inference call to refresh a Muse quota.
5. `c5` (wp2) — the account row shows the percentages with their observation age, and
   renders nothing (not a zero bar) when no observation exists.
6. `c6` (wp3) — every remaining parity surface is closed or recorded NOT-APPLICABLE with
   file-level evidence.
7. `c7` — `tsc` exits 0, focused suites pass, `privacy:scan` and `lint:gui` green, the
   GUI builds, and the full local suite was never run.
8. `c8` — each PR targets `dev`, is green at its exact head SHA, and is merged.
