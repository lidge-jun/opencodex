# Phase 2 (wp3): xAI OAuth endpoint validation hardening

Closes #4048 (security hardening). Separate PR layered on the phase-1 head
because it edits the same file.

Per the repository security-notes policy (root `AGENTS.md`), everything about
this phase beyond the fact that it exists — the assessment, the patch plan, and
the test plan — is held in scratch space (`.tmp/260909_xai_endpoint_security/`,
gitignored) until the fix's own diff is public. A public issue describing a
weakness is not by itself license to restate the weakness, its blast radius, and
the remediation in a tracked document before the fix ships; the published
outcome (the merged diff and its release note) is what enters the record.

## Phase entry condition

Phase 2 starts only after phase 1's PR is published, and rebases onto the
published phase-1 head (manual chain: PR2 base = PR1 head branch). Its
pre-written scratch plan is re-verified against the rebased code before
implementation (LOOP-CONTINUITY-01).
