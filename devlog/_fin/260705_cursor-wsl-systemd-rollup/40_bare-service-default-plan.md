# Bare `ocx service` Default Plan

## Loop Spec

- Archetype: spec-satisfaction repair.
- Trigger: user asked for `ocx service` with no subcommand to set up/register the service on every OS.
- Goal: make bare `ocx service` perform the same install/update/start path as `ocx service install` on macOS launchd, Linux systemd user units, and Windows Task Scheduler.
- Non-goals: do not change `ocx service start` semantics; do not add new service managers; do not alter provider auth/token behavior.
- Verifier: targeted service/help tests, docs build, typecheck, full Bun test suite, and `git diff --check`.
- Stop condition: no-subcommand service path is implemented, documented in README and docs-site locales, and verified.
- Memory artifact: this devlog entry plus final command evidence.
- Expected terminal outcome: DONE.
- Escalation condition: if install/start semantics differ by platform enough that a no-subcommand default could perform destructive work or require user choice.
- Resource bounds: local filesystem and test commands only; no remote deployment; one work-phase.

## Plan

1. Normalize `serviceCommand(undefined)` to the existing `install` path.
2. Keep `start` as installed-service-only so Linux still reports the missing systemd unit with the explicit `ocx service install` hint.
3. Update CLI usage/help so `ocx service` is documented as the install/update/start default.
4. Update README and docs-site English/Korean/Chinese CLI reference docs.
5. Add/adjust tests for service command dispatch and help usage text.
6. Run focused and full verification gates.
