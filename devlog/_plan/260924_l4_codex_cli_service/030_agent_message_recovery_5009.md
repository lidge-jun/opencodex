# 030 — carry #5009 — Zhaofeng Li <lzfxxx@gmail.com>

Files: src/server/responses/agent-task-recovery.ts (FOLLOWUP_TASK, FINAL_ANSWER with optional Task name; author===sender check kept; recipient cross-check when task name present; JSON tuple cache key including recipient; foreign-family echo rejected), src/server/responses/encrypted-payload.ts (guard regex covers four types), structure/subagents.md, docs-site subagent-v1-default.md, configuration/agents.md, providers.md (check locales), tests/server/agent-task-recovery.test.ts, server-agent-task-recovery-replay.test.ts, v2-agent-message-failfast.test.ts, tests/helpers/agent-task-recovery.ts.
Method: squash diff from merge-base e9643875f0 applied with -3; check caps on test files (agent-task-recovery.test.ts +161).
Keep: recoveryAdmission before cache; agentTaskRecovery.enabled default-off.

