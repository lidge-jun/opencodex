# 5848: native remote-list provider policy before a backend relay

Status: **proposal and executable specifications only; no production fix**.
Date: 2026-09-28.

Related: [#5848](https://github.com/lidge-jun/opencodex/issues/5848),
[duplicate #5906](https://github.com/lidge-jun/opencodex/issues/5906),
[upstream #48358](https://github.com/openai/codex/issues/48358).

## Proposed decision

Prefer a narrowly scoped, operator-opt-in policy in **native Codex app-server**
for remote `thread/list` requests that do not supply a provider array. Keep the
normal default-provider behavior, all existing authorization, and history intact.
The mobile client's explicit all-provider request remains the simplest upstream
client correction. Compare both with the previously tested local backend relay;
do not turn that experimental relay into an installed feature in this PR.

The current OpenCodex runtime and [ADR-5848](../../../structure/decisions/ADR-5848-provider-table-remote-history-visibility.md)
remain unchanged. This proposal does **not** close #5848.

## Work remaining

- [x] Identify the native remote-connection boundary and existing provider predicate.
- [x] Specify precedence and test the native-policy proposal offline.
- [x] Retain and rerun the isolated loopback relay alternative.
- [ ] Obtain upstream agreement on the native configuration/API contract.
- [ ] Implement config/schema, trusted-origin plumbing, and Rust regressions upstream.
- [ ] Verify native pagination, managed policy, account changes, and actual mobile resume.
- [ ] Establish released-version/capability detection before adding any OpenCodex toggle.

See [design](010_design.md) and [verification](020_verification.md).
