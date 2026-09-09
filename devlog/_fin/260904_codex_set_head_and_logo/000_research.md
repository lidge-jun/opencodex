# 000 — Codex Set page chrome: two defects, one PR

Operator report, 2026-09-04, against `dev` at 2421e44ce with the live proxy on
port 10100 (v2.43.0):

1. In a narrow window the Codex Set page head's action buttons get cut off.
2. The Codex Set nav row uses a generic key icon instead of the Codex logo.

Both are chrome on the same page, both are `gui/src`-only, and neither touches a
runtime or auth surface. They ship as one pull request against `dev`.

## Surfaces

| Concern | File |
|---|---|
| Page-head markup | `gui/src/components/codex-account-pool-main-card.tsx` (`CodexAccountPoolPageHead`) |
| Page-head styles | `gui/src/styles.css` `.codex-auth-page-head*` (~1766) |
| Nav mapping | `gui/src/App.tsx` `NAV` |
| Icon set | `gui/src/icons.tsx` |

`CodexAccountPoolPageHead` renders two shapes from one component. With
`embedded={true}` (the Providers workspace account surface) it is a plain
`.row`; only the standalone page gets `.page-head.codex-auth-page-head`. The
defect and the fix are both confined to the standalone shape.

## Measurement, not inference

The clip was measured in the running dashboard rather than guessed from CSS —
rects are recorded in `010`. The Codex mark was located with the `aside-jun`
skill and then re-verified with an independent `curl` against the raw GitHub
source, so the committed path data traces to a URL rather than to an agent's
summary. Provenance is recorded in `020`.

## Verification bound

The operator explicitly barred the repository-wide local suite. Mechanical gates
are `bun run typecheck` and `bun run build:gui`; behavioral proof is live
measurement plus screenshots of the running dashboard. Push uses `--no-verify`
and the merge is admin — both operator-authorized.

## Work phases

- `wp1` — 010, page-head wrapping.
- `wp2` — 020, the Codex nav mark.
- `wp3` — PR against `dev` with screenshot evidence, then admin merge.
