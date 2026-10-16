# Preserve reasoning provenance and transport intent

Readers: maintainers choosing whether to integrate the thinking lane. Raw reasoning must remain content, while provider-authored summaries can be displayed under an explicit provider default. The plan reconciles #4301 and #4287, separately reviews #3652 hint suppression, and carries #4130 Spark compatibility without retirement.

Loop: satisfy-spec HOTL, triggered by authorized thinking-lane delivery. Goal: reviewable carry PRs and final-head hosted CI. Non-goals: merges, closure of source PRs, retirement #4334, releases, user service/config changes, other worktrees. All local product suites/build/typecheck/install are NOT RUN by instruction. Only available existing credentials/tools are used; no user token/time/agent ceiling was set. Stop: every source PR has a justified disposition and every delivered branch has exact-head hosted CI evidence. Outcomes: DONE on evidence, HOLD/NEEDS_HUMAN on explicit unresolved acceptance, never fake green. Escalation: real tool denial or requirement beyond scope; main reclaims after two distinct reviewer failures. Native architect selector is unavailable; inherited independent design review and reflection follow the user instruction, with a separate A audit.

## Dependency map

| Cycle | Artifact | Result |
| --- | --- | --- |
| roadmap | this file and all decade docs | docs-only plan lock |
| presentation | 010_presentation.md | raw/summary contract and provider opt-in |
| hint | 020_transport_hint.md | independent transport-hint disposition/carry |
| spark | 030_spark.md | independent Spark Lite carry |
| delivery | 040_delivery.md | final heads, review closure and hosted CI |

Presentation combines two conflicting source proposals into one contract. Hint and Spark are independent and receive ordinary dev-based PRs, not artificial stack dependencies. Final review consumes all branches. No GitHub native stacks are requested.

## Evidence and owner map

Baseline origin/dev: 69e3dcda755a52feb1327edad6c8ea6cefd6e871. Source PR heads: #4301 5d6d1862a11da6e4d0c04eb7f35f9f48ae1285fd; #4287 fe13bdb7bf8403a2a2cdb10f258a68b649177953; #3652 13fb263778e9036e66ae86d41e29f9f47bbbed92; #4130 5d56f5461ea3d18668b85f6bb0d8a523920f2536. All open when inspected. Original authors: Robin Bially, yxr1995-maker, itismyfield, luvs01; exact Git trailers will be read from original commits before carrying.

Current owners: src/bridge.ts:663 raw-reasoning finalization; src/adapters/google.ts:571 shared part classifier; src/server/responses/core.ts:2490 final-route normalization; src/responses/parser.ts:543 summary omission policy; src/types/request.ts:310 AdapterEvent. Reuse these boundaries; no new event enum or generic service layer. Structure INDEX maps shared areas to topical documents; main contracts are providers/chat-compat.md, providers/google.md, transports/responses.md and config.md with references from affected area owners.

Verification: git diff --check was run at baseline and exited 0, checking diff whitespace only. GitHub ci.yml workflow_dispatch lane=all reads checkout source, typechecks, runs product suites and cross-platform jobs; NOT RUN locally. Every conditional scenario is named in decade docs and must be asserted in committed regression tests. Source inspection is not runtime proof.

## Cycle records

Roadmap P: requirements/source inspection and independent design review in progress. No product patch applied.

Roadmap B: locked amended contract after independent A PASS and both design reflections ALIGNED. Product implementation starts in the next cycle.
