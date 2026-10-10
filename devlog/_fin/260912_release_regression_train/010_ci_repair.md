# wp2 — CI repair and dev re-green

PR #4390 (`codex/260912-finish-integration-fixtures`, head `d8335f75b4`) carries the
shared repair that makes the Cline registration and Codex restore fixtures pass again.
Twenty-one checks including `gates` pass on that head, which is what proves the Cline
failure class is resolved. Four report failure: `test 4/4`, `macos 2/2`,
`enforce-target`, and the `ci` aggregate that reflects the first two.

## Failure 1 — `test 4/4`

`tests/codex-integration/codex-inject-integration.test.ts` receives `matchedReads: 0`
on Linux and on macOS alike, which rules out a path-string difference: the same file
fails as `test 4/4` and `macos 2/2` with identical output.

The interception never worked. `src/codex/inject-coordination.ts:8` binds
`readFileSync` as an ESM named import, and `readOrNull`/`captureCodexPreImages` read
`CODEX_PROFILE_PATH` through that binding, so `spyOn(fs, "readFileSync")` on the child's
`require("node:fs")` handle reaches nothing. Every assertion in that test therefore ran
against an undenied filesystem. The `matchedReads` counter added on this branch did not
create the defect; it made an already-false test visible.

That matters beyond this PR: the test arrived in #4342, which merged into dev with its
own CI red, so dev has carried the failure since.

Repair: drop the mock and make the profile genuinely unreadable with `chmod 0`, proving
the precondition through a new `unreadable` field before any later assertion depends on
it. The EACCES, outcomes, compensation, and preservation expectations are unchanged.
Windows chmod only toggles the read-only bit and root ignores mode 0, so both are
skipped.

## Failure 2 — `enforce-target`

The description mentions `gui` and carries no UI screenshot, which the gate rejects.
Resolve it by supplying the screenshot when the change really touches the UI, or by
removing the incidental `gui` mention when it does not. Disguising the mention to slip
past a path-based gate is not an option.

## Exit

Every required check green at the final head, merged to dev with maintainer-integration
recorded, ancestry and tree verified against fresh `origin/dev`, and one push-event
`ci.yml` run allowed to finish on that dev head with no competing merge.
