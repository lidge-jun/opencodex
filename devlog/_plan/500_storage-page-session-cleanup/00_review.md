# Issue #42 — Add Storage page for Codex session usage and cleanup policy

- **Reporter:** 0disoft (ZeroDi)
- **URL:** https://github.com/<repo>/issues/42
- **Type:** Feature request (dashboard page + phased cleanup) — high-risk Phase 2/3
- **Severity:** Low (Phase 1 diagnostics) → High-risk (Phase 2/3 deletion).
- **Status:** Scoping recommendation below (NOT implemented — documentation phase).

## Report summary

Codex session data grows silently (example Windows buckets: archived sessions
~3.1 GB, active ~1.3 GB, logs sqlite ~1.1 GB, plus attachments/manifests). The
dashboard does not show where storage goes or offer guided cleanup. Reporter
proposes a phased Storage page: Phase 1 read-only diagnostics; Phase 2 manual
archived-session cleanup with preview/confirmation; Phase 3 optional opt-in
auto-cleanup policy. Flags that deletion is not a simple file delete (rollout
JSONL, `state_*.sqlite` thread rows, attachments, deletion manifests, DB locks
while Codex is active).

## Current state in the repo (investigation)

- GUI pages today: `Dashboard`, `CodexAuth`, `Logs`, `Usage`, `Models`,
  `Subagents`, `Providers` (`gui/src/pages/`). **No Storage page.**
- Path foundation exists: `src/codex-paths.ts` (`CODEX_HOME`, config paths).
  A storage scanner would build on this plus the Codex sessions/rollout layout.
- Backend management API lives in `src/server.ts` (`/api/*`); a new
  `/api/storage` read endpoint would feed the page.
- No existing Codex session storage scanner / size aggregator.

## Scoping recommendation

Strongly endorse the reporter's phased approach. Ship **Phase 1 read-only
diagnostics first**; treat deletion (Phase 2/3) as **C4 high-risk** (irreversible
data deletion) requiring explicit confirmation, preview, and a safe default of
quarantine/trash over permanent delete.

### Phase 1 — storage diagnostics (recommended first PR)
- New `/api/storage` (read-only) aggregating: active sessions, archived sessions,
  logs DB / WAL, attachments, remote attachments, deletion manifests, total.
- Per bucket: size, count, oldest, newest, largest few items (capped).
- New `gui/src/pages/Storage.tsx` rendering a compact breakdown; register it in
  the dashboard nav next to Usage/Logs.
- Read-only only — no delete controls in this phase.

### Phase 2 — manual archived cleanup (separate, high-risk PR)
- Preview-first: slider/presets (10/25/50%) over oldest archived conversations,
  preview button, confirmation modal showing estimated count + bytes.
- Default to quarantine/trash; permanent delete only behind an explicit checkbox.
- Active sessions stay read-only.
- Deletion must account for the full data model: rollout JSONL files,
  `state_*.sqlite` thread rows + rollout paths, linked attachments, deletion
  manifests/audit trail, and DB locks while Codex is running (skip/queue when
  locked; never corrupt an in-use sqlite).

### Phase 3 — optional auto-cleanup policy (separate PR, default OFF)
- Opt-in threshold ("archived > N GB") + target ("reduce to N GB" / "oldest N%")
  + schedule (startup/daily/weekly/manual) + deletion mode (quarantine/permanent)
  + last/next-run and freed-bytes summary. Batch policy, not per-session.

## Answers to reporter's open questions

- Manage deletion vs diagnostics-only: start **diagnostics-only**; add deletion
  later behind preview + confirmation, default quarantine.
- `logs_2.sqlite`: show on the Storage page as diagnostics; clean it separately
  from session cleanup (different lifecycle/locking).
- Permanent deletion: support only behind an explicit checkbox; **quarantine/trash
  should be the default** cleanup mode.
- Implementation order: yes to a phased PR starting with read-only diagnostics.

## Verification approach

- Phase 1: unit-test the size/age aggregation against a fixture Codex home; verify
  `/api/storage` numbers and the page render. Confirm read-only (no writes).
- Phase 2/3: test preview accuracy (count/bytes) and that deletion handles
  sqlite-locked-while-running safely; test quarantine round-trip/restore.

## Effort & risk

- Phase 1: medium effort, low risk (read-only scanner + page).
- Phase 2: high effort, **high risk** (irreversible deletion across JSONL + sqlite
  + attachments) — requires preview, confirmation, quarantine default, lock
  safety, and a regression suite before shipping.
- Phase 3: medium effort on top of Phase 2; default OFF.
- Suggested reply: accept Phase 1 (read-only) now; require Phase 2/3 to land as
  separate, carefully-reviewed PRs with quarantine as the default cleanup mode.
