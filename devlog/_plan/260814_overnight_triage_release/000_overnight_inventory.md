# 000 — Overnight inventory and candidate matrix

Snapshot taken 2026-08-14 08:33 KST (2026-08-13T23:33Z) from `lidge-jun/opencodex`.
Baseline: `dev` at `040f6db5b`, latest published release `v2.14.2` (2026-08-13T17:48:38Z).

## Scope of "overnight"

Every issue and pull request created or materially updated at or after
`2026-08-13T10:00Z`. That window starts just before the v2.14.1 release and
covers the whole community evening.

## Pull requests in the window

| PR | Base | Draft | Author | Title | Family |
|----|------|-------|--------|-------|--------|
| #1640 | dev | yes | mettete | feat(antigravity): add Gemini 3.7 Flash and refresh CLI fingerprint | F6 |
| #1639 | dev | yes | Wibias | fix: recover provider model discovery for Cline, MiMo Free, xAI | F6 |
| #1638 | dev | no | ardakrt | fix(usage): align 7d/30d range windows to start-of-day boundaries (#1580) | F2 |
| #1637 | dev | no | RobinBially | perf(integrations): depth-cap json configs, harden serializer walk | F1 |
| #1636 | dev | no | ardakrt | fix(server): maxRequestBodySize 256 MiB on Bun.serve (#1601) | F2 |
| #1634 | dev | no | Vincent-HD | fix(cursor): harden structured-edit apply_patch conversion (#1388) | F3 |
| #1632 | dev | no | RobinBially | fix(integrations): json sibling edit is stale, not conflict | F1 |
| #1628 | dev | yes | Wibias | feat(lab): CL-10 public evidence trust core | F7 |
| #1627 | dev | yes | luvs01 | fix(cli): preserve service command exit failures | F5 |
| #1626 | dev | yes | luvs01 | fix(windows): remove native service on fresh scheduler install | F5 |
| #1625 | dev | yes | luvs01 | fix(codex): restore unprobeable launcher on shim rollback | F5 |
| #1624 | dev | yes | luvs01 | feat(codex): add quota recovery policy contract | F7 |
| #1623 | dev | no | Wibias | fix(codex): harden routed apply_patch contracts | F4 |
| #1617 | dev | yes | luvs01 | fix(packaging): skip filesystem links during mode normalization | F5 |
| #1615 | dev | yes | jbaehova | fix(cursor): expose Grok 4.6 xhigh Fast | F3 |
| #1613 | dev | yes | luvs01 | fix(antigravity): persist replay expiry | F4 |
| #1609 | dev | yes | LeoWang331 | fix(config): harden preserved rollback snapshots | F7 |
| #1608 | dev | yes | luvs01 | fix(codex): bound upstream websocket buffering | F4 |

## Issues in the window

| Issue | Author | Title | Family |
|-------|--------|-------|--------|
| #1635 | RobinBially | Non-json client configs: no nesting-depth cap, silent big-integer rounding | F1 |
| #1631 | RobinBially | OpenCode integration dead-ends in permanent `conflict` after unrelated edit | F1 |
| #1619 | estelledc | Add DeepSeek Harness as a first-class client integration | F8 |
| #1616 | carlosqwqqwq | OpenCode Zen as web-search sidecar backend | F8 |
| #1612 | nbsp1221 | Docker foreground start blocks native requests | F5 |
| #1601 | nekonade | Bun.serve has no maxRequestBodySize: empty-body 413 | F2 |

Already closed overnight by the maintainer: #1611, #1610, #1614, #1605, #1604.
Already merged overnight: #1633, #1630, #1622, #1621, #1620, #1603, #1602.

## Maintainer comment coverage before this unit

`gh api repos/lidge-jun/opencodex/issues/<n>/comments` filtered to `lidge-jun`
returns `0` for every item above except #1608 (`1`). The overnight backlog is
effectively uncommented, so the whole set is in scope for WP2.

## Merge-candidate matrix

Only non-draft PRs based on `dev` are merge candidates. Draft PRs are review-only
in this cycle — the repository's contributor-draft gate owns their readiness.

| PR | mergeable / state | CI | Closes | Candidate |
|----|-------------------|----|--------|-----------|
| #1636 | MERGEABLE / UNSTABLE | required green, CodeRabbit SUCCESS | #1601 | yes |
| #1638 | MERGEABLE / UNSTABLE | required green, CodeRabbit SUCCESS | #1580 | yes |
| #1634 | MERGEABLE / UNSTABLE | required green, CodeRabbit SUCCESS | #1388 | yes |
| #1632 | MERGEABLE / UNSTABLE | required green, CodeRabbit SUCCESS | #1631 | yes |
| #1637 | MERGEABLE / UNSTABLE | CodeRabbit PENDING at snapshot | #1635 | conditional |
| #1623 | MERGEABLE / UNSTABLE | full matrix green, macos pending | — | conditional |
| #1618 | MERGEABLE / CLEAN | full matrix green | — | yes |
| #1568 | MERGEABLE / CLEAN | full matrix green | — | security review first |

`UNSTABLE` here reflects a still-running or neutral non-required check, not a
failure; each candidate is re-verified at WP4 immediately before its merge.

## Notes that constrain later phases

- #1637 and #1632 touch the same integrations surface and both come from
  RobinBially. They must be ordered and re-verified against each other, because
  the second to merge needs its base refreshed.
- #1568 changes release checkout credential handling. Per `AGENTS.md` that is a
  security-boundary change and cannot ride a routine merge decision.
- #1607 targets `codex/routed-tool-discovery-devlog`, not `dev`. It is a stacked
  child and stays out of the merge set until its parent #1606 lands.
