# 070 — Campaign close-out

Date: 2026-08-02. Branch `codex/wt2-zero-leak-impl` (worktree 616c), executed as 7 work-phases, each a full PABCD cycle with an independent sol-medium adversarial reviewer.

## Outcomes per fix

| Fix | Result | Commits (branch order) |
|-----|--------|------------------------|
| #841 Responses admission | Direct-spill oversized + 256 MiB envelope ceiling + bounded snapshot read (32 MiB, regular files only) + bounded spill replay + UTF-8 snapshot selection | 18289dc9a, 8c3681eb4, eb44a77b4 |
| #847 tool-arg bounds | Per-call scope in the non-stream collector, 502 `upstream_error` everywhere (was 413 ×4), no unbounded no-budget path (default budgets disposed on every stream-death path), cancel-race fixes ×2 | 9c400f5af, 30bf3af94, 318561060, c985863fd |
| #844 Cursor frames | Cursor backlog (O(chunk) append), zero-copy frame handoff (exact 16 MiB boundary holds), raw-used accounting incl. headers, EOF drain-to-quiescence + typed `frame_incomplete`, terminal backlog lease owner, settled-guard for late data | 10388e1b5, e290550a4, 4f1f05948, 956d87153 |
| #845 blob-ID keys | h:/d: domain-separated fixed keys (raw ≤64B passthrough, SHA-256 above), key bytes counted in snapshots and classified with entries, zero-payload evictable | cfdad39a9, e71bd100a, 93b881152, a18d1fdd3 |
| #843 Antigravity keys | Fixed SHA-256 identities over length-prefixed UTF-16 code units (injective for every JS string — UTF-8 folded lone surrogates to U+FFFD and collided sessions), streaming canonical escaping with budget abort, zero-call shell cleanup | 687ae1c9e, dc7104387, 00cf454b1, e448abd12, 2101d50e5, 0ec60234c, d9d2eb373 |
| #840 ACL memos | Ephemeral release (success + both timeout namespaces) at proven absence only; destination-keyed timeouts everywhere; both residual error classes gate the migration release | c8ee26074, a26b379e9, 1c55ca83f, d5b88632a, f7f5b1bda |

## Notable corrections the audit loop caught (would have shipped otherwise)

- The #845 NOOP verdict was WRONG: blob-ID keys were uncounted (audit round 1 refuted it; worst case ~128 GiB of hex keys).
- Copy-based Cursor decode rejected exact 16 MiB payloads (16 MiB + 5 raw + 16 MiB copy > 32 MiB cap); zero-copy handoff fixed it.
- `utf8.encode` folds lone surrogates to U+FFFD — model/session/name key hashes collided cross-session (fixed via UTF-16 framing by the concurrent session e448abd12).
- The ACL mass-swap cleared stable-path anti-restall memos (caught in review; temps and stable paths now have separate release contracts).
- An accidental `go/internal/cli/config_parity.go` commit (over-broad `git add -A` of pre-existing untracked content) was untracked in 2101d50e5.

## Concurrency note

A second session (identity bitkyc08-arch) co-worked this branch throughout: augmenting fixes (e448abd12, 0ec60234c, d9d2eb373, a18d1fdd3), driving the same goalplan/FSM (shared session id — SESSION-IDENTITY-01 fork semantics), and launching the final full-suite run in this worktree. Coordination happened through the goalplan and git history; no conflicting writes were lost.

## Final gate status

- `bun x tsc --noEmit`: PASS (repeated across all cycles).
- `bun run privacy:scan`: PASS (wp1; re-verified wp7 by reviewer).
- Full `bun run test`: **PASS** — 7162 pass, 8 skip, 0 fail, 34,386 expect() calls across 487 files (256.21s), recorded 2026-08-02 on this branch.
- `bun run privacy:scan`: **PASS** (final re-run after the full suite).
- Per-fix focused suites: all green (evidence in goalplan criteria).

## Out of scope (recorded, not silent)

- No RSS/benchmark superiority claims anywhere (comparator cells remain UNKNOWN per the prior zero-leak unit).
- Expected-close Cursor cancellation fixture and 1,024-slot pause/resume fixture (need seams the transport does not expose) — coverage follow-ups, not defects.
- `Object.keys` linear transient in canonicalization (irreducible in JS; documented in d9d2eb373's doc note).
