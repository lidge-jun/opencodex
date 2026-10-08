# 030 — local foundation implementation and handoff

2026-10-03. Branch `feat/codex-local-messaging`, based on upstream `dev` at
`2e3acab46e20b9bc7eace0c9301bf4330be83ac1`.

The user authorized proceeding with reasonable assumptions after no further
maintainer reply. **No PR may be opened without the user's explicit go-ahead.**
This is implementation progress, not upstream acceptance or review readiness.

The subsequent command-local implementation and current validation are recorded
in [040](040_command_implementation.md); remaining work below is historical to
this foundation increment.

## Implemented boundary

- Standalone local types and conservative Unix socket addressing; no network URL,
  token, home discovery, persistent state or daemon startup.
- Initialize/initialized handshake, metadata-only reads, strict bounded response
  projection, four pending requests and close/cancellation cleanup.
- Complete loaded-only pagination and exact selector resolution, rejecting
  duplicate/ambiguous/incomplete data and unload races.
- A whole-operation deadline and bounded no-shell helper runner. Unix helpers
  have their own process group so launcher descendants cannot hold inherited
  pipes open indefinitely after timeout; the daemon/agent group is not signalled.
- Offline strict Unix fixtures and native queue interoperability, including a
  lost acknowledgement with exactly one submission and no replay.
- Structure ownership/ADR and both test-layout maps. The foundation has no
  incoming source imports or public CLI registration yet.

## Validation obtained

Using Bun 1.4.0 and the explicit native Codex 0.160.0 binary/hash recorded in
[020](020_contract_and_test_matrix.md):

| Command / scope | Result |
| --- | --- |
| `bun scripts/test.ts --changed=dev`, with explicit native binary opt-in | 25 passed, 0 failed across the three messaging regression files; compared with upstream/dev merge base above |
| Focused messaging plus structure and file-size regressions before the final additional bound cases | 83 passed, 0 failed; included both native queue cases |
| Test-layout and tooling regressions | 18 passed; the same combined run initially exposed a parser guard defect later corrected |
| `node_modules/.bin/tsc --noEmit` | Passed with the isolated worktree's pinned TypeScript |
| `bun scripts/privacy-scan.ts` | Passed during implementation; repeated on staged final packet before commit |
| `bun scripts/structure-ssot.ts --fix` and structure regressions | Passed; generated index includes the new owner |
| `git diff --check` / staged whitespace check | Passed |

The changed wrapper was invoked directly with the existing Bun executable on
PATH. Locked runtime and GUI dependencies were installed separately with
`--frozen-lockfile --ignore-scripts`; no Bun dependency postinstall was enabled.
The npm `bun run test:changed` alias initially reached that intentionally
uninitialized wrapper, so the identical `scripts/test.ts --changed=dev` entry
was used instead.

Initial socket tests failed under the socket-restricted sandbox (`EPERM`) and
were run with scoped escalation against temporary fixtures only. The literal
import guard also initially tried to parse shebangs and erased declaration
files; both harness defects were corrected.

The first native-enabled changed-runner attempt found a real fixture mismatch:
nested temporary homes made the socket path 126 bytes, and native queue failed
before any RPC call. Fixtures now use a short, uniquely owned Unix temporary
root with the repository stale-root marker. Transport addressing enforces a
conservative 103-byte UTF-8 path policy. The corrected native-enabled changed
run passed, including lost-acknowledgement behavior.

No full-suite run, macOS/Windows native interoperability, arbitrary version
range or live recipient processing is claimed. This is an implementation
increment, not a review-ready PR; the nested source instructions defer the full
suite until review readiness. No account inference/API call, live message,
publish, install of OpenCodex, deployment or service restart occurred.

Validation used direct source inspection and the named regression tests above.
No complete dependency graph was materialized; certified dependency completeness
is not claimed.

## Remaining bounded slice

Implement the local envelope, honest Codex sender context and receipt layer
(`not_sent`, `queued`, `unknown`), then the minimal command-local CLI, existing
home/runtime selection, capability preflight and public docs/generated surface.
Include uncertain-send/no-replay, no acknowledgement loops and no guessed reply
routes in the focused regressions. Replace the foundation's zero-incoming-import
guard with a command-local activation guard when CLI wiring actually exists.

Remote, Claude, skill management, permissions/delegation, dashboard,
isolation and idle notices remain outside this contribution. Retain the deployed
`feat/claude-messaging` branch/head unchanged. Independent/security review and
the contributor readiness gates remain outstanding; PR authorization remains
explicitly withheld.
