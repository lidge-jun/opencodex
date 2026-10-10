# HTTP client to canonical upstream WebSocket parity

## Loop specification

- Archetype/class: spec-satisfaction, C4 for credential-bearing connection lifetime; the roadmap cycle is docs-only.
- Trigger: the maintainer requested preserving HTTP/SSE ingress while repairing the canonical ChatGPT upstream WS seam, then no-verify push and merge after CI.
- Goal: transport selection must preserve request intent, server metadata, bounded cancellation, and eligible connection reuse.
- Non-goals: no client-facing WS default change, home/config/credential edits, link/service operations, deployment/release, provider destination changes, or third-party WS policy changes. No billing or entitlement claims.
- Verifier: focused transport/metadata/core-boundary tests; independent plan and security/implementation review; typecheck, privacy and secret scans; coordinated full CI/remote verification; exact-head PR checks and fetched merge ancestry.
- Stop: DONE only after both implementation slices are merged and every goal criterion has evidence. Missing external authority is NEEDS_HUMAN; genuine external dependency is BLOCKED; no unperformed check counts as success.
- Memory: this unit plus the session-bound goalplan and receipts; security working material stays under ignored `.tmp/`.
- Bounds: this checkout and its scratch only; at most two inherited-model read-only reviewer/worker lanes; no workstation-wide suite; no new paid inference; six-hour initial wall-clock audit bound, reported rather than converted to completion.
- Escalation: main reclaims after two distinct failed worker packets; delegating new writes is a plan amendment. Human approval is required for scope expansion or bypass of a missing required review/rule.

## Current source and scope

Source baseline: `6b85485f3`; reference `openai/codex`: `d2d5b7024` in the maintainer's local source corpus. The active managed checkout was adopted in place on `codex/260905-upstream-ws-parity`. Fetch/FF used a per-command disabled hooks path; no installed launcher or running proxy was changed.

The runtime is Bun-native TypeScript. Existing owners are the Responses adapter, `providerFetch`, `ws-upstream`, the selected-auth context, quota header parsing, the bounded SSE inspector, and the core-owned shutdown slot. Existing public exports remain available. No new dependency, API endpoint, configurable provider flag, or alternate event system is planned.

```text
src/adapters/openai-responses.ts          selected native request and headers
src/server/responses/fetch-helpers.ts     final outbound fetch dispatch
src/server/responses/ws-upstream.ts       HTTP request -> WS -> bounded SSE
src/server/ws-bridge.ts                  safe response-header projection
src/server/responses/core.ts             selected-account outcome and quota owner
src/lib/optional-shutdown-hooks.ts       existing teardown slot
tests/responses/ + tests/codex-integration/
```

## Dependency-ordered work phases

| Work phase | Deliverable | Dependency | Implementation design |
| --- | --- | --- | --- |
| roadmap | Audited complete roadmap, no production changes | none | this unit |
| protocol | Canonical request/response metadata preservation | roadmap | `010_protocol.md` |
| lifecycle | Bounded identity-safe upstream connection reuse and integration | protocol | `020_lifecycle.md` |

Each phase is one complete PABCD cycle. Protocol is independently useful and mergeable without connection reuse. It will land as the first reviewable PR. Lifecycle starts from its verified implementation and lands separately; if both branches are published before the parent lands, use the parent as child base, merge bottom-up, and retarget/rebase only after the CI coordinator grants a slot.

## Baseline verifier inventory

Executed on this checkout before production changes:

- `bun test tests/responses/ws-upstream.test.ts tests/codex-integration/codex-metadata-integrity.test.ts tests/lab/core-lab-boundary.test.ts`: initially 17 pass and 2 module-load errors because `zod/v4` was absent; after `bun install --frozen-lockfile --ignore-scripts`, 66 pass, 1 existing skip, 0 fail, 233 assertions. These direct arguments cover the transport, selected-auth/header contract, and protected import graph.
- The install changed no tracked lock/config file and ran no install scripts.
- `cxc receipt --help`: confirms that Check-phase receipts bind results to the actual source tree; docs-only receipt will run `git diff --check` and independent review will assess prose.
- Full-suite command is `bun run test` -> `scripts/test.ts` -> domain tests under `tests/` as declared in `package.json` and `bunfig.toml`. It is not run on this workstation. Typecheck/privacy/docs commands are inspected but will only be claimed executed when their real receipts exist.

Do not repeat an unchanged passing verifier merely for reassurance. New test-layout entries are added only if new test files are necessary; expanding existing focused files avoids unnecessary layout changes.

## Delivery and coordination

The user explicitly authorized push with `--no-verify` and merge after CI. This skips only local hooks, not required GitHub checks or review. `MAINTAINERS.md` governs required maintainer/security review; any owner bypass needs explicit authority and a recorded PR explanation.

Peer task `01a06e97-b9d8-7250-8204-bb788338c288` coordinates non-Windows full verification. Before any push, retarget, merge, or SSH full-suite launch that creates work, report PR/head/run readiness and obtain ordering. Code, documentation, static inspection and small focused tests may continue while waiting. Windows work elsewhere is out of scope.

Fill all repository PR-template sections. At landing, capture the exact head and required check rollup, fetch `origin/dev` without merge hooks, and prove the merge commit is an ancestor of the fetched tip. Do not rewrite the main dogfood checkout or relink either CLI.

## Roadmap decision record

Reuse the existing protocol seam rather than enabling client-facing WS, disabling upstream WS, or adding a second proxy. A first-hop setting cannot repair native HTTP metadata loss; a global WS toggle would alter unrelated providers. Connection reuse follows protocol preservation so it cannot amplify a malformed request contract.

HTTP ingress continues sending complete request histories. This unit does not invent incremental-history pruning or forge `previous_response_id`; connection reuse is a handshake/lifetime improvement, not a claim that HTTP clients now expose native WS delta semantics.

Completion and rejected hypotheses are appended after each cycle. All delivery claims remain pending until recorded.
