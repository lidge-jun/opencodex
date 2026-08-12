# 260805_windows_gate_release — Windows out of the release gate, 2.10.1 shipped

## Outcome

- `platform-windows` in `.github/workflows/ci.yml` runs on `workflow_dispatch`
  only; the aggregate gate's mandatory-Windows assertion was removed with the
  condition it policed. `release.yml` keeps requiring a successful push-event
  Cross-platform CI run for the exact release SHA; the stale Windows rationale
  was rewritten. `tests/ci-workflows.test.ts` pins the dispatch-only contract.
- Motivation: the sharded promotion run surfaced ~207 Windows-only test
  failures, pre-existing on every released version. Tracked as issue #1059;
  Windows re-enters the gate when green.
- `audit:high` release preflight was red on two high advisories in
  `@modelcontextprotocol/sdk` transitives; fixed by sdk ^1.30.0 plus
  `fast-uri@^3.1.5` / `ip-address@^10.4.0` overrides (commit 8949c4940).
- Recurring macOS native-profile process-exit flake blocked three
  release-train runs; tracked as issue #1061.

## Published

- npm `@bitkyc08/opencodex`: `preview` = 2.10.1-preview.20260805
  (release run 31009326742), `latest` = 2.10.1 (release run 31011286698).
- GitHub releases: v2.10.1 (Latest), v2.10.1-preview.20260805 (Pre-release).
- CI evidence: dev success at 8949c4940 (run 31006522782); preview/main
  promotion runs green with the Windows legs skipped.

## Acceptance (all met)

| Criterion | Evidence |
| --- | --- |
| Windows gates nothing on any automatic trigger | ci.yml `if: workflow_dispatch` only; test re-pin 99 pass |
| Release still requires exact-SHA green CI | release.yml gate unchanged in kind; both dispatches enforced it |
| audit:high green | sdk 1.30 + overrides; preflight passed in both releases |
| Both channels published | npm dist-tags latest=2.10.1, preview=2.10.1-preview.20260805 |
