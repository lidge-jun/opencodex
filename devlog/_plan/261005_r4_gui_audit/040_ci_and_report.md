# 040 — wp3: CI evidence and merge-ready report

1. For #6612 (head dc698801693738becc91516f3bb4bef2cfdda933) and #6613 (head
   58ab56497f759a09f4727699d071c19e19a6f9f4): read the PR check rollup and the
   workflow_dispatch `lane=all` runs (37253759183, 37253761495). Confirm each run's
   headSha equals the PR head, list every job with conclusion and attempt. Expected jobs
   come from `.github/workflows/ci.yml` path filters: the GUI PR requests the four test
   shards, storage-policy, api-usage, gates, keyring/docker/npm-global smokes, privacy-gate
   and the `ci` aggregate; the docs PR requests docs-site-build, privacy-gate and `ci`;
   dispatch adds native, macos-control and the Windows shards. A skip the aggregate
   declares intentional (path/event filter) is acceptable; an expected job that is skipped,
   cancelled, pending or action_required is missing evidence. Merge evidence is the PR
   event `ci` aggregate success plus all required PR checks, plus the dispatch run, each
   recorded with event, run id, attempt and tested SHA.
2. A red job: fetch its log, decide whether the change caused it (fix on the branch, push,
   re-dispatch) or it is an unrelated flake (record the evidence, rerun only that job).
3. When both are green, report `MERGE-READY #n head=… ci=…` lines to the coordinator.
4. When the coordinator reports dev moved over a touched file, merge origin/dev in, recheck
   the ratchet and layout registries, get fresh CI, re-report.
5. When #6597 lands, audit its GUI part (Connect file-client pages, missing-store remedy,
   locales) with the same harness and record findings in 020_findings.md.
