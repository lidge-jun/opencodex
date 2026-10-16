# 087 — p3229 landing (and the #3239 regression it exposed)

- Carry PR #3241 (branch `codex/260902-p3229-carry`): the #3229 two-file diff re-applied on the
  current tip with `Co-authored-by`. Admin squash-merge → `b54508c8c` on `dev`; ancestry
  proven. #3229 closed as landed via maintainer.
- Reviewer (xai/grok-4.6) pass: `CODEX_ORIGINATORS` is admission-only; issuer/client/token/
  account/proxy-secret gates after it unchanged; `codexless_agent` is Codexless's real
  `clientInfo.name`. Red-without-fix proven on `1c8278b4d`.
- **Regression caught by this cycle's check**: on `744d12d02` (#3239, the p3228 carry)
  `tests/agent-task-recovery-security.test.ts` was 2/13 (13/13 at `1c8278b4d`). The synthesized
  `DEFAULT_SUBAGENT_MODELS` chain fired in the first fallback pass, rerouting an unreadable
  encrypted spawn to native before `recoverEncryptedAgentTask` ran, so recovery's security
  gates never executed. Repaired as work-phase `r3239`: PR #3240 → `7f00d0eee` gates the
  synthesized chain on `config.agentTaskRecovery?.enabled !== true`; unit regression red
  without the guard; security file 14/14 again. This is exactly the "CI behind the work, repair
  as its own cycle" contract — the focused check on the next PR caught it before CI did.
- Checks on the landed tip: recovery security 14 pass / 0 fail; typecheck; privacy.

