# Independent regression acceptance

The integrated source at `0818ea1812a028e1c14cd0b0511b44863407bc52`
(tree `98c6c2f05364c8274d404ae5f6ecc56bb73450d2`) is accepted for the next
complete candidate CI run. Production publication remains pending.

Four fresh-context workers ran in parallel with disjoint temporary state and
shared test locking. All 63 selected original test files executed: **2,423 pass,
0 fail, 0 skip**. Separate current-source GUI verification passed 48 tests;
a separate runner-isolation preflight passed 25. Those counts are not added to
2,423. The candidate GUI build succeeded and its 94 generated artifact hashes
remained unchanged through the manual browser verification.

| Area | Original tests | Additional acceptance |
| --- | ---: | --- |
| Native accounts, catalog and fallback | 990 | Seventeen HTTP scenarios and the actual account CLI, including revoked versus transient credentials, replacement races, hard locks, precise model refusal and committed output. |
| Request bytes, compaction and tool history | 370 | UTF-8 threshold captures, destination and cancellation controls, typed Messages errors, recovery limits, and ordered immutable Ollama tool history. |
| Pairing, identity and existing-format accounting | 363 | Actual CLI minting, HTTP redemption, browser interaction, identity race negatives, capacity refusal, and durable legacy-journal restart/corruption. |
| Provider, platform, CLI and historical fixtures | 700 | Discovery and saved-effort persistence across processes, operator commands, synthetic launcher controls, and eight separately executed original historical files. |

A fresh independent acceptance review found no blocker to final candidate CI.
Two independent visual reviews found only Low wrapping and validation-layout
polish issues, with no observed clipped text or blocked controls. These are
retained follow-ups, not claimed fixes or a complete accessibility audit.

## Evidence limits and failed attempts

Failed harness executions remain failed in the private evidence ledger. They
were not overwritten or included as passing executions. Corrected probes use
source-backed fixture contracts. Two request-probe expectations received a
separate independent adjudication: cancellation prevented another physical send
although the legacy reset-only counter remained zero; a preflighted compaction
stream legitimately returned HTTP 400 rather than the HTTP 200 required for an
already-open Messages stream. Neither result proves complete legacy accounting
or preservation of client-visible partial compaction text.

Manual expiry evidence proves rejection of an expired signed mint capability,
not expiry of an issued pairing code. Current CLI/HTTP/browser pairing passed;
full native SSH enrollment at this candidate was unavailable. Earlier native
join/replacement and teardown evidence remains historical. The named pairing
owners are byte-identical, which does not make that a fresh integrated native run.

Every one of the 20 uniquely named assertions from the earlier broad failed run
maps to a current pass in its original file. The former GUI setup error has
current original-file coverage as well. This does not certify the old broad run
or identify its historical state writer; its original 21-failure/one-error total
is preserved. Complete cross-platform CI is still required.

The original Antigravity Windows/multi-account report remains unproven, the real
launcher scenario remains unavailable, and packaged Windows login behavior is
not established by native helper/parser tests. The canonical spend migration
remains excluded; the landed capacity repair preserves the existing format.
Previously recorded accounting, diagnostic and dependency limitations remain
explicit. No current required product failure was waived by those limitations.

All owned processes, listeners and disposable homes were closed or removed;
source and build identity were rechecked. The artifact validator only proves
schema/source consistency; semantic acceptance comes from the reviewed scenario
matrix and the explicit dispositions above.

Next: run the complete `lane=all` CI at the accepted source SHA, inspect every
requested job, then follow the separate version pre-move, promotion and publication
procedure. This documentation record adds no product changes to that source.
