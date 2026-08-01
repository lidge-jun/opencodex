# Epic Plan — Storage page & Codex session cleanup (issue #42)

Promote issue #42 from a single review doc to a **long-term epic**. This PABCD
cycle is **documentation-only** — no production code. Scope: GitHub phase split,
500-range epic folder, devlog scaffold, and a measured Codex-storage structure doc.

## Work units (this cycle, doc-only)

### 1. Folder promotion (rename)
- `devlog/_plan/issue_042_storage-page-session-cleanup/`
  → `devlog/_plan/500_storage-page-session-cleanup/`
- Rationale: 500-range marks a long-term epic (vs per-issue `issue_NNN_`).
  Use `git mv` to preserve history; keep existing `00_review.md` + `10_epic_plan.md`.

### 2. Decade-numbered devlog scaffold (inside 500_ folder)
- `00_review.md` — existing root-cause/scoping review (keep).
- `10_epic_plan.md` — this file.
- `20_codex-storage-structure.md` — measured storage layout (work unit 4).
- `30_phase1-diagnostics.md` — Phase 1 read-only diagnostics spec (placeholder scaffold + scope).
- `40_phase2-manual-cleanup.md` — Phase 2 C4-high-risk cleanup spec (scaffold + scope).
- `50_phase3-auto-policy.md` — Phase 3 opt-in auto-cleanup spec (scaffold + scope).
  Each phase doc: goal, surface (files), risk class, verification idea, open questions.

### 3. GitHub comment — phase split
Post on issue #42: break into Phase 1/2/3, endorse phased PRs, mark Phase 2/3
as C4 high-risk (irreversible deletion), quarantine-default, link the epic.

### 4. Measured Codex storage structure doc (`20_...`)
Document the ACTUAL on-disk layout on this Mac (CODEX_HOME unset → `~/.codex`):
- `sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl` — **2.4 GB, 858 files**.
  JSONL line types: `session_meta`, `event_msg`, `response_item`.
- `archived_sessions/rollout-*.jsonl` — flat dir, 156 KB (1 file here).
- `state_5.sqlite` (7.1 MB) — `threads` table (236 rows, 1 archived) with
  `rollout_path TEXT NOT NULL`, `archived`, `archived_at`, `tokens_used`,
  `cwd`, `git_*`. This is the JOIN key: each thread row → its rollout JSONL path.
- `logs_2.sqlite` (145 MB) — `logs` table, 78,037 rows, `estimated_bytes` column,
  indexed by `ts`/`thread_id`. Separate lifecycle from sessions.
- WAL/SHM siblings (`*.sqlite-wal`, `*.sqlite-shm`) — live while Codex runs.
- Other buckets: `plugins/` (316 MB), `computer-use/` (57 MB), `shell_snapshots/`
  (30 MB), `cache/` (9.2 MB) — out of scope for session cleanup but relevant to a
  storage diagnostics view.

Key insight for cleanup design: deleting a session is **not** a file delete — it
must reconcile `sessions/*.jsonl` + `threads` row (`rollout_path`, `archived`)
and respect WAL locks while Codex is running.

## Risk / scope
- This cycle: doc-only, near-zero risk. No `src/` or `gui/` code touched.
- Future Phase 2/3 implementation = C4 (irreversible deletion) — separate PRs.

## Verification
- `git mv` preserves history (verify `git log --follow`).
- All decade docs present and non-empty.
- Storage numbers reproducible: `du -sh ~/.codex/sessions`, `sqlite3 state_5.sqlite "select count(*) from threads"`.
- GitHub comment posted (capture comment URL).

## Document map (jawdev structure)

- `00_review.md` — original root-cause/scoping review
- `10_epic_plan.md` — this file (epic overview + map)
- `11_expansion_plan.md` — jawdev expansion rationale
- `20_codex-storage-structure.md` — measured on-disk layout (macOS)
- `21_storage-scanner-module.md` — read-only scanner foundation spec
- Phase 1 (read-only diagnostics, C2):
  - `30_phase1-diagnostics.md` — overview
  - `31_phase1_api-endpoint.md` — `GET /api/storage` (server.ts:1671 template)
  - `32_phase1_gui-page.md` — `Storage.tsx` + App.tsx nav + i18n
  - `33_phase1_tests-fixtures.md` — fixtures + read-only assertions
- Phase 2 (manual cleanup, C4):
  - `40_phase2-manual-cleanup.md` — overview
  - `41_phase2_deletion-data-model.md` — reconciliation sequence
  - `42_phase2_quarantine-restore.md` — quarantine + restore
- Phase 3 (auto-policy, C4): `50_phase3-auto-policy.md`, `51_phase3_policy-engine.md`
- Cross-cutting: `90_open-questions.md`, `95_verification-matrix.md`
