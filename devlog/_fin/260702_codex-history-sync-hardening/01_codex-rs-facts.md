# Codex-rs History Facts (research record)

- **Date:** 2026-07-02 · Source: local clone /Users/jun/Developer/codex/121_openai-codex/codex-rs
  (fresh to 2026-06-28), Codex gpt-5.5 read-only investigation. File:line cites are into that clone.

## The vanish mechanism — CONFIRMED

1. **Default list filter = current provider.** `app-server .../thread_processor.rs::list_threads_common`
   (~:3468): when the client passes no `model_providers` filter, the server substitutes
   `Some(vec![config.model_provider_id])`. SQL (`state/src/runtime/threads.rs::push_thread_filters`
   ~:396) then adds `AND threads.model_provider IN (...)` plus `archived = 0` and
   `preview <> ''`. TUI resume picker does the same (`tui/src/resume_picker.rs` ~:1818).
   → With native config restored (`model_provider_id = openai`-ish), every thread still
   tagged `opencodex` is **invisible in list views**. While opencodex's config is injected,
   the tag is what MAKES threads listable/resumable — the re-tag design is load-bearing.

2. **Pinned bypasses the filter.** No pinned storage in the Rust crates (app-side store);
   by-id reads (`load_persisted_thread_for_read` ~:2142) use `read_thread(include_archived:
   true)` with **no provider filter** → pinned threads resolve by id and survive. Matches
   the user symptom exactly ("everything gone except pinned").

3. **No BUSY retry in the app** (`state/src/runtime.rs::base_sqlite_options` ~:305 —
   WAL + busy_timeout 5 s only; retry exists only in a test). Concurrent writers on
   Windows → silent lock failures on OUR side are the fragile edge (loop-1 hardening
   added our retry + failed:true surfacing).

4. **Startup backfill can rewrite rows from rollouts.** `rollout/src/state_db.rs::init` +
   `rollout/src/metadata.rs::backfill_sessions` scan `sessions/` + `archived_sessions/`,
   fold ALL `session_meta` lines last-writer-wins (`state/src/extract.rs::apply_session_meta_from_item`),
   and UPSERT threads **including model_provider** (`threads.rs` ~:717). Gated by
   `backfill_state.status != Complete` (+lease), so not every start — but any re-backfill
   makes ROLLOUT content authoritative over the DB. Consequence: a restore that fixes only
   the DB but not the rollout meta (or vice versa) can be undone/half-undone later.
   opencodex's dual writes (line-1 in-place patch + trailing append) are therefore both
   necessary; `read_head_summary` (`rollout/src/list.rs` ~:1100) reads ONLY line 1.

5. `session_index.jsonl` is an append-only name index (`rollout/src/session_index.rs`) —
   not the list source; no reconciliation needed on our side (loop-1 assumption stands).

## Design options for loop 2 (decision needed)

- **A. Keep re-tag design** (status quo + loop-1 hardening + `ocx restore`/`restore back`
  manual switch). Residual risk: any failed restore hides history until a retry.
- **B. Stop re-tagging entirely: inject by overriding the `openai` provider id** (keep
  `model_provider_id = openai`, point its base_url at the proxy). Threads never change
  provider → nothing to restore → the whole failure class disappears. Cost: reworks
  provider identity assumptions (usage attribution rows, journal/catalog restore paths,
  auth env wiring); needs a full PABCD design pass and user sign-off.
- **C. Hybrid: restore-on-app-launch guard** — a shim/hook ensuring restore ran before the
  native app reads the DB. Fragile (no reliable app-launch hook cross-platform).

Recommendation: A is shipped; propose B to the user as the durable fix.
