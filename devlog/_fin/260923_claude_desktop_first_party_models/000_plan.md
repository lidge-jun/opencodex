# Claude Desktop first-party: Code tab model bindings

First-party mode keeps Claude Desktop signed in to claude.ai and routes only the Code tab's
Claude Code through the local intercept. The routing works, but the Code tab picker is owned by
claude.ai, so none of opencodex's models can appear there and the operator has no way to reach
them from Desktop. This unit adds first-party model bindings: the operator binds a picker model
id (for example `claude-sonnet-4-6`) to an opencodex route, and only requests that arrive
through the intercept honour the binding. `ocx claude` sessions and the public Messages
endpoint are unaffected. Evidence for the constraint is in [001_probe_evidence.md](001_probe_evidence.md);
the decisions are in [010_roadmap.md](010_roadmap.md).

## Loop spec

- Loop archetype: satisfy-spec, three work-phases (docs-first, implementation, live proof + PR).
- Trigger: the user reported that first-party still does not work in the Claude app and asked
  for a live probe of the injection mechanism with Computer Use, a working Claude app, and a PR
  with screenshots.
- Goal: from the Desktop Code tab in first-party mode, the operator can pick a Desktop picker row
  and be served by an opencodex route of their choice, with the binding visible in CLI, API,
  dashboard and docs.
- Non-goals: adding rows to the Desktop picker (claude.ai owns it), changing the OS trust store or
  system proxy, modifying Claude.app, changing gateway mode, merging or releasing the PR,
  restarting the user's live service.
- Verifier: focused bun tests named in 020, `bun run typecheck`, `bun run structure:check`,
  `bun run skill:surface:check`, `bun run lint:gui`, `bun run build:gui`, then the live
  Desktop proof in 030 (usage.jsonl provider + app screenshot).
- Stop condition: PR opened against `dev` with screenshots and exact-head CI reported; no merge.
- Memory artifact: this unit directory; the goalplan at
  `.codexclaw/goalplans/opencodex-claude-desktop-first-party-claude-code/`.
- Expected terminal outcomes: DONE when C1-C4 hold; BLOCKED if Desktop needs a login only the
  user can perform; NEEDS_HUMAN if claude.ai changes the picker ids mid-run.
- Escalation condition: any need to touch the OS trust store, system proxy, Claude.app, or the
  user's live service; any merge decision.
- Resource bounds: local worktree writes only; push limited to the PR branch and screenshot
  assets; one live Desktop session probe per proof; no token or time budget was set by the user.

## Work-phase map

| Work-phase | Doc | Closes with |
| --- | --- | --- |
| wp1 docs-first | this unit, 001, 010 | roadmap locked, no code |
| wp2 bindings | [020_wp2_first_party_bindings.md](020_wp2_first_party_bindings.md) | focused tests, typecheck, structure/skill checks green |
| wp3 live proof + PR | [030_wp3_live_proof_and_pr.md](030_wp3_live_proof_and_pr.md) | Desktop Code tab served by a bound route, screenshots, PR open |

## Architect consultation

- Handle: `01a0cda6-d2ab-73d2-95ea-ead02c2cd992` (devin/swe-2, CXC-ROLE architect, read-only).
- Proposal decisions D1-D5 and main's dispositions are recorded in [010_roadmap.md](010_roadmap.md).
- Reflection on revision r1 (000/010/020/030): ALIGNED. One minor gap: rename migrations rewrite
  only `modelMap` values. Disposition: 020 now rewrites `intercept.modelMap` in the provider, routing-profile
  and combo rename paths, and records why the legacy OpenAI-id migration is excluded.

## Audit record

- Reviewer `01a0cdae-0b0c-7840-a1f4-30fdc5398854` (devin/swe-2, CXC-ROLE reviewer), round 1:
  GO-WITH-FIXES (blockers=1). Blocker 1 (native/ targets only normalized in the 3P-alias branch;
  PUT validation source unspecified) folded into 020: read-side normalization in
  `claudeCodeForIngress` and validation against the unfiltered Desktop route vocabulary. Notes folded:
  CSS in a new file (styles.css is at cap), picker-id keys are not migrated on renames, `ocx-route`
  precedence documented, scratch-server safety argument written into 030.
- Round 2: reviewer PASS. Architect reflection on r2: ALIGNED with one residual (normalize only the
  intercept entries, not merged global values), folded into 020.
