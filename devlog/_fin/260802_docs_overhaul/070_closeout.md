# 070 — close-out record

Terminal outcome: **DONE** (2026-08-02, branch `dev`, local commits only).

## What landed

| Commit | Content |
|--------|---------|
| `35017b8b` | This roadmap unit (000 + 001-003 research + 010-060 decade docs) |
| `55cf8d22` | README compact rewrite (573 → 211 lines): human path (`ocx start`/`ocx service` + localhost:10100 dashboard), agent path (+ `ocx init`), star-prompt agent-consent note |
| `4abc8a9b` | Sidebar + Header/Landing nav: image/video bridge orphan fix |
| `3fd27a92` | New English pages: `getting-started/for-agents`, `guides/combos`, `reference/proxy-formats`, `reference/management-api` |
| `7fdb2cb8` | `reference/configuration` split (hub + 4 domain pages), `reference/cli` split (hub + 3 family pages), sub-agent-surface beginner restructure, codex-integration/codex-app-models dedupe, English pin refresh |
| `fb3c220a` | ko/ja/ru/zh-cn full locale sync (24 files per locale: 17 new + 6 re-synced + 1 readme quick-start), README-frontier 5-locale fix, providers.md pin fix in all trees |
| `7398ae91` | README: restore exact test-enforced Bun requirement paragraph |

## Verification evidence (all fresh, 2026-08-02)

- `bun run test` → 6864 pass, 8 skip, 0 fail (478 files).
- `bun run typecheck` → exit 0.
- `bun run privacy:scan` → passed.
- `cd docs-site && bun run build` → exit 0, 206 pages (baseline was 151).
- Preview render smoke → 6/6 probed pages HTTP 200 with expected content
  (`/guides/combos/` carries `combo_unavailable`/`unreadable_encrypted_agent_task`;
  `/ko/guides/combos/` renders Korean).
- Locale parity: 33/33 English page paths have ko/ja/ru/zh-cn counterparts.
- Stale pins: zero `v2.7.1`/`v2.7.2` hits remain in the docs tree.

## Notes

- All subagent lanes ran `gpt-5.6-sol` / `reasoning_effort: medium` per the user's
  routing instruction (a deliberate deviation from REVIEW-DECORRELATE-01's
  different-family reviewer preference, user-directed).
- Two early A-gate reviewer dispatches returned no output within ~6 minutes each
  and were retired per DISPATCH-RETIRE-01; the main agent performed the direct
  independent audits instead (8/8 anchors verified live).
- "3d proxy 형식" had no literal codebase counterpart; it was documented as the
  proxy wire-format reference (`reference/proxy-formats.md`).
