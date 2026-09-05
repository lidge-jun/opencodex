# 030 — Verify live, open one PR, merge with admin

Work-phase `wp3`. Depends on 010 and 020.

## Checks

Focused only. The repository-wide suite is explicitly forbidden for this unit:
no bare `bun test`, no `bun run test`.

1. `bun run typecheck`
2. `bun run lint:gui`
3. `bun test` on the specific new/changed test files only, plus
   `bun run test:changed` for import-connected coverage.
4. `bun run build:gui`, then restart or reload the live dashboard and verify
   the served bundle is the new one before believing any UI observation. A
   merged source tree is not a deployed one — `gui/dist` is gitignored and the
   proxy can serve a stale checkout.
5. Because this unit also edits `docs-site/`, build the site the way CI does:

   ```bash
   cd docs-site && bun install --frozen-lockfile && bun run build
   ```

   There is no root `bun run build` script in this repository — `package.json`
   ships `build:gui` (which already runs the frozen-lockfile GUI install and
   `prepare:package`) and no bare `build`. Running the GUI build plus the
   docs-site build covers both changed surfaces.

## Locale parity is part of "docs updated"

Updating the English source and one translation is not the whole job. This unit
documented the refresh-all control in `guides/web-dashboard.md` (en) and its
Korean locale, and left `zh-cn` and `ru` describing only the per-account probe
behavior — so a reader of either locale saw a dashboard control the docs did not
mention. Caught after the first merge, fixed in #3472.

The rule that fell out of it: when a docs change edits a row that exists in
multiple locales, check every locale that CARRIES that row, and say explicitly
which locales do not carry it. Here `ja`, `fr`, `tr`, and `zh-tw` have no
equivalent sentence at all, so they are not contradicted and were deliberately
left alone — half-translating a row those files never carried would be a larger
change than the gap it closes.

A grep for the sentence being changed, across
`docs-site/src/content/docs/*/guides/`, is the cheap version of this check.

## Live proof required

- Logo click at `#providers` lands on `#dashboard` (URL + screenshot).
- Overview refresh issues `/api/provider-quotas?refresh=1`, the button shows
  its pending label, and the settled result line appears (screenshot).

## Landing

Branch `codex/providers-home-and-quota-refresh`, incremental commits, push with
`--no-verify` (explicitly authorized). One PR against `dev` filling every
section of `.github/PULL_REQUEST_TEMPLATE.md`. The PR mentions `gui`, so
`enforce-target` requires a screenshot of the UI change in the description —
attach both.

Merge with admin, then prove it:

```bash
git fetch origin dev
git merge-base --is-ancestor <merge-sha> FETCH_HEAD
```

An empty `gh pr checks --required` is not green evidence; read the full rollup
for the exact head before merging.
