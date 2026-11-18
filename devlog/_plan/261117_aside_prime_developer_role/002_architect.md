# 002 Architect consultation

Architect: GOAT task `8864 architect proposal` (codex / morph/morph-dsv41flash-1017 / high), taskId `node:delegated-task:command%3Amcp%3Ac3afd7e6-ac4c-4c65-869d-a60b474983db%3Adelegate-task%3Af77ce816-f294-488c-a6c3-4c13667738f4`. Read-only design pass; it ran no tests.

| ID | Architect | Main disposition |
|---|---|---|
| D1 Prime/Aside get `{ foldDeveloperRole: true }` on all four call sites | ACCEPT + amend: `tests/providers/aside-client.test.ts:82` asserts the exact provider key set and breaks | Accepted with the amendment: the Aside key-set test changes to "Pi's block minus sendSessionAffinityHeaders" in the same commit (010). |
| D2 Pi-family regression test | AMEND: `summarizePi` is not exported; discover structurally (opencodex block, openai-* api, `thinkingLevelMap` rows), assert the floor set; register in layout-clients.json and the expected fixture | Accepted. The floor is a superset check, so a new Pi-builder client fails on its missing compat flag instead of on set equality. |
| D3 Alibaba presets record the fold | ACCEPT; open question on the `alibaba` Coding Plan preset; test needs explicit layout registration (no `alibaba` seed) | Accepted. `alibaba` stays out: the user's ruling names exactly the two Token Plan presets and the 400 evidence is Token Plan. Recorded as residual risk in the PR. |
| D4 `src/lib/developer-role-rejection.ts` keyword verdict | ACCEPT + tighten (4xx, string, 4096 scan, three whole phrases) | Accepted as tightened. |
| D5 client sentence in `actionableRefusalMessage` | AMEND: must sit after the structured-token check and before the carrier-code gate, else it never fires; contract early return still wins | Accepted. Also gated on `code` being null or `invalid_request_error`, so a cyber-policy or overflow code is never relabeled. |
| D6 validation pair in `recordUpstreamValidationDetail` | ACCEPT; keep `boundedFailureDetail` as validator | Accepted. |
| D7 integrations guide sentences | ACCEPT | Accepted. Translated integrations.md copies exist (ko, ja, es, fr, ru, tr, zh-cn, zh-tw); an added English sentence does not contradict them, and the PR notes that the translations lag. |
| D8 one Pi-family descriptor helper | NEW | Rejected for this PR: D2's test discovers clients by document shape, so it catches every current and future Pi-builder client writing `providers.opencodex`; a helper would rewrite the pi/omo/gentle-shell entries outside the issue's scope. Residual: a Pi-builder client writing under a nested path (as `dsh` does, `config-export/dsh.ts:138`) would evade discovery. |
| D9 OMP emits no compat | NEW, out of scope | Recorded as a follow-up in the PR; not changed here (OMP uses its own builder and contract). |

## Reflection

Same architect (thread.send to its child thread, task `...thread-send%3A8864-arch-reflect-1`): MISALIGNED, dispositions faithful, with these gaps and main's dispositions:

| Gap | Disposition |
|---|---|
| 1 `isRecord` undefined in request-log-failure-detail.ts | Folded: 020 adds a local `isRecord` helper. |
| 2 missing `ValidationIssue` and `isDeveloperRoleRejection` imports | Folded: 020 shows both imports. |
| 3 phrase scan would also read proxy-formatted bodies (`core-combo-failure.ts:103`), against `error-detail.md` "a body this proxy formatted is not provider evidence" | Folded: the phrase branch runs only from `recordUpstreamProviderErrorDetail` (provider-body callers) via an option; `recordUpstreamValidationDetail` called directly keeps validation-only capture. |
| 4 D3-alibaba rationale claimed Token-Plan-only evidence | Corrected above. |
| 5 D7 claimed no translated copies | Corrected above. |
| 6 D8 rejection sound; nested-path residual | Recorded above. |
| 7 D9 deferral sound (`OmpProviderBlock` has no compat) | No change. |

No design decision changed (module responsibility, data structure and flow stay as D4-D6), so no second reflection round is needed.


## Audit round 1

Reviewer: GOAT task `8864 plan audit` (codex / morph/morph-dsv41flash-1017 / high), `...delegate-task%3A8864-audit-r1`. VERDICT: GO-WITH-FIXES (blockers=0); check 1 (public error-schema change): NO. Findings folded into 001/010/020: 1 layout.json registration for the lib and server tests; 2 pair scoped to provider-body paths, client sentence independent on translated Chat; 3 `responses/` path segments; 4 overridden intl base-URL test case; 5 discovery limit recorded; 6 line citations.
