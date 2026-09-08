# Issue #3895: implementation plan

Satisfy-spec work, triggered by issue #3895 and the request to implement separate draft PRs. Goal: remove the exact leading enforcement marker from release summaries and full changelogs. Non-goals: changing workflow enforcement, publishing a release, modifying historical releases, or generic bracket stripping. Stop after verified draft PR; report unresolved gates. Escalate if renderer changes require workflow/security-policy changes. This file records plan and evidence.

Class C2: pure formatting behavior, without modifying release authorization or execution. Independent branch from 522ce5f8c.

File map:
- MODIFY scripts/release-notes.ts: introduce a private exact-prefix normalization helper next to cleanPrTitle. Trim whitespace, remove one leading "[WRONG BRANCH] " marker, retain the rest. Call it before conventional-prefix parsing and for full-changelog titles. Preserve conventional prefixes and author/PR attribution in changelog entries.
- MODIFY tests/ci-workflows/release-notes.test.ts: helper expected scope/casing; complete renderer on generated and carried notes; same-scope grouping; preservation of unrelated bracket tags, nonleading marker, author and PR references. Assert both category and Changelog output.
- MODIFY structure/06_docs-and-release.md: record known-marker handling and preservation of original conventional titles in full changelogs.

Verification: release-notes tests directly import changed helpers; typecheck covers src only and is not represented as script type checking; full prepush is required by scripts/AGENTS.md; privacy scan. Baseline on unchanged code: 71 passed. Regression expectations come from the published issue, not from cleanPrTitle itself.

Audit: cleaning only cleanPrTitle was rejected because changelog emits the raw title. General bracket normalization would remove meaningful content. Private helper is shared by exactly two consumers and adds no runtime dependency. Explicit maintainer review for release-related changes remains pending at draft handoff.

## Verification before draft publication

- `bun install --frozen-lockfile`: passed; lockfile unchanged.
- Before the production change, four new assertions failed for marker leakage: helper cleanup, delta renderer, carried renderer, and same-scope grouping. Existing baseline: 71 passed.
- `bun test tests/ci-workflows/release-notes.test.ts`: 81 passed, 0 failed after expanding preservation cases.
- `bun run typecheck`: passed during prepush.
- `bun x tsc --ignoreConfig --noEmit --strict --target ESNext --module ESNext --moduleResolution bundler --skipLibCheck --types bun scripts/release-notes.ts`: passed; this explicitly covers the script outside the root tsconfig.
- `bun run privacy:scan`: passed.
- `bun run prepush`: not green. The parallel test lane exceeded its repository-defined 900-second deadline and exited 124; later lanes/stages did not run. Eleven failures were emitted before termination: six timeout cases across combo management, Claude messages, loopback injection, integration restore and Responses overflow; one Claude compatibility assertion failure; four Aside file-symlink EPERM cases. The full suite is incomplete, and no successful full-suite count is claimed. These files are outside the renderer change; causes other than the explicit symlink errors remain unverified. Raw local evidence is in ignored `.tmp/prepush.log`.
- Focused independent review found no concrete production blocker; it was limited and did not replace maintainer security review or complete-suite verification. Linux and macOS were not run locally.
