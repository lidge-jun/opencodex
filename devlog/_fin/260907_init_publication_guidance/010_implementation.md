# Issue #3893: implementation plan

Satisfy-spec work, triggered by issue #3893 and the request to implement separate draft PRs. Goal: actionable first-run publication diagnostics. Non-goals: changing file writes, permissions, replacement/cleanup guarantees, or adding a filesystem fallback. Stop after a verified draft PR; unresolved platform checks are reported, never marked passed. Escalate if resolving the issue requires weakening publication guarantees. This file records the plan and eventual evidence.

Class C2: diagnostic propagation and user documentation. One independent branch from 522ce5f8c; no branch dependencies or orchestration state changes.

File map:
- MODIFY src/config/initialize.ts: add an optional hardeningFailed flag to constructor options; select a fixed privacy-safe permission diagnostic when hardening throws. Track the flag around the existing harden call only, and pass it in the existing error options. Append supported-location guidance to denied-link diagnostics. All I/O order and cleanup remain identical.
- MODIFY tests/config/config-mutation-lock.test.ts: inject a harden failure and prove write/link never happen, target remains absent, no residue remains, and raw error details do not appear. Assert all five denied-link codes provide recovery guidance while retaining uncertain-publication state. Partial-write errors must not be mislabeled as permission failures.
- MODIFY tests/service/init-eof.test.ts: use its existing child bootstrap seam to inject publication errors during the real CLI wizard; verify exit=1, diagnostics and residue warnings, no configuration/backup damage or integration prompts.
- MODIFY docs-site/src/content/docs/getting-started/quickstart.md and structure/02_config-and-codex-home.md: explain supported locations, inspection before retry, separate permission and link failures, and fresh-install OPENCODEX_HOME examples. Existing translations reviewed for contradictions.

Optional constructor input chain: created by the publication function; consumed by Error.message; no config serialization, migration, or persistent state. Existing constructor calls keep their meaning.

Verification: focused config/init tests read the real publication and CLI code; typecheck includes src; privacy scan; required docs-site build. Baseline focused run: 35 pass, 3 skip, 2 fail (Windows file-symlink privilege: symlinkSync EPERM and dependent missing-residue assertion). No baseline failure will be hidden by changing tests. New regression checks must pass. Windows-native filesystem support remains bounded by the host.

Audit: direct O_EXCL and replacement fallbacks rejected because they change complete-file/no-replace guarantees. Reuse the existing error and test seams; no new diagnostic module. Guidance never prints raw cause text or candidate bytes.

## Verification before draft publication

- `bun install --frozen-lockfile`: passed; lockfile unchanged.
- New diagnostics were observed failing before implementation: 9 failures across the focused hardening/link/CLI fault cases. After implementation: 9 passed.
- `bun test tests/config/config-mutation-lock.test.ts tests/service/init-eof.test.ts`: 38 passed, 3 skipped, 2 failed. The same two tests failed on unchanged 522ce5f8c: file-symlink creation is denied on this Windows host, and the swapped-symlink test then lacks its expected residue. New recovery tests pass; no skips or weakened assertions were added.
- `bun run typecheck`: passed.
- `bun run privacy:scan`: passed.
- `cd docs-site; bun install --frozen-lockfile; bun run build`: passed, 425 pages. Translated quickstarts contain no conflicting recovery/fallback instructions.
- CLI fault scenarios verify exit=1, distinct permission/link messages, uncertain-publication/residue warnings, backup preservation and no integration prompts. Partial-write errors keep the generic diagnostic.
- No physical non-NTFS filesystem support is claimed. Maintainer review remains required; this is a draft handoff.
