# 010 — Persist the scan inventory

## IN / OUT

**IN:** copy already-gathered evidence under
`.codexclaw/evidence/4c876c16-4cd9-4a26-bcd5-743ccaa1b137/credits-scan/`
(`window.txt`, `tight.json`, `author-absent.txt`). Re-read `origin/dev:CREDITS.md`
and confirm `#3988` is still absent before 020.

**OUT:** no `CREDITS.md` edit in this phase; no `src/` edits.

## Files

| Path | Op | Notes |
| --- | --- | --- |
| `.codexclaw/evidence/4c876c16-4cd9-4a26-bcd5-743ccaa1b137/credits-scan/*` | NEW (gitignored) | Already written during Plan exploration. |

## Accept

- `rg '/pull/3988' CREDITS.md` on `origin/dev` exits 1 (not yet recorded).
- Evidence files exist and name `#3988` / `e2bf1672c` / `14ce693e5`.

## B confirmation (wp0)

Roadmap locked in B: 000/001/010/020/030 are on disk; insertion uses full SHAs
`e2bf1672c974611f8db736cd64a90e1dc443924a` and
`14ce693e5846596c823941ce90add538713a25b1`; branch is created before the
CREDITS.md edit. No production patch in this cycle.

## wp1 P stale-check (after wp0 D)

Previous D: docs-only roadmap locked; unique miss is #3988; CREDITS.md not patched.

Re-fetch `origin/dev` is now `2206f960669691555e41f506e53087cbc208f42d`
(was `27fa557db` in `window.txt`). Nine new commits `27fa557db..origin/dev`
have no carry/reimplement/supersede/cherry-pick language. `rg '/pull/3988'`
on `origin/dev:CREDITS.md` still exits 1.

GraphQL re-check of the landing objects:

- `e2bf1672c974611f8db736cd64a90e1dc443924a` (#4031 merge): authors resolve only
  to `lidge-jun`.
- `14ce693e5846596c823941ce90add538713a25b1` (cherry-pick): unmapped machine
  identity (`user: null`) plus `CommandCodeBot`. No `rrmlima`.
- `#3388` on `3f3008422be4af5adf1b0632f920d65fb051c646`: `Maple` trailer
  GraphQL-resolves to `zleo-ai`. GitHub credit already maps; not a CREDITS.md row.

Inventory freeze still names exactly one new miss: #3988 / @rrmlima. No
`CREDITS.md` edit in this work-phase.

## wp1 B freeze

Evidence files confirmed in B. `window.txt` now also records tip
`2206f960669691555e41f506e53087cbc208f42d` and `wp1_other_misses: none`.
Independent explorer `338f07cd` and reviewer `92d6377c` agree the unique
new miss is #3988. `CREDITS.md` was not modified. Next cycle (020) creates
the worktree/branch then inserts the row.
