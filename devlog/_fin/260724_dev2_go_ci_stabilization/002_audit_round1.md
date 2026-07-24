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

### C-phase supersession: Node 24 action releases

The first exact-SHA run passed but GitHub annotated the audited v4/v5 pins as Node 20 action bundles. The audit's security requirement (immutable full-length SHAs with readable release comments) remains intact while the concrete versions are superseded by current Node 24 releases:

- `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`
- `actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0`

An independent C-phase re-audit returned `VERDICT: GO` with no Critical, High, or Medium findings. It verified that both official tags resolve to the pinned signed commits, both action manifests declare Node 24, the hosted runner versions exceed the actions' minimum requirements, and existing workflow inputs remain supported. Its one Low finding corrected the intermediate run's annotation count from four to five in the evidence documents.

The subsequent hosted run found a compatibility residual the static re-audit missed: setup-go v7's local-toolchain behavior no longer masks the workflow's stale Go 1.24 pin against the module's Go 1.26.4 declaration. The hosted failure is the authoritative C gate. The repair keeps setup-go v7 and changes only its supported input from a duplicated literal to `go-version-file: go/go.mod`.

## Main-agent judgment

Near-pass. There are no Critical or High findings and no blocking issue. Both residual suggestions are concrete, in scope, and folded into `000_plan.md` and `010_implementation.md` before B.

## Reviewer verdict tail

```text
blocking_issues: []
VERDICT: GO-WITH-FIXES (blockers=0)
```

```text
C-phase blocking_issues: []
C-phase VERDICT: GO
```
