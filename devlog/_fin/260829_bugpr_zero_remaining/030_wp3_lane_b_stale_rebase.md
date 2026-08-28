# wp3 — Stale and inherited-red branches

This lane completed with #2822, #2821, and #2785 merged to `dev`.

At triage, each branch looked blocked or unstable, but the relevant red checks were either
the inherited release-version failure or stale-base noise. After #2836 repaired the shared
base, the branch-specific focused checks and exact-head CI could be read as evidence about
the actual patch.

Patch identity and changed-file scope were checked during the base movement. No unrelated
behavior was folded into these merges. This lane confirmed the keystone diagnosis: once
the common version-line defect was gone, the three independent fixes could be evaluated
and landed on their own merits.
