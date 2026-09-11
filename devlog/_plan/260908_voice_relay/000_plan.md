# Codex voice relay follow-up

Satisfy-spec HOTL loop, triggered by the maintainer's September voice source comparison request.
Goal: carry only verified OpenCodex-owned improvements and document the client/proxy boundary.
No local product tests, typecheck, build or installs; no release, deployment or user settings changes.
Verification: read pinned upstream source and Aside findings; independent review; final cumulative
remote Cross-platform CI dispatch (all lanes), followed by exact-head merge and fetched dev tree proof.
Local product verification is NOT RUN by explicit user instruction. Git diff/document inspection is
allowed but does not certify runtime behavior. No latency or live audio improvement is claimed.
Stop: audited no-change conclusion, or required corrections landed with fresh remote evidence.
Outcomes: DONE, evidence-backed NOOP, or explicit unmet external gate. No invented time/cost budget;
existing tools/credentials only, bounded individual probes, no new services or installs.
Escalation: unresolved maintainer objection, missing external authority, or unavailable required CI.

## Ordered work phases

1. wp1: source research and audited roadmap (documents only).
2. wp2: scoped relay correction and adjacent regression coverage; depends on wp1.
3. wp3: publish the documented contract, final cumulative CI, and merge; depends on wp2.

Existing owners: `src/server/live.ts`, `src/server/index.ts`, `tests/server/server-live.test.ts`,
`docs-site/src/content/docs/guides/codex-integration.md`, `structure/04_transports-and-sidecars.md`.
No new production abstraction, endpoint or dependency. Preserve preexisting worktree documents.
Manual two-PR chain: relay implementation/tests, then integration documentation. User explicitly
requests final-tip-only product CI, overriding per-layer local/full-suite defaults. Automatic
redundant product CI on these task PRs may be cancelled; it is never counted as passing evidence.
Use merge commits to preserve stack ancestry, retarget the child only after the parent lands,
and recheck the current dev tree before final merge. Required checks remain truthful.

Security working material is kept only in ignored scratch per AGENTS.md. The detailed audited
roadmap resides in `.tmp/voice-0908/010_runtime.md` and `.tmp/voice-0908/020_delivery.md` until
publication of the fix; it is intentionally not copied into this public planning directory.

## Roadmap audit and lock

Independent plan and security audit: PASS, no blockers. The implementation will preserve view
bounds and original frame delivery. Diagnostic replacement-character flags are not evidence of
which peer introduced malformed text. Existing logs are outside this prospective logging change.
The roadmap is locked for wp2; final runtime evidence remains due in wp3, on the cumulative tree.
