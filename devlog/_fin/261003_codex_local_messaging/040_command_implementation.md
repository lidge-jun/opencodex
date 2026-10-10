# 040 — local command implementation and validation

2026-10-03. User authorized completing the local-only contribution. The isolated
branch `feat/codex-local-messaging` was rebased cleanly onto upstream `dev`
`e601cefcebcc20b2e04a04821ab45df6538d98f9`. The deployed checkout and its
`feat/claude-messaging` head remain unchanged; no service, installation, live
queue, remote host, issue comment or PR was changed.

## Implemented

- `ocx message sessions [--json]` returns a complete loaded-only metadata snapshot.
- `ocx message send (--thread <uuid> | --name <exact-name>) --stdin` supports
  request, correlated response and notification kinds with bounded UTF-8 input.
- Sender context comes from loaded CODEX_THREAD_ID plus metadata, explicitly not
  authenticated authority. No body/name-derived route or invented missing route.
- Command-owned receipts distinguish not_sent, queued and unknown; queued is not
  processed, and uncertain sends are never replayed or probed by another send.
- Native runtime selection reuses the existing non-persisting resolver and
  invocation builder. Admission requires Codex 0.160.0 and tested queue/Unix help.
- Native probes and one queue invocation use an owned temporary credential-free
  home, shim bypass/probe flags and the explicit existing local Unix address.
- The exact destination ID is rechecked after preflight; unloading blocks sending
  without resume. One operation budget includes stdin and helper work.
- CLI registration/help/capability data, generated operating surface, owning
  structure documentation, provisional ADR and public CLI reference are updated.

Remote auth/topology/SSH, dashboard, Claude, permissions/delegation,
isolation, managed skill installation and idle notices remain absent.

## Validation receipts

Commands used the existing Bun 1.4.0 executable, not the uninitialized npm wrapper.
Socket-capable runs used scoped escalation and temporary fixtures only. Locked
documentation dependencies were installed with frozen lockfile and ignored
lifecycle scripts. No lockfiles changed.

| Check | Result |
| --- | --- |
| New send/envelope/CLI plus lifecycle regressions | 29 passed, 0 failed |
| Native Codex 0.160.0 queue/workflow, discovery, registry/capabilities/help and layout regressions | 70 passed, 0 failed |
| `OCX_MESSAGE_CODEX_BINARY=<pinned-0.160.0> bun scripts/test.ts --changed=dev` | 1039 passed, 1 Windows-specific skip, 0 failed; 51 files; 81.6 seconds; merge base above |
| Structure, file-size ratchet and generated operating-surface regressions | 76 passed, 0 failed |
| `node_modules/.bin/tsc --noEmit` | Passed |
| `bun scripts/structure-ssot.ts` | Passed; generated index updated |
| `bun scripts/generate-ocx-skill-surface.ts --check` | Passed |
| `bun scripts/privacy-scan.ts` | Passed |
| `cd docs-site && bun run build` | Passed; 569 pages; 78880 internal links; build/search index completed |
| `git diff --check` | Passed |

Native version/hash receipts remain in [020](020_contract_and_test_matrix.md).
The complete send fixture proves one native queue add and envelope correlation;
lost acknowledgement proves unknown with one submission, not replay. No live
recipient processing, macOS native interoperability, Windows transport or arbitrary
version range is claimed.

The initial owning-runtime doc insertion hit its 600-line limit. It was replaced
with a concise update to the existing entrypoint contract, without increasing the
budget or introducing a grace exemption. Corrected structure/ratchet checks passed.

The command-local parser inventory and named tests are source/runtime evidence,
not certified graph completeness. No complete dependency graph was materialized
on this worktree.

## Remaining readiness gates

### Final upstream refresh

Upstream advanced during the first validation pass. The completed contribution
was preserved and rebased cleanly onto
`358b8ffd4c7f95237dadee1e9a5b4fedb671f4f4` (the newly integrated Claude OAuth
identity change). No messaging source conflict or runtime seam change occurred;
both test-layout maps retain the upstream identity regression registration.

On this refreshed source tree:

- `bun scripts/test.ts --changed=dev`, with the same pinned native binary:
  **1039 passed, 1 Windows-specific skip, 0 failed**, 51 files, 83.4 seconds.
- Explicit layout/tooling, structure, file-size and generated-surface regressions:
  **94 passed, 0 failed**.
- `node_modules/.bin/tsc --noEmit`: passed.
- Documentation build: passed again, including search indexing and 78880 internal
  links across 569 pages (51.1 seconds).

Ignored logs remain in the worktree's `.tmp/` as
`local-messaging-changed-final.log`, `local-messaging-source-guards-final.log` and
`local-messaging-docs-build-final.log`. These are local validation receipts, not
hosted CI or live-delivery evidence. No additional source edits followed this pass.

### Outstanding

The bounded implementation slice is complete, but no independent/security review
or hosted CI is claimed. The full default suite is deferred until review readiness,
as required by the nested source instructions; the changed suite and named
source-oracle/golden regressions above cover this implementation increment.
Recheck latest upstream dev, run the default suite, resolve correct independent
review findings and fill the contributor readiness checklist before claiming
review readiness. The user still explicitly withholds permission to open a PR.
