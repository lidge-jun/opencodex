# wp8 — Version-line keystone

This phase completed in #2836 and ran first because it repaired the shared base rather
than any individual bug branch.

At campaign start, `dev` still declared version 2.35.0 while the published preview line
had reached `v2.36.0-preview.20260829`. The invariant in
`tests/release-version-line.test.ts` therefore failed on every descendant commit. Six
otherwise unrelated bug pull requests inherited that red result, making their own changes
look suspect.

#2836 advanced the `dev` version line to 2.36.0. That value followed repository precedent:
after a published preview, `dev` carries the next stable version rather than duplicating
the preview identifier. The change touched only the version field and did not promote
`preview` or `main` or alter release automation.

The focused version-line test passed after the change, and the inherited failures cleared
on the downstream pull requests. The practical lesson is to test a repeated failure
against the common base before repairing each branch independently. One stale line in the
base had more leverage than any individual merge.
