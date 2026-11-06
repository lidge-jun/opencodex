# `wp5` — PR #8237 Codex Review Fixes (Write-Ahead Journal, Multiline TOML Tracking, & Feature Restoration)

> Continuity handoff (`LOOP-CONTINUITY-01` from `wp4` D at `fec8761583`): PR #8237 opened against `dev` with 13 CI checks green (`gates`, `structure gate`, `docs site build`, `docker smoke`, `npm-global`, `enforce-target`, `hygiene`, etc.) and received 3 valid automated Codex review findings on `native/ocx-child/` (`PRRT_kwDOS-0Gi860orZz`, `PRRT_kwDOS-0Gi860orZ4`, `PRRT_kwDOS-0Gi860orZ7`). Architect consultation: preserves `ARCH-03` & `ARCH-06` (`000_roadmap.md` §3).

- **Phase ID**: `wp5` (depends on `wp4`; satisfies `c-5`)
- **Header dependencies**:
  - Updates `ChildJournalV1` & `apply_attach_or_sync` & `offline_detach` (`native/ocx-child/src/journal.rs`), `ChildInjectedLedger` & `mark_structural_lines` & `upsert_table_bool` & `strip_features_ledger` (`native/ocx-child/src/toml_surgeon.rs`), and adds shared conformance vectors in `tests/fixtures/link/ocx-child-conformance.json` + `tests/clients/link-ocx-child-conformance.test.ts` + `native/ocx-child/tests/conformance.rs`.
- **Scope**:
  - **IN**: `native/ocx-child/src/journal.rs` (MODIFY), `native/ocx-child/src/toml_surgeon.rs` (MODIFY), `native/ocx-child/tests/conformance.rs` (MODIFY), `tests/fixtures/link/ocx-child-conformance.json` (MODIFY), `tests/clients/link-ocx-child-conformance.test.ts` (MODIFY), `devlog/_plan/261107_ocx_child_ephemeral_link/001_audit_and_status.md` (MODIFY).
  - **OUT**: Merging PR #8237.

## 1. Exact Fixes

1. **Finding #1 (`journal.rs:296`, P1 — Write-ahead recovery journal before overwriting Codex files)**:
   - Split `prepare_codex_models_cache(cache_path, catalog_models) -> Result<(Option<Vec<u8>>, String), String>` so the target `models_cache.json` bytes and SHA-256 digest are computed *before* mutating any file in `$CODEX_HOME`.
   - Call `write_journal(&paths.journal_file, &journal)?` **first** (before writing `catalog_path`, `catalog_backup_file`, `cache_path`, and `config_path`).
   - Preserve each file's last known-owned on-disk SHA-256 (`previous_injected_config_sha256`, `previous_catalog_sha256`, `previous_models_cache_sha256`) across consecutive interrupted syncs without adopting external edits as owned, and treat `pre_attach_config_sha256` / `previous_*_sha256` under `untouched_by_external_writer` as `ExactRestore` during `offline_detach` (removing Child-created `models_cache.json` even if a sync interrupted before the next cache write).
2. **Finding #2 (`toml_surgeon.rs:199`, P1 — Multiline TOML string/collection boundary tracking)**:
   - Port `markStructuralLines` from `src/codex/toml-source-lines.ts:158-223` into `mark_structural_lines(lines: &[&str]) -> Vec<bool>` tracking `"""..."""` (with backslash escapes and 3–5 closing quotes), `'''...'''` (3–5 closing quotes), `[...]` depth, and `{...}` depth.
   - Gate every structural scan (`root_end_index`, `detect_unowned_root_routing_conflict`, `external_codex_model_provider`, `insert_root_lines`, `strip_owned_root_urls`, `strip_owned_web_search`, `ensure_root_web_search`, `set_root_catalog_path`, `strip_opencodex_catalog_path`, `upsert_table_bool`, `apply_subagent_defaults`, `strip_subagent_defaults`, `strip_features_ledger`, `surgical_detach_config`, and blank-line collapsing) on `structural[i] == true` so `[Important]` or `openai_base_url = ...` inside multiline `developer_instructions` is untouched data.
3. **Finding #3 (`toml_surgeon.rs:709`, P2 — Restore overwritten user `[features]` values on surgical detach)**:
   - Add `#[serde(default)] pub prior_user_fast_mode_line: Option<String>` and `#[serde(default)] pub prior_user_multi_agent_v2_line: Option<String>` to `ChildInjectedLedger`.
   - When `upsert_table_bool` overwrites an existing `fast_mode` or `multi_agent_v2` line in `[features]`, return `Option<String>` of the overwritten line; on first write (`prior_ledger` had `wrote_fast_mode == None`), store that line in `prior_user_fast_mode_line` (preserving it across subsequent `sync` calls).
   - In `strip_features_ledger`, when the current line in `[features]` still matches `wrote_fast_mode` / `wrote_multi_agent_v2`, replace it with `prior_user_*_line` if `Some(...)` (and drop it only when `None`), preserving any post-attach user modification.

## 2. Activation Scenarios (`C-ACTIVATION-GROUNDING-01`)

- Add 2 new shared golden vectors to `tests/fixtures/link/ocx-child-conformance.json` (verified in both `bun test` and `cargo test`):
  1. `multiline_developer_instructions_bracket_line`: `developer_instructions = """\n[Important]\nKeep literal\n"""\n` -> attach inserts root keys *after* the closing `"""` (not inside the string!), and surgical detach after `#1798` comment strip restores cleanly.
  2. `restore_overwritten_user_features_on_surgical_detach`: pre-attach `[features]\nfast_mode = false\nmulti_agent_v2 = true\n` -> attach sets `fastMode: true, multiAgentMode: "v1"` -> user appends `[extra]\nk = 1\n` -> surgical detach restores `fast_mode = false` and `multi_agent_v2 = true` while keeping `[extra]`.
- Add `multiline_features_agents_and_blank_lines_surgical` to shared conformance vectors (`[features]`, `fast_mode = true`, repeated blank lines, and `[agents]` inside multiline string with `fastMode` and `subagentDefaults` active).
- Add deterministic `JournalWriteFault` (`AfterJournalWrite` and `AfterCatalogWrite`) consecutive-failed-sync tests in `native/ocx-child/tests/conformance.rs` verifying `ExactRestore` of `config.toml` and `pre_attach_catalog` plus removal of previous injected `models_cache.json`.

## 3. Verifiers

- `cargo fmt --manifest-path native/ocx-child/Cargo.toml --check` & `cargo clippy --locked --manifest-path native/ocx-child/Cargo.toml --all-targets -- -D warnings`
- `cargo test --locked --manifest-path native/ocx-child/Cargo.toml` & `cargo build --release --locked --manifest-path native/ocx-child/Cargo.toml`
- `bun test tests/clients/link-ocx-child-conformance.test.ts tests/clients/link-ocx-child-e2e.test.ts` & `bun run typecheck` & `bun run privacy:scan`
