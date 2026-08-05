# 90 — Open questions & decisions log

Consolidated decisions to resolve before each phase ships. Update as answered.

## Phase 1 (diagnostics)
- [ ] Include non-session buckets (plugins 316MB, computer-use 57MB,
      shell_snapshots 30MB) in the view, or scope strictly to session data?
- [ ] Icon: add a dedicated disk glyph to gui/src/icons, or reuse existing?
- [ ] `largest[]` cap length (5? 10?).
- [ ] Cache the scan or recompute per request? (fs.stat walk is cheap.)

## Phase 2 (manual cleanup) — C4
- [ ] `thread_spawn_edges`: cascade-delete children, or block parent delete
      while live children exist?
- [ ] Quarantine retention default (7d / 30d / until manual purge)?
- [ ] Trash under CODEX_HOME (counts toward size) vs OS trash?
- [ ] Active-session guard: archived-only is the rule — confirm UI cannot select
      active sessions at all.

## Phase 3 (auto-policy) — C4
- [ ] Per-provider vs global policy?
- [ ] Notify-after-run vs silent + log entry?
- [ ] Default trigger/target values (only meaningful once enabled).

## Cross-cutting
- [ ] Versioned DB resolution (`state_*`, `logs_*`): always newest suffix —
      confirm no scenario needs older snapshots.
- [ ] Windows path parity (reporter's data was Windows): verify path derivation
      and size math on Windows CODEX_HOME.
