# Effort-clamp observations

`src/codex/catalog/effort.ts` projects each catalog onto the selected Codex runtime's supported
efforts. This projection runs on each sync; its diagnostic is an observation, not a heartbeat.

`persistEffortClamp` in `src/codex/runtime.ts` compares the existing diagnostic's runtime path and
version and the order-independent sets of removed efforts and affected models before writing.
An unchanged observation preserves file bytes and its timestamp and returns false; a new nonempty
observation is atomically persisted and returns true. An empty or absent diagnostic clears the
record. No schema or on-disk path changes.

The catalog caller emits the clamp notice only for a changed persisted observation. It still calls
`onEffortClamp` for every nonempty projection. Clearing a clamp allows a later recurrence to notify.
Injected command-candidate fixtures do not persist diagnostics and keep per-call notifications.
The sync clamp notice does not suggest doctor: supported-effort projection is not a broken
installation. Runtime-selection failure and status diagnostics keep their existing behavior.

`tests/codex-integration/codex-clamp-notice.test.ts` checks unchanged persistence, changed identity
fields, order-independent sets, callbacks, repeat notices, and clearing/recurrence with fake CLI
responses and disposable homes. It does not run the native CLI or verify live client rendering.

> Decision record: [ADR-7004](decisions/ADR-7004-effort-clamp-observation.md)
