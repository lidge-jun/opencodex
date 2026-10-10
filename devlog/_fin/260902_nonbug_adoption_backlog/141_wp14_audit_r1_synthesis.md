# wp14 audit r1 — synthesis

Turing (grok-4.6): carry + fix, not reimplement. Blockers: rebase + resolve provider-routes.ts keeping
both omit-preserves; exact-head CI (macOS server-auth ws flake to be treated as flake). Verdict near-pass.
Merge executed by Aristotle (grok-4.6) in the side worktree: resolved block keeps `existing` early,
samples `submittedUpstreamWebsocket` before enrich, preserves on omit; 153 pass / 1 skip.
