# 261110 Release registry propagation wait

## Problem

Both stable dev-line releases failed after a successful npm publish:

- 2.100.0 (run 42767289726) and 2.100.1 (run 42810600960): `Publish verified npm tarball` succeeded
  (`+ @bitkyc08/opencodex@<v>`, "Your package is being processed"), then `Post-publish registry smoke`
  read the registry 6 times 5 s apart (~30 s), reported pending, and `Verify published npm source` gave up
  after the same ~30 s with "Published npm gitHead could not be verified; do not republish and reconcile
  manually". The GitHub release, tag and assets were never created, so each release needed a manual
  `resume-after-npm-publish` dispatch.
- Observed propagation: 2.100.0 appeared about 6 minutes after publish, 2.100.1 about 15 minutes
  (published 12:09:09Z, registry `latest` = 2.100.1 with the right gitHead at 12:23:59Z).

## Change

- `.github/workflows/release.yml` publish job: both registry loops read up to
  `REGISTRY_WAIT_ATTEMPTS` (default 40) times, `REGISTRY_WAIT_SECONDS` (default 30) apart: about 20 minutes.
  Once the smoke confirms the version, the source gate passes on its first read.
- Publish job `timeout-minutes` 15 -> 75, so both bounded waits fit inside the job.
- Unchanged: npm publish still runs once and is never retried; a wrong version or gitHead still fails
  immediately; pending verification still never republishes.

## Verification

- `tests/ci-workflows/ci-workflows.test.ts`: smoke pending scenarios now take 40 reads and 39 `sleep 30`;
  the workflow contract pins `timeout-minutes: 60`.
- `tests/ci-workflows/release-pipeline-contract.test.ts`: the gitHead gate accepts a head that first
  appears on read 35 after 34 `sleep 30`, and the publish job timeout is >= 45 minutes.
- With the workflow change reverted, three of these tests fail.
