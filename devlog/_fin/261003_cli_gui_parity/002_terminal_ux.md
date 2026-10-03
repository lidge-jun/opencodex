# Terminal UX contract

This is a repeated-use management tool for people and automation. The design preserves the compact root help and contextual family navigation delivered by the CLI help stack; it extends task coverage without turning the terminal into an endpoint debugger.

Design variance: 2/10. Motion: 1/10 (no decorative animation). Density: D8 for the full reference, progressive disclosure for first use. Monospace, plain text and predictable line ordering carry meaning; color or symbols never determine correctness. Raster concepts do not help this utility surface and are intentionally omitted.

## Task language

- Extend existing nouns before adding new roots. Prefer list/show/status, set/update, enable/disable, apply/reset and their established domain equivalents.
- A family with no action offers a safe overview/help or an existing read-only default. It must never silently choose a write.
- Help is available without a live proxy and never runs a management action. Examples use registered grammar and placeholders, with a next read/verify command after a mutation.
- Short human output answers what changed, what remains unapplied and the next action. JSON preserves safe API DTO fidelity on stdout; diagnostics stay on stderr and failures keep documented exit codes.
- Empty lists distinguish no configuration, no matching rows and unavailable evidence. Do not render unavailable as zero or an empty successful inventory.
- Unknown/missing/duplicate arguments must fail before network writes. Boolean and numeric syntax reuse established parsers; structured inputs receive bounded, explicit JSON file/stdin forms only when the task's data shape needs them.
- IDs and names are encoded at path/query boundaries. No arbitrary method/URL command is counted as GUI parity.

## Writes and recovery

Existing management routes remain the source of validation, persistence, ownership and live application. A saved configuration is not proof that the client/runtime applied it; preserve refusal, partial application and restart-needed fields in output.

Destructive operations retain explicit confirmation or preview as appropriate to the existing command family and server contract. Read, preview, apply and verify are distinguishable operations. No hidden retry of non-idempotent writes. New commands do not expand account identity, browser consent or secret-returning authority.

No-running-proxy output names the recovery command. Invalid input names the argument and expected syntax without leaking its value when secret-bearing. Server errors preserve meaningful reason/hint fields and failure exit codes. Tests activate server refusal, not-found/conflict, malformed arguments and non-confirmed mutation paths.

## Discoverability and skills

The capability registry, help resolver, generated management reference and human recipes describe the same supported commands. Existing undeclared commands must be mapped before declaring a gap. Skill recipes start with readiness/version checks when operating a real proxy, then task-specific commands and verification. Human-only exclusions stay explicit and do not gain an API workaround.

Each inventory row records GUI task, existing API contract, existing CLI route, implementation/discovery gap, final command and verification, or a reasoned exclusion. Coverage is measured against user tasks, not endpoint count or lines added.
