# 030 — carry #5009 — Zhaofeng Li <lzfxxx@gmail.com>

Files: src/server/responses/agent-task-recovery.ts (FOLLOWUP_TASK, FINAL_ANSWER with optional Task name; author===sender check kept; recipient cross-check when task name present; JSON tuple cache key including recipient; foreign-family echo rejected), src/server/responses/encrypted-payload.ts (guard regex covers four types), structure/subagents.md, docs-site subagent-v1-default.md, configuration/agents.md, providers.md (check locales), tests/server/agent-task-recovery.test.ts, server-agent-task-recovery-replay.test.ts, v2-agent-message-failfast.test.ts, tests/helpers/agent-task-recovery.ts.
Method: squash diff from merge-base e9643875f0 applied with -3; check caps on test files (agent-task-recovery.test.ts +161).
Keep: recoveryAdmission before cache; agentTaskRecovery.enabled default-off.

## wp3 P (executable)
- /tmp/l4-5009.diff (squash from merge-base e9643875f0, 10 files) passes git apply --check -3 on HEAD af0a3713ea. Test files are below the 2000-line ratchet threshold (1128/438/907 before +163/+33/+48).
- DeepSeek writer updates item 4 of guides/subagent-v1-default.md in fr, ja, ko, ru, tr, zh-cn, zh-tw: they still say recovery loses message-type follow-ups, which contradicts the carried English text.
- Focused: bun test tests/server/agent-task-recovery.test.ts tests/server/server-agent-task-recovery-replay.test.ts tests/server/v2-agent-message-failfast.test.ts tests/responses/*encrypted* (rg for encrypted-payload tests).
