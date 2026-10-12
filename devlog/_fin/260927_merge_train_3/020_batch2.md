# B2 — non-GUI bug fixes from luvs01 and mdwsk88

Base: `dev` `8923ad9835` (after B1 #6059). Branch `codex/train3-b2`.

| PR | Author | Change | Kimi verdict | Folded |
|---|---|---|---|---|
| #6057 | luvs01 | Compaction-routing fixture drains response state and closes the routing-history index before removing its home (Windows EBUSY) | LAND | — |
| #6035 | luvs01 | A Grok-surface Devin preflight 429 binds the usage it reports | LAND | — |
| #6022 | mdwsk88 | CodeBuddy capture refuses partial same-index blocks, cross-index stop/delta, and enforces the 16-call limit at open | LAND | — |
| #6047 | luvs01 | Sidecar probe leases are released on pre-dispatch rejections and when streamed sidecar responses settle | LAND (`core.ts` 209 of 210) | — |
| #6046 | luvs01 | Turning CLI first-party off pins Desktop's mode and reports `shared_proxy_retained` | LAND-WITH-FIXES | `a3d40e1f63`: the human CLI output now prints the warning and how to release the env |
| #6036 | luvs01 | Service ownership compares recorded homes by physical directory | LAND-WITH-FIXES | `43dbcee265`: a missing, differently spelled recorded home stays foreign (ENOENT/ENOTDIR), matching its own docs and the WP13 restore contract that its head failed in CI |
| #6038 | luvs01 | Devin web search spends the routed provider's OAuth account and tenant | LAND; security review: no blocker | — |
| #6048 | luvs01 | pnpm update probes and mutations run isolated from the caller's project | LAND | `440e427ae2`: layout entries paired to stay under the size guard |

Not folded: #6046's GUI notice (out of scope for a non-GUI round) and its idempotent-PUT nit.

## Aside evidence

Captures in `.tmp/aside/pull-<n>.txt`. None of the eight links an issue. #6036 still shows Ingwannu's
CHANGES_REQUESTED review from an earlier head; Kimi confirmed the requested `unknown` verdict is in the head, and
`43dbcee265` fixes the CI regression that remained. #6038 shows two approvals. #6057 and #6022 carry draft history.

## Local proof at `440e427ae2`

- `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`: exit 0.
- 13 focused files: 428 pass, 1 skip, 10 fail; the 10 are `api-key-scope-alpha-search` cases that trip this
  worktree's protected-home guard (it lives under `~/.codex`). In a `/tmp` worktree at the same head, that file and
  `service-sqlite-home` pass 15/15.
- `tests/service/` in `/tmp`: 709 pass, 3 `shutdown-launcher` failures that need a free proxy port on this machine.
- File-size ratchet and both test-layout guards: 27 pass.
