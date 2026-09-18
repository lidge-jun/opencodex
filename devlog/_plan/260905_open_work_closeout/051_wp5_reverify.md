# 051 — wp5 P re-verification

Re-read 2026-09-05 at `origin/dev` = `593978db0`. Maintainer instructions now in force: no
local suite (typecheck + named files only); admin-merge everything, fixing only CodeRabbit
findings and current Linux-shard failures; final dev-tip CI is the batch gate.

| Layer | Item | Live state | merge-tree | Route |
|-------|------|-----------|------------|-------|
| E0 | #3530 follow-up (removal test never calls removeAccount) | merged 6580694c7 | — | small test fix, own PR |
| E1 | #3487 Kiro fallback proof | ee3b22d28, open | CLEAN | carry (rename detection handles the moved file; no reimplementation needed) |
| E2 | #2432 `__omit__` sentinel docs | head moved → b7d0a8455, draft | CLEAN | carry + doc-comment fix (050 E2) |
| E3 | #3421 Docker Compose | 432016100 | CLEAN | carry + compat-manifest in image + loopback default (050 E3) |
| E4 | #3531 agy alias | head moved → 5676a803d, draft; Ingwannu: exact-head CI fails `tests/codex-integration/codex-gather-authority.test.ts:158` deterministically on Linux + macOS (alias capture returns `[]` after registry unavailable) | CLEAN | carry + **fix that Linux-shard regression** (in scope per instruction) |
| E5 | #3464 | handed to parallel #3554 | — | — |
| E6 | #3425 exhausted-account routing after 502 | issue open, unowned | — | IMPLEMENT per 050 E6 |
| E7 | #3329 combo cooldown knobs | 1876d6001 | **CONFLICT** (dev moved since 008's probe) | carry: merge origin/dev, resolve, fix 1 (reset metadata on 5xx-wrapped quota) per 050 E7 |

Parallel-unit PRs #3547/#3551/#3554 (lidge-jun, all CI green): #3547 has a real reviewer blocker
(5xx precedence over location-message match); #3551/#3554 are blocked only on their stack base
being #3547. Not this unit's to modify; if still untouched at wp6 they are listed as residuals.

Trailers (id-prefixed noreply): Ingwannu 186453546, mdwsk88 11055210, Skyline-23 62983047,
benedictusrey888 192305729 (per 007 round 2, #3531's author identity), Veritas-7 234569343.

Stack shape: E0-E7 share no source file (050 measurement) → seven independent PRs against `dev`,
merged in E-order. Verifiers: typecheck + each layer's named files + layout guard.

DOCEOF; cp /Users/jun/Developer/new/700_projects/opencodex/devlog/_plan/260905_open_work_closeout/051_wp5_reverify.md /Users/jun/Developer/new/700_projects/opencodex/devlog/_plan/260905_open_work_closeout/044_wp4_delivery_record.md /private/tmp/ocx-closeout.xomWAA/wt/devlog/_plan/260905_open_work_closeout/ 2>/dev/null