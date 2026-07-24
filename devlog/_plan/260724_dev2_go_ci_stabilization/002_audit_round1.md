# A-gate audit round 1

Date: 2026-07-24
Reviewer: independent explorer on a different model family
Verdict: `GO-WITH-FIXES (blockers=0)`

## Dispatch history

- The first audit dispatch produced no result after three bounded wait cycles and was retired without using any output.
- A narrower replacement audit inspected the three plan documents, all five planned changed files, the OAuth callers, PR #368, and the old remote branch ref.

## Findings and dispositions

### Medium: direct `RefreshAccount` coverage gap

- Evidence: `RefreshAccount` remains exported at `go/internal/oauth/store_refresh.go:16` and is called by `go/internal/cli/account.go:176`.
- Trigger: moving the flaky concurrent test to `RefreshAccountIfGeneration` would otherwise leave no direct basic test of `RefreshAccount`.
- Disposition: folded. Add `TestCredentialStoreRefreshSequential` alongside the deterministic stale-generation concurrency test.

### Low: exact action version comments

- Evidence: replacing mutable action tags with 40-character SHAs makes future upgrades harder to read without comments.
- Disposition: folded. Use:
  - `actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0`
  - `actions/setup-go@40f1582b2485089dde7abd97c1529aa768e1baff # v5.6.0`

## Main-agent judgment

Near-pass. There are no Critical or High findings and no blocking issue. Both residual suggestions are concrete, in scope, and folded into `000_plan.md` and `010_implementation.md` before B.

## Reviewer verdict tail

```text
blocking_issues: []
VERDICT: GO-WITH-FIXES (blockers=0)
```
