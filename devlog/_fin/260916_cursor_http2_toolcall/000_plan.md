# 260916 — Cursor HTTP/2 toolcall complementary stack

Textual `[TOOL_CALL]` markers still reach Codex as assistant text after #2305
renamed the display alias. That leak is the first stacked PR. Observed
`tokenDetails.maxTokens` is the second. No local suite; hosted CI verifies.

## Loop spec

- Loop archetype: satisfy-spec complementary stack.
- Trigger: user asked to fill Cursor HTTP/2 gaps (Aside + senpi/shunt/jcode)
  with toolcall leak as the primary cause, then stack-PR push `--no-verify`
  without running the local suite.
- Goal: 2 stacked PRs on `dev` (manual chain, not GitHub native stacks).
- Non-goals: `cursor-agent` subprocess, cursor-proxy wholesale, native-exec
  default-on, host-credential import, `bun test` / `bun run test`, merge.
- Verifier: GitHub PR URLs + `gh pr view --json baseRefName,headRefName`.
  Local suite: NOT RUN (user restriction).
- Stop: both PRs exist with parent/child bases.
- Memory artifact: this directory.
- Terminal: DONE (PRs opened) / BLOCKED (push/template) / UNSAFE (exec default-on).
- Shipped (2026-09-16, `gh pr view` bases):
  - L1 https://github.com/lidge-jun/opencodex/pull/4815 `dev` ← `cursor/l1-text-toolcall-quarantine`
  - L2 https://github.com/lidge-jun/opencodex/pull/4816 `cursor/l1-text-toolcall-quarantine` ← `cursor/l2-observed-max-tokens`
- Escalation: live `api2` vs `agentn.global.api5` host cutover.

## Work-phase map

1. wp0 — this roadmap (docs-only).
2. wp1 / 010 — L1 quarantine + promote textual tool calls.
3. wp2 / 020 — L2 persist observed `maxTokens` for the overflow size prior.

Host URL migration (`pleaseai/shunt` → `agentn.global.api5.cursor.sh`) stays
OUT until a live 464/ALPN failure is recorded against current OpenCodex pins.
