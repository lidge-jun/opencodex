# 040 — Verification, docs sync, PR

Work-phase **wp5**. Depends on `010`–`030`.

## Gates

```bash
bun x tsc --noEmit
bun test tests/usage-summary.test.ts tests/usage-cost.test.ts tests/api-usage.test.ts \
         tests/cli-registry.test.ts tests/cli-help.test.ts
bun run test          # shared runtime touched: routing/config/server all read usage types
bun run privacy:scan
```

The full suite is not optional here. `AGENTS.md` scopes focused checks to
scoped changes; this unit changes an exported type consumed by nine
management-route modules, so it is a shared-runtime change by the repository's
own definition.

## Live activation evidence

Static gates cannot show that `today` picks the right window or that the
filter branch fires. Against the running proxy on `10100`:

```bash
ocx usage --range today --provider xai
ocx usage --range today --provider xai --json | head -40
ocx usage --range today --provider nope        # empty-match path
```

Capture all three. The third is the one that proves the miss path renders an
honest empty result rather than silently falling back to unfiltered data —
that branch has no other observer (C-ACTIVATION-GROUNDING-01).

Cross-check: the printed `today` request count must match the value derived
independently from `--range 7d --json` filtered to today's date. If those
disagree, the window arithmetic is wrong regardless of what the unit tests say.

## Docs sync (SOT-SYNC-01)

`ocx observe usage` is documented in `reference/cli/agents.md` in English plus
7 locales (`fr ja ko ru tr zh-cn zh-tw`; there is no `de`). Each carries the
flag list `--range <7d|30d|all> --surface ... --json`.

`GET /api/usage` is documented in `reference/management-api.md` (+ locale
copies), which is where the new `filter` echo block and the day-level
`estimatedCostUsd` belong.

English is authoritative. Locales are updated so they do not contradict it —
at minimum the flag list, which is code-shaped and locale-independent.

## PR

Base **`dev`** (never `main`). Branch `codex/cli-usage-cost-query`.
`.github/PULL_REQUEST_TEMPLATE.md` requires Summary / Verification /
Checklist, and `enforce-target` rejects thin descriptions. No GUI change, so
no screenshot requirement is triggered — and the description must therefore
avoid the word `gui` in title/description, or the gate will demand one.

Push is user-approved for this unit ("PR 날려"). Scope of that approval:
push this branch and open this PR. It does not extend to `main`, to
force-push, or to merging.

## Terminal outcomes

- `DONE` — gates green, live evidence captured, PR open against `dev`.
- `BLOCKED` — push/PR creation denied by remote.
- `NEEDS_HUMAN` — a backward-compatibility break turns out to be unavoidable.
