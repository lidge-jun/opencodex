# 005 — Architect consultation record

- **Architect:** GOAT design task `lcu-wp0-architect-1`, inherited model `anthropic/claude-opus-5-5`
  at high reasoning effort, read-only in the unit's checkout at `dev` 00680193cb.
- **Proposal:** [004_design_proposal.md](004_design_proposal.md), decisions D1–D21, phases P1–P9, findings F1–F7.
- **Main dispositions:** [000_plan.md](000_plan.md) "Architect consultation" table and amendments A1–A5.
- **Executable plan sent for reflection:** 000 plus decade docs 010–090 as first written by the plan writers.

## Reflection (same architect)

Verdict: **MISALIGNED**, narrowly. Every decision D1–D21 is implemented or deliberately amended; the architect
accepted A1–A4 and every writer deviation except the justification behind 080's `child` widening.

| Gap | Finding | Main disposition |
| --- | --- | --- |
| G1 (must fix) | 020's `validateChildOps` rejected unknown keys inside `child` and required `codex === null`; 080 later adds `childBuild` and a `codex` object, assuming wp2–wp8 ship in one release. `dev` releases every few days, so a CLI released between wp2 and wp8 would fail `ocx link status` and the `ocx sync` fan-out status read against a later Home. | Folded. 020 now type-checks known keys, ignores unknown keys inside `child`, accepts `codex` as null or an object, and adds an extra-key test; 080's one-release sentence is replaced. |
| G2 (should fix) | `ocx link check` exited 1 for an older Home while the wp3 verbs exit 4 through `runCliAction`. | Folded. 020 routes `check` through the same wrapper (404 → 4, 409 → 5). |
| Note | wp5 depends on wp4 without using it. | Kept: phases land serially, and 040's skip rules are exercised by 050's fan-out tests. |
| Note | 050/070 call the engine method `holder()`, 020/030 `activeJob`. | Code uses `activeJob`; each phase's P re-verifies names against the merged code. |
| Note | Desktop Children never auto-update, even after 080. | Amended beyond the architect (A5): from 080 the sweep admits `desktop-request`. |
| Note | A1 changes behaviour on upgrade. | 070 and 090 now require docs and release notes to state it with the opt-out. |

The reflection's full decision-to-section and deviation tables were produced in the architect's working notes;
their conclusions are summarized above. A5 changes a documented decision (D17), so the independent audit reviews
it directly rather than through another architect round.


## Independent plan audit

- **Round 1** (review task `lcu-wp0-audit-r1`, inherited model, high effort): VERDICT FAIL with blockers
  H1–H5 and M6–M11. Every finding was accepted except L17 (outline-level TSX in 060 and `start_poll` I/O in 080),
  which stays a residual to be made diff-level at those phases' own P. A repair lane applied the dispositions; each
  changed doc carries a "Revision 2 (audit r1)" note.
- **Round 2** (same reviewer, `lcu-wp0-audit-r2`): all eleven blockers CLOSED, no new High or Critical finding,
  VERDICT PASS. Residuals R1 (Medium: transient busy results exhausting the attempt cap), R2 (exit-code mismatch for a
  withheld restart), R3 (defensive `plan-expired` branch), R5 (launcher validation) and R6 (scope of "must name its
  links") were folded by the lead in "Revision 3" notes in 030 and 070 and in 010 and 000; R4 (Windows link without a
  recorded platform fails safe) is accepted as is.

