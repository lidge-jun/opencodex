# 030 — Ultra Fast as an explicit opt-in (issue #3429)

Work-phase `wp3`. Depends on 000. This is the phase that needs judgment, not just
diffs.

## The constraint #2994 left behind

PR #2994 added `ultrafast` to the pinned `gpt-5.6-sol` fallback catalog and was
closed unmerged:

> Ultrafast는 프런트 노출 오류다. 피커에 칸을 올리면 고를 수는 있는데, 실제
> Ultrafast 속도가 나오지 않는다.

Exploration of `origin/dev` explains WHY, and the reason is load-bearing for this
plan. `src/codex/data/upstream-models.json` advertises exactly one tier on every
row that has any:

```json
"service_tiers": [{ "id": "priority", "name": "Fast", "description": "1.5x speed, increased usage" }],
"additional_speed_tiers": ["fast"]
```

There is no upstream `ultrafast` tier to forward. So a catalog row advertising
one is fabricated metadata: the picker gains a choice the wire cannot honor. That
is precisely the defect #2994 was closed for, and adding the row back — flag or
no flag — would reproduce it.

**Therefore this phase does NOT re-add the catalog row by default, and does not
claim Ultra Fast works.** It ships the half that is true today.

## What is a real defect regardless

#3429 reports something narrower that holds independently of whether the tier is
advertised: when a caller forces `service_tier: "ultrafast"` through anyway (by
hand-editing `~/.codex/opencodex-catalog.json`, which the reporter did), the
proxy carries the value but refuses to name it.

Traced on `dev`:

- `canonicalFastTierMarker` (`src/providers/fastwire.ts:247`) folds only
  `priority`/`fast`, so `ultrafast` returns `undefined`.
- `fastIntent` is therefore false, and the request is classified
  `fastOutcome: "not-requested"` at `fastwire.ts:344` — not `unknown`, but
  actively "no fast tier was asked for", which is false.
- `requestLogSpeedLabel` (`src/server/request-log.ts:594`) returns `undefined`
  for anything but `priority`/`fast`, so the Logs page shows no speed badge.

The proxy is forwarding a tier it will not admit to. That is an observability
lie, and it is fixable without advertising anything.

## Diff plan

### 1. Config flag, default OFF

Follow the `fastRows` precedent exactly (`src/config.ts:1052`,
`src/types/config.ts:384`):

```ts
// src/config.ts — zod
ultraFastTier: z.boolean().optional().catch(false),
```

`.catch(false)` matters: a malformed hand edit degrades to off rather than
rejecting the config. Read it with the house `=== true` idiom, never truthiness.

A management-route boolean guard goes beside `showCodexSparkQuota` in
`src/server/management/config-routes.ts:408` because this flag gets a dashboard
toggle (`fastRows` has none, which is why it needs no guard).

### 2. Honest classification (the part that fixes the reported defect)

`src/providers/fastwire.ts`: widen the canonical union to
`"priority" | "ultrafast"`, fold `ultrafast` in `canonicalFastTierMarker`, add
the `canonicalToWire` entry, and generalize the two `=== "priority"`
comparisons at `:349` and `:377` to "is a recognised canonical tier".

`src/server/request-log.ts:594`: `requestLogSpeedLabel` returns `"ultrafast"`
for that tier. The existing contract — `"auto"` and `undefined` stay
`undefined` — must not move; `tests/request-log.test.ts:703` pins it.

No new `fastOutcome` literal is introduced. The four existing values still
describe what happened; what changes is that `ultrafast` now reaches them instead
of being mistaken for "not requested". That keeps
`src/usage/log.ts`'s persisted-row allowlist untouched.

### 3. Catalog gating — flag-gated, and honest about what it does

`normalizeServiceTiers` and `normalizeRoutedCatalogEntry` gain a trailing
optional options bag, defaulting to off, threaded from the `sync.ts` call sites
that already hold `config`. With the flag absent, every `delete` runs exactly as
today.

With the flag ON, the tier is PRESERVED when a catalog already carries it
(the operator's hand edit survives regeneration, which is the reporter's actual
ask). It is still NOT synthesized: `src/codex/catalog/effort.ts:160` keeps
emitting only the `priority` row, because inventing a tier upstream does not
advertise is what #2994 was reverted for.

### 4. GUI — Codex Set page head

`CodexAccountPoolPageHead` (`gui/src/components/codex-account-pool-main-card.tsx:207`)
currently carries the title, a status span, the Spark toggle, and two action
buttons on one row. Move "한도 도달 계정 일시 중지" and "할당량 새로고침" out of
the head and into the existing advanced-settings grid
(`CodexAuthAdvancedSettings`, `div#codex-auth-advanced-boxes`), which is already
the page's home for secondary controls, and put the Ultra Fast toggle there as a
`card card-row` matching `CodexAccountPickerSetting`.

Two constraints from the existing code:

- The component is dual-mode. `embedded={true}` (Providers workspace) renders a
  bare `.row`; only the standalone page renders `.page-head`. The move must not
  change the embedded surface.
- `gui/tests/codex-set-page-head-wrap.test.ts` throws `rule not found` if the
  `.codex-auth-page-head` selectors disappear, and
  `codex-account-pool-toast-tone.test.tsx` queries
  `.codex-auth-page-head__feedback`. Keep those class names alive.

The toggle's description states plainly that upstream advertises no Ultra Fast
tier today and that the setting only preserves a tier the operator supplies. A
switch that implies a speed it cannot deliver is the #2994 defect in a new place.

## Verification

- `bun run typecheck`, `bun run lint:gui`
- Flag OFF regression set, which is the proof the default did not move:
  `tests/codex-catalog.test.ts`, `tests/fastwire-characterization-routing.test.ts`
  (byte golden), `tests/service-tier-capability.test.ts`,
  `tests/request-log.test.ts`, `tests/fastwire-observability.test.ts`
- New focused tests: flag OFF strips exactly as before; flag ON preserves a
  supplied tier; `ultrafast` classifies instead of reading `not-requested`;
  `requestLogSpeedLabel` maps it while `"auto"` still returns `undefined`
- `gui/tests/codex-set-page-head-wrap.test.ts` and the toast-tone suite stay green
- Live: the Codex Set page head no longer carries the two buttons; they and the
  toggle are reachable below

## What this phase will NOT claim

It will not claim Ultra Fast delivers Ultra Fast speed. If live evidence shows an
opted-in request still cannot get the tier honored end-to-end, that is reported
on #3429 rather than papered over — the same call #2994 made, and the reason it
is closable honestly either way.
