# wp3 — close or record every remaining parity surface

Own PR, base `dev`, after wp1 and wp2 land. Branch: `codex/meta-muse-parity-closeout`.

This phase exists because "make Meta first-class" is only verifiable against an
enumerated list. `001` §C is that list; this doc dispositions every row.

## The rule this phase applies

A surface is closed when `meta-muse` behaves like a first-class provider, or recorded
NOT-APPLICABLE when the difference follows from a **measured property of Meta's API** —
never from "we did not get to it". Every NOT-APPLICABLE carries a file:line and a reason
that would survive a reviewer asking "why not just add it to the allowlist?".

## 1. Provider note — CLOSE (`src/providers/registry.ts:1543`)

The note currently says:

> Meta reports subscription window usage inside streaming responses, but OpenCodex does
> not yet read or display it, and there is no endpoint to query it on demand.

False after wp1. Replace that sentence with:

> OpenCodex reads Meta's subscription windows from streaming responses and shows the
> last observed value with its age; there is no endpoint to query them on demand, so a
> fresh reading requires a streaming turn and translated (non-passthrough) turns do not
> report one.

Both clauses after the semicolon are load-bearing: the first explains why the number can
be stale, the second is the documented gap from `004` Q3 rather than a silent one.

`tests/meta-model-api-provider.test.ts` asserts note substrings — check before editing.

## 2. docs-site — CLOSE (`docs-site/src/content/docs/guides/providers.md:475`)

Same correction, English only. The surrounding paragraphs about the ToS boundary and
per-team rate limits are unchanged and remain accurate.

## 3. `ocx account refresh meta-muse` — CLOSE the message, keep the behaviour

`src/cli/account-extended.ts:328` prints "no quota report" because
`maybeFetchProviderQuota` has no `meta-muse` branch. **The behaviour is correct and must
not change** (c4: no path may issue an inference call to refresh a quota). The message is
what misleads — it reads like a failure.

Emit, for a provider where `hasPassiveAccountQuota` is true:

> meta-muse reports usage only during a streaming response; there is nothing to refresh.
> Run a request through this provider to update it.

A CLI that explains an intentional absence is the difference between a documented design
and an apparent bug.

## 4. Provider-level overview card — DECIDE, then close

`quota.ts:2298-2301` gives `/api/provider-quotas` a row for anthropic, antigravity and
kiro; `meta-muse` has none, so `ProviderCapacityQuota.tsx:47` renders "No quota data".

Two honest options, decided in wp3's P against the tree at that time:

- **(a)** derive the provider row from the cached active account's observation — no
  probe, consistent with wp1's seam, and it fills a visibly empty card.
- **(b)** record NOT-APPLICABLE: the provider card means "the provider's capacity", and
  Meta's documented limits are **per team, not per key** (`001`, `003` §E), so a
  per-account subscription window is the wrong quantity to promote to provider level.

**Current lean: (b), with the empty card given an explanatory string** rather than a
number that means something different from every other provider's provider-level bar.
wp3's audit gate decides; whichever is chosen, the reason is recorded here.

## 5. `skills/ocx` — CLOSE (`skills/ocx/references/03_recipes.md`)

Add a `meta-muse` account recipe covering import login, `ocx account list meta-muse`,
and the passive-quota caveat. `bun run skill:surface:check` must stay green; the surface
map is generated from `src/cli/capabilities.ts`, and `tests/skill-ocx.test.ts` fails if a
hand-written page names a command the registry does not have.

`src/cli/capabilities.ts:250` also carries a stale line — "`anthropic` is the only OAuth
pool with this setting; other OAuth providers are refused without a round-trip" — which
`001` shows is wrong: generic OAuth providers do reach the pool endpoint, and their
settings persist inertly (`pool-settings-capability.ts:40`). Correct it while here.

## 6. Recorded NOT-APPLICABLE (no code)

Each with the measured reason, written into this doc's closing section at D:

| Surface | Reason | Evidence |
|---|---|---|
| Connection test | `liveModels: false` short-circuits to `static_catalog` before any network call; the authenticated roster carries image and voice models a Responses-agent provider cannot drive. `kiro` is the same class | `provider-routes.ts:1195`; `registry.ts:1538`; `003` §C |
| 401 replay / `FORCE_REFRESH_PROVIDERS` | the credential is a **static API key**; the OAuth `access_token` 401s while the `api_key` returns 200, so there is nothing to force-refresh | `src/oauth/index.ts:540`; `003` §B |
| Background refresh | `defaultRefreshPolicy: "disabled"`, same posture as `anthropic`: the vendor restricts use outside its own client, so every exchange stays attributable to a user action | `src/oauth/index.ts:240` |
| Account import | `ACCOUNT_IMPORT_PROVIDER` is a cockpit-tools document format with no Meta analogue | `src/oauth/account-import/types.ts:3` |
| `clear-cooldown` | anthropic-only because the generic failover health map is process-local — a provider-wide gap, not a Muse gap | `oauth-account-routes.ts:465`; `generic-account-failover.ts:78` |
| GUI generic pool card | no dashboard editor exists for **any** generic OAuth provider | `ProviderAuthPanel.tsx:353` |
| Translated-path quota | `openai-responses.ts` dispatches on `payload.type` through a switch with no case for the event | `004` Q3 |

The last two are the honest ones to resist closing: both are real absences a user could
hit, and both are provider-wide rather than Meta-specific. Fixing either inside a Muse
unit would be scope creep that lands untested for its other providers.

## 7. Side effect worth stating: routing changes, not just display

`001` §B measured that headroom-ranked pre-dispatch selection
(`generic-account-failover.ts:281`) and quota-aware cooldown are already wired for any
generic failover provider but inert while `hasHeadroomEvidence` is false. wp1's cache
**arms both** for a user with two or more Muse accounts.

That is desirable — it is what "first-class" means here — but it must be stated in the
PR description, because a reviewer reading a quota-display PR would not expect account
selection order to change. `001` §B and `003` §F establish the soundness: the RPM/TPM
limits are per team, but subscription windows are per subscription, so two Muse accounts
carry genuinely different headroom.

It is desirable **only within the staleness bound wp1 adds**. Unbounded, it is the
opposite: a routing preference computed from a days-old observation is worse than no
preference, because the unranked ring at least rotates. wp1 caps the routing read at one
hour and returns "no evidence" beyond it, which degrades to today's behaviour rather than
to a different wrong answer (`010`, `001` §B).

wp3's PR description must therefore describe the routing change **and** its bound. A
reviewer told only "quota now steers account selection" would reasonably object; the
bound is what makes the claim defensible.

## Verification

```bash
bun test tests/meta-muse-oauth.test.ts tests/meta-model-api-provider.test.ts \
         tests/skill-ocx.test.ts tests/cli-account.test.ts tests/provider-registry-parity.test.ts
bun run skill:surface:check
bun run test:changed
bun x tsc --noEmit
bun run privacy:scan
cd docs-site && bun install --frozen-lockfile && bun run build
```

## Terminal outcome

`DONE` when every row in `001` §C is either closed with a diff or recorded here as
NOT-APPLICABLE with its measured reason, and no user-facing text claims OpenCodex cannot
read a value it now reads.
