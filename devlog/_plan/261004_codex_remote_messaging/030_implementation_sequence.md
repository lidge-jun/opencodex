# 030 — implementation and handover

Status: the agreed remote slice is implemented locally on
`feat/codex-remote-contribution`; final integrated qualification and review are
in progress. Neither publication nor deployment is authorized by this status.

## Completed implementation sequence

1. Reconstructed the contribution on current upstream dev containing merged
   #6544, preserving the old prep worktree and deployed experiment.
2. Pinned narrow gateway/native contracts, mutual connection proofs, strict
   receipt semantics and numeric aggregate capacities.
3. Added explicit private state/enrollment and recoverable private-stdio
   transactions; no implicit remote enable or lifecycle changes.
4. Reused shared SSH policy with messaging-owned -L/-R children and live return
   leases. Added cancellation/join behavior without changing Remote Link.
5. Added an explicit foreground owner and dynamically selected remote CLI path.
   No listener, helper, timer or state creation occurs from imports/default startup.
6. Added one-connection remote sends and machine-aware return replies, preserving
   local-only Unix trust and queued/not_sent/unknown/no-replay behavior.
7. Added registered isolated regressions, generated surfaces, public CLI docs,
   source ownership and a foreground decision record.
8. Qualified disposable loopback SSH and stock Codex 0.160.1 separately. Full
   integration gates and independent review remain to be recorded.

## Maintainer adjustment points

Foreground lifetime is provisional. The individual-peer schema is intentionally
independent of any future mesh. The protected gateway protocol is not a native
WebSocket listener and does not claim raw queue CLI compatibility. Linux evidence
must not be generalized to macOS. If the owner requests smaller contributions,
split along enrollment/transport/delivery while retaining the tested contracts.

## Safe handover

Keep source and exact-head receipts together. Preserve the deployed local branch;
do not install, restart, enroll production hosts or migrate skills from this PR
preparation. Do not push or raise a PR without the user's go. Reference the broader
proposal rather than auto-closing it.

The local PR draft must distinguish implementation, tests actually run, remaining
platform/CI/maintainer gates and security review. Any unrun suite or skipped opt-in
fixture stays explicitly unqualified. Never include secrets, personal host paths,
internal product names or unpublished security notes in public commits.
