# wp4 — 2.56.0 release

## Preconditions

- wp2 closed: #4683 on `dev` with Cross-platform CI green at its exact head.
- wp3 closed: no open REGRESSION finding.
- `dev` carries 2.56.0 (`dev-version-bump` owns that line).

## Sequence

The order is forced by two gates in `.github/workflows/release.yml`, not by preference.

1. Record the `dev` tip and its Cross-platform CI conclusion at that exact SHA.
2. Cut the promotion branch from that `dev` commit — it still reads 2.56.0 — and open its PR to
   `main`. Merge it. That merge commit is the release SHA `M1`.
3. Confirm Cross-platform CI succeeded for `M1` on `main`. `release.yml` requires a successful
   run for the dispatched commit (`Require successful Cross-platform CI for this commit`), and
   `Service lifecycle` too when service files changed in the range.
4. Dispatch `dev-version-bump.yml` with `intended-version: 2.56.0`, mode `pre-move`. It opens a
   PR moving `dev` to the next line; merge it. This is not optional: `release.yml` ends with
   `Require dev to be ready for this release`, which runs
   `version-line.ts assert-ahead <dev version> <release version>` and refuses to publish while
   `dev` still equals 2.56.0.
5. Dispatch `release.yml` with `version: 2.56.0` and `expected-sha: M1`. The workflow refuses any
   dispatch whose `GITHUB_SHA` differs from `expected-sha`, so the branch must not move between
   step 3 and here.
6. Verify the publish from the workflow's own conclusion. Registry metadata can lag a successful
   publish; a lagging read is not a reason to publish again.

## Evidence

Recorded as each step completes: SHA, run id, conclusion.

- wp2 head under CI: `4e548b693c` (previous heads `27c61e2dfb`, `9dffc3f06f`, `35ad194ec2`
  superseded; `35ad194ec2` failed the file-size ratchet on
  `tests/responses/responses-state.test.ts` and was fixed by removing the three added lines rather
  than raising the cap).
