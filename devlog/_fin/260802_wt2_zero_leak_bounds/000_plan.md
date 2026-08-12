# wt2 — Zero-leak state-store bounds (research)

Worktree: `/Users/jun/.codex/worktrees/260802-wt2-zero-leak` (branch `codex/wt2-zero-leak`, off `dev`).
Tracker: issue #820. These six PRs are the confirmed retained-state/memory-leak family; all are must-fix regardless of PR quality.

## Scope

| PR | Defect | Bound introduced (per PR body, re-verify) |
|----|--------|-------------------------------------------|
| #847 | Unbounded streamed tool-argument memory (SSE records can arrive without delimiters) | 4 MiB shared SSE record cap; 8 MiB per-call / 32 MiB per-turn tool-arg cap; oversized calls fail as typed upstream errors |
| #845 | Unbounded Cursor blob-store memory | 16 MiB/blob, 64 MiB total, 4096 entries; pin active-request blobs; LRU evict only unpinned; protobuf error for rejected `setBlobArgs` |
| #844 | Unbounded Cursor Connect frame buffering | 32 MiB inbound payload cap; reject oversized declared length at the 5-byte header; complete one pending frame incrementally; fail turn on EOF with incomplete frame |
| #843 | Unbounded Antigravity replay retention | SHA-256 fixed-size cache identities; 64 KiB/signature, 256 calls + 2 MiB/session, 32 MiB global; LRU + 1h TTL preserved |
| #841 | Responses continuation state not byte-accounted | UTF-8 byte measurement before admission; reject single entries > 64 MiB store budget; same rule on snapshot load |
| #840 | Windows ACL temp-path memos never released | Release memos once ephemeral file proven absent; key atomic-write timeouts by stable destination |

- Severity: high — all six let a long-running proxy grow RSS without bound; the Windows ACL leak (#840) was confirmed by live measurement in the prior zero-leak unit (`devlog/_plan/260801_zero_leak_state_stores/`).
- Grounding entry points: `src/responses/state.ts` (#841), Cursor Connect/blob code paths (#844/#845), `src/config.ts:184-187` (`atomicWriteFileAsync` timeout memo keyed by destination, #840), SSE/tool-argument streaming in `src/adapters/openai-responses.ts` + `src/server/responses/core.ts` (#847).

## Key review questions for the executing session

- Do the caps fail as typed upstream errors without emitting a completed tool item or a clean Chat DONE marker (#847)?
- Do pinned blobs leave a safe-capacity failure mode rather than deadlock (#845)?
- Do the six PRs overlap in shared helpers? Order of landing matters; rebase chain per PR body cross-references (#840-#845-#847 all cite #820).
- Benchmark cells: prior unit recorded 16/16 scoped PASS but competitor cells remain `UNKNOWN` — do not write superiority/RSS claims into docs or release notes.

## Claim ledger

| # | Claim | Source | Status |
|---|-------|--------|--------|
| 1 | Six stores are unbounded on current dev | #820 tracker + PR bodies #840-#847 | code-verified (prior unit) |
| 2 | Windows ACL memo leak reproduced by measurement | `devlog/_plan/260801_zero_leak_state_stores/` | verified (prior unit) |
| 3 | Proposed caps match provider payload realities (32 MiB frames etc.) | PR bodies; no external source needed | unverified — executing session must spot-check |

## Out of scope

- RSS/benchmark superiority claims.
- Changing TTL semantics beyond what each PR states.
