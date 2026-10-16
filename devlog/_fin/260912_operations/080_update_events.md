# Update child terminal-event follow-up

User-requested review repair for PR4343 discussion3995158280. Previous totalsD directs this repair before client usage. Scope remains update cleanup; no live child/process operation locally. Class C4, satisfy-spec, existing credential scope, no time/token bound. Local tests/build/typecheck/install NOT RUN; source review now and hosted final4343 tip later. No merge.

Source finding verified: src/update/job.ts spawnDetachedStart returns child_process.spawn result and records error, while retry ownership watches exit alone. Node child-process contract permits error without exit and guarantees close after failed spawn. Existing cleanup already skips absent PID; the defect is incomplete terminal-event retirement, not proof of a wrong-PID kill on failed spawn.

MODIFY src/update/job.ts: one identity-checked retire handler clears lastChild only if it is still this child, and removes its own exit/error/close listeners to release closure references. Register once on all three. Existing spawn error logging, healthy probe behavior and live-child cleanup remain. This production owner does not call child.kill/send or supply AbortSignal; its error event is spawn failure. No global process supervisor or schema changes.

MODIFY tests/update/update-job.test.ts: extend fake-child retry harness with failed spawn pid undefined, error then close without exit; assert retries continue and no liveness/kill calls, plus own terminal listeners are released. Parameterize late old-child terminal event across exit/error/close to prove object identity protects current live child. Keep live cleanup and healthy controls. A repeated terminal callback is idempotent.

MODIFY structure/runtime.md observed-child paragraph and010 plan with terminal-event semantics. Publish --no-verify, independent source re-audit, reply with exact head and NOT RUN distinction, resolve the authorized review thread. Behavioral acceptance stays OPEN until final hosted CI.

Source: https://nodejs.org/api/child_process.html#event-error and #event-close, opened2026-09-12. Public review: https://github.com/lidge-jun/opencodex/pull/4343#discussion_r3995158280.
