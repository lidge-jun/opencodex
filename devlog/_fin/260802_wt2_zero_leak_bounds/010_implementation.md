# wt2 — Implementation roadmap (re-verify at P before building)

Branch `codex/wt2-zero-leak` off `dev`. One PABCD cycle per PR-family cluster; all six cite tracker #820.

## Landing order (dependency-ordered, not effort-bucketed)

1. **#841 Responses state byte cap** — foundation: `src/responses/state.ts` admission accounting is shared by snapshot load; other bounds do not depend on it, but it is the smallest contract to verify the byte-accounting pattern the others reuse.
2. **#847 Streamed tool-argument bounds** — `src/adapters/openai-responses.ts` + `src/server/responses/core.ts` (+ Chat outbound conversion). 4 MiB SSE record cap; 8 MiB/call, 32 MiB/turn.
3. **#844 Connect frame buffering** → 4. **#845 blob-store** — Cursor lane; #845's pinning assumes #844's incremental frame completion.
5. **#843 Antigravity replay retention** — independent; SHA-256 identities + LRU.
6. **#840 Windows ACL memo release** — `src/config.ts:184-187` (`atomicWriteFileAsync` memo keyed by stable destination). LAND LAST: wt4's realpath fix (#869) also touches this function; coordinate so wt4 lands first or rebase over it.

## Per-PR acceptance pattern (apply to each)

1. Oversized input fails as a typed error without emitting a completed tool item / clean DONE marker / acknowledged store. Activation: fault-injection test feeding an over-cap payload, asserting the typed error and the absent success side-effect.
2. At-cap valid input still succeeds. Activation: boundary test at exactly cap and cap−1.
3. RSS-style retention proof: after N cycles of oversized + valid traffic, store size stays under the stated bound. Activation: focused harness test (reuse the prior zero-leak unit's measurement approach; `devlog/_plan/260801_zero_leak_state_stores/`).
4. Eviction never removes entries pinned by an active request (#845) / prior valid mappings survive an oversized replacement (#843) / unrelated valid chains survive rejection (#841).

## Verification gate

`bun run typecheck` + `bun run test` full suite (shared stores = full suite per AGENTS.md). No RSS superiority claims in docs/release notes — comparator cells remain `UNKNOWN`.

## Cross-worktree coordination (wt3 Bug B)

wt2 #847 and wt3 Bug B (#860) both touch `src/adapters/openai-responses.ts` and `src/server/responses/core.ts`. Different code paths (wt2: SSE record/tool-argument caps; wt3: `service_tier` injection at `core.ts:803-807`), so either order lands — but the second lane MUST rebase over the first and re-run its fault-injection tests. wt4's realpath fix (#869) precedes wt2 #840 as already ordered above.
