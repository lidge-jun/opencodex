# 050 - helper cleanup and current-dev refresh

2026-10-03. User authorized the helper cleanup correction and a refresh onto
current upstream dev. The contribution was rebased cleanly onto
`3541261ac776679448664e98164add5fba203edd`; all five contribution commits replayed
without conflict. The deployed checkout remains unchanged.

## Changes and provenance

- Forced helper cleanup cancels pending output readers without waiting for EOF
  or asynchronous cancellation hooks. Owned group termination remains intact;
  no detached group outside that ownership is signalled.
- Regression coverage exercises timeout, cancellation and output overflow with
  a self-expiring detached fixture, while retaining the existing same-group
  descendant cleanup and uncertain-submission/no-replay tests.
- Upstream-facing documents stay confined to the contribution's intended scope.
- The source extraction follows [010](010_extraction_map.md), not a whole-feature
  cherry-pick. It retains the existing local messaging approach while tightening
  loaded-only discovery, lifecycle budgets, runtime admission and helper homes.
  It is not byte-identical to the deployed experiment with other features removed.

## Validation on the rebased implementation

Commands used the installed Bun 1.4.0 and corrected worktree dependency PATH.
Socket/native tests used isolated fixtures and explicit Codex CLI 0.160.0 from
the locally installed, previously hash-verified standalone release.

| Command | Result |
| --- | --- |
| `bun scripts/test.ts --changed=dev` with `OCX_MESSAGE_CODEX_BINARY` set | 1040 passed, one Windows-only skip, zero failures; 51 files; 93.5 seconds; comparison merge base is the dev commit above. |
| `bun scripts/test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/ci-workflows/structure-ssot.test.ts tests/ci-workflows/file-size-ratchet.test.ts tests/ci-workflows/skill-ocx.test.ts` | 94 passed, zero failures; 1.7 seconds. |
| `node_modules/.bin/tsc --noEmit` | Passed. |
| `bun scripts/structure-ssot.ts` | Passed. |
| `bun scripts/generate-ocx-skill-surface.ts --check` | Passed. |
| `bun scripts/privacy-scan.ts` | Passed. |
| `cd docs-site && bun install --frozen-lockfile --ignore-scripts && bun run build` | Passed; 569 pages, 78892 checked internal links; build 50.9 seconds. |
| Repository hygiene/sponsorship-path classifiers on the complete contribution diff | No failures or restricted-path flags; not independent/security review. |
| `git diff --check upstream/dev...HEAD` | Passed. |

Before rebase, focused lifecycle/send/native-queue validation passed all 24 tests.
The original isolated cleanup probe returned `process_incomplete` in 1163 ms
with a 150 ms helper timeout and 1000 ms termination grace.
Ignored final logs are `.tmp/local-messaging-rebased-changed.log`,
`.tmp/local-messaging-rebased-source-guards.log` and
`.tmp/local-messaging-rebased-docs.log`.

## Remaining review gates and full-suite exception

This is implementation validation, not a review-ready or merge-approved claim.
The preceding full-suite audit reached its 900-second lane limit, with 612 files
unstarted and four interrupted. Corrected focused reruns reproduced four timeout
cases and 13 service-runtime failures on an untouched upstream base. That audit
does not establish full-suite success, and its results are not claimed as passing
evidence for this rebased implementation.

Another full run is deferred for this bounded implementation step under the
nested source instructions and documented resource exception. Connected tests
and explicit source-oracle/native regressions passed above; broader full-suite,
cross-platform and hosted validation remain for review readiness/CI. Independent
and explicit security review remain outstanding. No unrelated failure was fixed,
test timeout increased, runtime installed or compatibility range invented.

No remote force-push, PR, deployment or service restart was performed. The fork
still points at the prior published history; publishing this rebased history
requires a separately authorized, lease-guarded update. User permission to open a
PR remains withheld.
