# 003 — Roadmap audit record (wp0)

Reviewer: gpt-5.6-sol (agent 01a06835-bac8, medium effort), read-only, same reviewer for every
round (AUDIT-LOOP-01). Docs-only cycle; no gui/src or src/ change in this work-phase.

| Round | Verdict | Blockers | Folded in commit |
|---|---|---|---|
| 1 | fail | 8 — star capability loss, autostart phase gap, Build-time guesses in 010/020/040/080/090, wrong /api/codex/v2 endpoint, title-only a11y, details-as-menu, i18n verifier not real, PR-ready gate | 2492b80bc |
| 2 | fail | 9 — 002 contradictions, effort-cap /api/effort-caps rehome, Models must keep v2 state, 040 collapse rule, 060 title + pinRight scope, 070 protected expression, 080 handleAdd short-circuit, 090 locale paths, 010 star mount/tests | 8939f66e1 |
| 3 | fail | 3 — dialog always mounted (explicit conditional), UltraModeState/Patch contract per phase, Tooltip nests a button | ce461f9f7 |
| 4 | fail | 3 — d.apiBase, multiAgentMode constructor sites, Tooltip accessible name | 6c7fcd904 |
| 5 | near-pass | none; residual 090 orphan list | ca4315fa3 |

What the loop bought: every decade doc now names the exact endpoint, the exact constructor
sites of a widened type, the exact conditional mount, and which phase owns each contract
change, so the implementation cycles can fail only on execution, not on plan ambiguity.

Verifiers run by the reviewer during the rounds: sidebar-rows 5/5, integrations-surfaces
34/34, locale-parity 5/5, multi-agent-guidance 4/4, gui lint:i18n exit 0.
