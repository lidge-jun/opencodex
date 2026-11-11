# Child disconnect follow-ups (O7, O8, O9, O10)

Stacked on #8529 (`fix/child-restart-desktop-owned`). Field reports: six Remote Link Children moved to new SSH aliases on 2026-11-11, OpenCodex 2.100.2.

| Unit | Doc | Kind | Outcome wanted |
|---|---|---|---|
| O8 | 010 | defect, test-first | a refused disconnect never leaves state that stops the runtime from starting; a retry finishes or rolls back from `prepared`, including a receipt already stuck on 2.100.2 |
| O9 | 020 | defect, test-first | disconnect succeeds when Codex edited config.toml after injection and no OpenCodex line remains; never overwrites Codex or user lines; keeps the journal while an OpenCodex line remains |
| O7 | 030 | message, test-first | each `desktop_lifecycle_unsafe` refusal names the path or condition and the fix, code at the end |
| O10 | 040 | research + proposal only | what a safe "restart Codex clients" is and where it belongs |

Order: O8 and O9 share `disconnectClient` and land together (O9 makes the O8 retry succeed); O7 next; O10 is a written proposal in the PR body.

Verification floor: each new test fails on the base branch first; `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`, the layout guards, and the files that import the changed modules.
