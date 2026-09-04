# 030 — Live verification record

Verified against the worktree GUI running on Vite at `:5199` with
`OPENCODEX_PROXY_TARGET=http://127.0.0.1:10100`, so the panel renders this
branch's code against the live proxy's real account data (v2.43.0, pid 32347).

## wp1 — page-head clipping

Measured rects, `.main-inner` right edge vs the rightmost button edge:

| viewport | container right | worst button right | overflow |
|---|---|---|---|
| 850px before | 840 | 944 | **yes — clipped** |
| 850px after | 840 | 804 | no |
| 700px after | 690 | 610 | no |

At 1440px the title and the action cluster still share one row 26px tall
(`titleTop == actionsTop`), so the wide layout did not change.

Before — "할당량 새로고침" sliced by the viewport edge:

![before](assets/010_before_850_clipped.png)

After — the cluster wraps to a second right-aligned line:

![after](assets/010_after_850_wrapped.png)

## wp2 — the Codex mark

Live DOM of the nav row: `viewBox="0 0 32 32"`, `stroke="currentColor"`, one
path, rendered at 17x17 — the icon set's CSS sizing applies unchanged to the
32-unit box.

![light](assets/020_nav_codex_mark_light.png)
![dark](assets/020_nav_codex_mark_dark.png)

## Mechanical gates

`bun run typecheck`, `bun run lint:gui`, `bun run build:gui`, and the focused
`gui/tests/sidebar-codex-set.test.ts` (2 pass). The repository-wide suite was not
run — operator constraint for this unit.
