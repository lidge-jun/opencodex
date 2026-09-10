# wp5 — Hardening and delivery

Prove the whole chain against the real tree, document the user-facing surface, and open the
PR. No new behavior here; anything that turns up gets fixed, not extended.

## Full gates

```
bun install                                   # required in a fresh worktree
bun x tsc --noEmit                            # must exit 0
bun run test                                  # full suite
bun run privacy:scan                          # must exit 0
bun test tests/core-lab-boundary.test.ts      # boundary, run explicitly as well
```

Baseline recorded in wp1: `bun x tsc --noEmit` exits 0 at `295860825` with no output. A new
failure is therefore ours, not inherited. If `bun run test` shows failures, each one is
either fixed or proven pre-existing by re-running it on the merge-base — a remembered
"that was already broken" is not evidence.

## Boundary audit

`tests/core-lab-boundary.test.ts` hardcodes `src/lab/` (`:63`,
`next.includes("/src/lab/")`) across four protected entrypoints — `src/router.ts`,
`src/server/lifecycle.ts`, `src/server/responses/core.ts`, `src/server/management-api.ts`.
It says nothing about `src/quota/`.

So a hand-run `rg` would be the only thing behind our boundary claim, which is the
situation AGENTS.md calls out: "this paragraph was the only thing holding the guarantee."
wp5 therefore ADDS a real guard, `tests/quota-reset-core-boundary.test.ts`, reusing the same
walker shape:

- the walker is parameterized over a TARGET SET, not a single hardcoded string, so it checks
  both `/src/lab/` and `/src/quota/reset-` from the four protected entrypoints. Audit
  blocker 5 confirmed all four reach `src/codex/quota.ts` statically (for example
  `core.ts -> codex/auth-context.ts -> codex/quota.ts`) and three reach
  `src/providers/quota.ts` (`core.ts -> oauth/anthropic-routing.ts -> providers/quota.ts`),
  so the lazy-import requirement is load-bearing rather than precautionary
- `src/codex/quota.ts` and `src/providers/quota.ts` name the observer ONLY through
  `import(` — a static import in either is a failure, since both are reachable from
  `src/server/responses/core.ts`
- driven red once before landing, by temporarily adding a static import, so it is not
  vacuous

The walker does not propagate through `import()` by design
(`tests/core-lab-boundary.test.ts:76`: "a deferred edge, not a load-time one"), which is why
the wp3 lazy imports are the sanctioned remedy and not an evasion. A static import would
load the sink registry into every install — the exact failure AGENTS.md documents for Lab,
where a six-hop chain pulled ~69 modules onto the core path and no single file looked wrong.

## Docs

- `docs-site/src/content/docs/reference/configuration/server.md` — new
  `quotaResetNotify` section: every field, defaults, the default-OFF statement, and the
  note that the payload deliberately carries no account identity.
- `docs-site/src/content/docs/reference/management-api.md` — one table row for
  `GET /api/quota-resets`, matching the existing row format at line 197.
- `docs-site/src/content/docs/reference/cli/providers-accounts.md` —
  `ocx provider resets`.

English source only. Translated locales are left alone rather than machine-translated:
a stale translation that contradicts the English source is worse than an absent one.

## Activation evidence (C-ACTIVATION-GROUNDING-01)

Every conditional path this unit adds needs a fired-path artifact, recorded in
`050_activation_evidence.md` with pasted test output:

| Path | Trigger | Observable proof |
|---|---|---|
| scheduled detection | prev resetAt in the past + drop | assertion on `kind === "scheduled"` |
| surprise detection | drop inside an unexpired window | assertion on `kind === "surprise"` |
| deadline-jump surprise | `next.resetAt > prev.resetAt` early | assertion on `kind === "surprise"` |
| exactly-once | same key twice + store rehydration | sink call count is 1 |
| credits-only suppression | `{ resetCredits }` write only | sink call count is 0 |
| cold-start suppression | no prev | sink call count is 0 |
| default-OFF | no config | sink never constructed, no timer |
| sink failure isolation | throwing webhook | `ok: false` + command sink still ran |
| blocked destination | private URL, flag off | `"blocked-destination"` |
| poller idempotence | double start | one timer |
| boundary guard | synthetic static-import fixture, like the existing attack cases at tests/core-lab-boundary.test.ts:301 | the guard fails on the fixture and passes on the real tree |
| webhookUrl redaction | ocx config show with a configured webhook | the URL prints as `********` |

A green suite with no test driving a trigger does not satisfy any row.

## PR

Branch `codex/quota-reset-detection` -> `dev`. Never `main`. Full
`.github/PULL_REQUEST_TEMPLATE.md`: Summary, Verification (pasted command tails with exit
codes), Checklist. No screenshot needed — no GUI change, and the description must avoid
implying one, since `enforce-target` demands a screenshot from any PR whose title or
description mentions the GUI.

Commits stay small and per-phase (DEV-GIT-COMMIT-01). Push is user-approved for this task;
force-push and pushes to `dev`/`main` are not.

## D-phase record

`050_activation_evidence.md` plus a `060_closeout.md` naming the terminal outcome, what did
NOT improve, and which hypothesis died (LOOP-PESSIMIST-01). Known candidate already:
detection cadence is bounded by the 5- and 10-minute cache TTLs, so `detectedAt` brackets
the reset rather than timestamping it. That is a limitation to state, not to hide.

On close, the unit moves to `devlog/_fin/` only once the PR has landed — a `_fin` unit is a
record of work already visible in public git history.
