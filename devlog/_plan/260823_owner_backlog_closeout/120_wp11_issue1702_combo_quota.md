# 120 — wp11: issue #1702, per-target quota state in the combo workspace

## Item

`lidge-jun` issue #1702, "surface per-target quota state in the combo workspace —
disable actions when all targets have 0 credits".

## Investigation verdict

STATUS REPRODUCES, disposition FIX_NOW, effort medium.
`gui/src/pages/Combos.tsx:110-117` loads combos, config, and models but never
calls `/api/provider-quotas`. `combo-workspace-detail-panel.tsx:189-190` disables
Save/Create only for clean edits or busy state.

An earlier attempt exists — `c8c4358a1`, PR #1704, closed unmerged — and is not
an ancestor of `dev`. It added presentation without action gating, so it was not
resurrected.

The backing endpoint already exists at
`src/server/management/provider-routes.ts:372-378`, so this is GUI-only: no
runtime change.

## The design rule this hangs on

Quota state is tri-state: available, exhausted, **unknown**. Missing, stale,
malformed, failed, conflicting, or incomplete aggregate evidence all resolve to
unknown, and unknown must never disable a control. Only "every usable target is
KNOWN exhausted" disables Save and Create, and recovery re-enables automatically.

The inverse — treating absent evidence as exhausted — would turn a dropped poll
into a locked workspace, which is a worse bug than the one being fixed. Disabled
targets are excluded from the all-exhausted decision, since a disabled target is
not a target the combo can use.

## Evidence

- `bun test tests/combo-workspace-data.test.ts` -> 35 pass / 0 fail
  (USD, percentage, custom window, unlimited, stale/unknown, trimmed provider,
  incomplete aggregation, disabled target, mixed state, all-exhausted, recovery).
- `cd gui && bun test tests/combo-workspace-empty.test.tsx tests/combo-workspace-dirty.test.tsx` -> 5 pass.
- `bun run typecheck`, `bun run lint:gui`, `cd gui && bun run lint:i18n`,
  `bun run build:gui` -> all pass.
- `cd docs-site && bun run build` -> 393 pages.
- Browser QA at 1440x813 and 500x757; badges wrap without clipping.

31 files: GUI components and data derivation, all nine locales
(`gui/AGENTS.md:14-18` requires every one), CSS, three test files, and the combo
guide in English plus its seven translations.

Re-verified by the main session after rebase onto `6b0f61f64`: 35 pass / 0 fail.


## Execution record

Opened as PR #2454 against `dev`, rebased onto `6b0f61f64`.

The repository's `enforce-target` gate rejects any PR mentioning `gui` without a
screenshot in the description, so the capture was committed to a throwaway
branch (`codex/asset-1702`, not for merge) purely to give the image a stable raw
URL. That branch gets deleted once the PR lands.
