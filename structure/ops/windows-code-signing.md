# Windows Code Signing

Windows release files are Authenticode-signed through SignPath Foundation when the repository is configured for it,
and every release body states whether that release's Windows files were actually signed (#7207). The user-facing
policy and the maintainer setup live in `docs-site/src/content/docs/reference/code-signing.md`.

## Signing in the release legs

The Windows legs of `package-standalone` (`ocx.exe`) and `package-desktop` (the MSI) in
`.github/workflows/release.yml` each decide once, through `scripts/ci/windows-signing-plan.sh`, whether to sign:
no `SIGNPATH_API_TOKEN` or an incomplete configuration skips, `release-signing` signs with release trust, and any
other policy signs dry runs only with test trust. Every SignPath step continues on error, so signing never fails a
release. `scripts/ci/apply-signed-windows-artifact.ps1` verifies the returned file (`scripts/ci/verify-authenticode.ps1`),
re-signs the MSI's Tauri updater signature over the signed bytes, swaps it in, and restores the original on any
failure. It writes the step output `signed=true` only after the verified swap, and `signed=false` otherwise.

## The signing outcome in the release body

Each Windows leg first writes its record as not signed (right after the signing decision), then runs
`scripts/ci/windows-signing-outcome.sh <standalone|desktop>` again after the swap on every run
(`always() && runner.os == 'Windows'`, continuing on error) and uploads the record as
`windows-signing-outcome-<kind>`, a name neither `standalone-*` nor `desktop-*` matches, so it never becomes a
release asset; the upload sets `overwrite: true`, and because the early record guarantees a file, a re-run always replaces an
earlier attempt's record. A record says signed only when the plan's mode was `sign`, its trust `release`, and the swap
reported `signed=true`; a skipped plan, a test certificate, or a failed or skipped swap records false.

`publish` downloads `windows-signing-outcome-*` (continuing on error) and passes the directory to
`scripts/build-release-changelog.ts` through its required `--windows-signing-outcomes` flag.
`scripts/release-signing-footer.ts` reads the records strictly (schema `ocx.windows-signing-outcome/1`, the
matching kind, a boolean); a missing, malformed or mislabelled record is "not recorded" and never counts as signed.
The section always starts with the SignPath attribution and the code signing policy link that SignPath Foundation
requires on the download page, then states one of: both files signed; "The Windows files in this release are not
code-signed" (no file signed, or nothing recorded); or, when at least one file is signed and another is not, which
file is signed and which is not.

The body is written when `publish` creates the draft release. A resumed run (`resume-after-npm-publish`) that reuses
an existing draft rewrites its body from that run's notes with `gh release edit --notes-file`, because the resumed
run's Windows legs record their own outcome and `attach-release` attaches that run's bundle. A published release is
immutable, and `attach-release` already requires its assets to match the run's verified digests.

Release bodies published before this record existed carry an explicit "not code-signed" line added by hand; the
workflow never rewrites a published body. `tests/ci-workflows/release-windows-signing-outcome.test.ts` covers the
record script, the workflow wiring and each wording; `tests/ci-workflows/release-windows-signing.test.ts` covers the
plan, the SignPath gates and the swap script.
