# 005 — Audit round 1 (wp1 roadmap)

Reviewer: independent subagent, Claude Opus 5 (decorrelated from the planning model).
Verdict: **GO-WITH-FIXES (blockers=4)**. Disposition of each item:

| # | Finding | Disposition | Where folded |
|---|---|---|---|
| 1 | `tests/server-combo-failover-e2e.test.ts:824-846` uses `toEqual` on complete row literals; the new keys would fail six assertions | folded | 000 consumer list; 010 file map (MODIFY → `toMatchObject` + explicit `is_combo` absence) |
| 2 | Plan's focused test list would not have caught #1 under the no-full-suite constraint | folded | 010 accept criteria now enumerate all nine raw-list consumers |
| 3 | Config-key verification pointed at the `src/types.ts` barrel | folded | 010 cites `src/types/provider.ts:362/364/440/442`; fallback clause deleted |
| 4 | Base SHA `6fe46312c` stale; `origin/dev` is `85f7ef92a` | folded | 000 + 010 re-anchored; branch created from `origin/dev` |
| n1 | `anthropic_messages` is safe only because OpenAI-family types are also advertised | folded | 010 helper comment + unit-test line |
| n2 | Prefer a static import of the helper over `await import` | folded | 010 index.ts diff |
| n3 | DEV-STACK-01: two-layer stack justified on revert independence | accepted | 020 unchanged |

Verifier evidence at this round: `bun run typecheck` exit 0; `bun test tests/grok-models-effort-list.test.ts`
5 pass (starts a server and fetches `/v1/models`); `bun run privacy:scan` fails on `tests/provider-key-store.test.ts:41-42`
at baseline dev, unrelated to this unit (verified by stashing the unit and rerunning).
