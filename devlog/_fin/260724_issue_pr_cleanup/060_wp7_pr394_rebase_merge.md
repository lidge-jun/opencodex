# WP7 — #394 rebase on dev + merge (060)

PR #394 `fix(anthropic): guard premature no-tool completions`. State:
CONFLICTING/DIRTY vs dev (needs rebase). CI on head: enforce-target + label +
CodeRabbit pass; full matrix not visible while conflicting.

Files: `src/server/responses/core.ts` (+131/-2),
`src/server/responses/terminal-guard.ts` (+230/-0 new), `src/bridge.ts` (+17),
`src/types.ts` (+2), `docs-site/.../adapters.md` (+4),
`tests/terminal-guard-server.test.ts` (+80), `tests/terminal-guard.test.ts` (+204).

Conflict source (CORRECTED per A-gate blocker #3): #394 is ALREADY
`CONFLICTING/DIRTY` against current `dev` while #390 is still open — so #390 is
NOT the cause of the present conflict. The existing conflict is against dev head
directly and must be identified at rebase time (`git rebase origin/dev` then read
the actual conflicted files). #390-before-#394 ordering is still correct because
both touch `src/server/responses/core.ts` and doing #390 first avoids a second
rebase — but re-evaluate ALL conflict files after #390 lands, not just core.ts.

Actions:
1. After #390 lands, rebase #394 head onto dev; resolve the `core.ts` conflict
   (keep #390's quota-clear and #394's terminal-guard hook; adjacent, not
   mutually exclusive).
2. `bun run typecheck` + `bun test tests/terminal-guard*.test.ts` green.
3. A-gate: Sol reviewer confirms the terminal-guard does not falsely terminate
   legitimate tool-less completions and the anthropic path is correct.
4. head is `duansy123:codex/anthropic-terminal-guard` (external fork). Pushing a
   rebase to their branch needs their permission; default to a rebase-request
   comment or REBUILD_ON_DEV under a `codex/` branch unless maintainer says take
   over.
5. Merge to dev when clean.

Terminal: DONE = merged SHA. BLOCKED if conflict resolution needs author push
access we lack (external fork) -> post rebase-request comment.
