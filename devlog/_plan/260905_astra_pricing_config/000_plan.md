# Astra pricing and configuration parity

## Loop specification

- Class/archetype: C3, one cohesive spec-satisfaction PABCD work-phase (`astra`).
- Trigger/goal: refresh the reference Codex checkout, fill Astra configuration and pricing gaps, and land a verified PR on `dev`.
- Non-goals: no live proxy restart, user-home config writes, credential changes, release, new provider destination, or unrelated catalog refresh.
- Scope: existing catalog, OpenAI API registry, price declarations/estimator, adjacent tests and provider documentation.
- Verifier: focused pricing/catalog/API contract tests, typecheck, privacy scan, docs build, remote full suite, exact-head CI and merge ancestry.
- Stop: all goalplan criteria proven; unavailable evidence is recorded, never treated as free usage or successful inference.
- Memory: this unit plus session-bound goalplan/ledger. Implementation: `010_parity.md`.
- Outcomes: DONE/NOOP with proof; NEEDS_HUMAN/UNSAFE for new authority; external BLOCKED or 3-hour BUDGET_EXHAUSTED are not completion.
- Resources: at most two inherited-model subagents and one bounded Aside read at once; no paid inference probes/purchases; only named checkout, local scratch, isolated macmini-cf verification directory, and authorized GitHub PR writes.
- Delegation: read-only inventory and plan/final review. Main reclaims after two distinct failed dispatches; worker delegation would require a plan amendment.
- Delivery: commit; push `--no-verify`; template PR to `dev`; record owner-authorized admin bypass; merge only on exact-head green CI; fetch and prove ancestry. No self-approval.

## Baseline and sources (2026-09-05 KST)

Reference `openai/codex` main fast-forwarded from `7a7c18868` to `d2d5b70241fb448044c1c088a977cc720d70443a`; untracked bookkeeping preserved. OpenCodex started clean, equal to `origin/dev`, and adopted branch `codex/astra-pricing-config` in place.

Aside rendered these official pages, not search snippets:

- https://developers.openai.com/api/docs/models/gpt-6-astra : API input/cache-read/cache-write/output USD per million = 10/1/12.5/50; >272k reprices the whole request to 20/2/25/75; API Fast doubles the applicable rate.
- https://developers.openai.com/api/docs/pricing : explicitly selected Fast radio; Astra short 20/2/25/100 and long 40/4/50/150. GPT-5.6 Sol/Terra/Luna also publish combined Fast+long rows. API Fast and long are no longer exclusive.
- https://learn.chatgpt.com/docs/pricing and `/docs/agent-configuration/speed` : Astra native Fast 2.5x; native standard 250/25/1250 credits per million input/cache-read/output. GPT-5.6 native Fast is also 2.5x, unlike API 2x. Credit purchase cost is agreement-dependent. These pages do NOT establish a native 272k surcharge or a separate cache-write charge; absence does not prove free tokens.

Decision: never apply API long bands to native Astra by inference. Native dollar display remains a documented API-equivalent estimate, with native Fast multiplier and derived provenance, not an invoice/credit conversion. Direct API receives the published long bands. The claim 'no charge after 272k' is contradicted for API; native has no separately published threshold in the inspected rate card.

Local `bun install --frozen-lockfile` supplied missing dependencies without lockfile changes. Baseline `bun test tests/usage/usage-cost.test.ts tests/codex-integration/native-model-toggle.test.ts`: 121 pass, 0 fail, 609 assertions (the first pre-install attempt failed on missing zod/v4). Direct arguments observe both target subsystems. Additional verifier commands are checked during C; prose is independently reviewed, not validated by phrase-existence tests.

## Existing ownership and necessity

Searches: `astra`, `PRIORITY_MULTIPLIERS`, `confirmedPriorityRelation`, `gpt-5.6-sol`, `service_tier`, `modelContextWindows`; inspected catalog metadata/native set, registry, price declarations and both estimator call sites. Reuse those owners. Do-nothing leaves null Astra prices; deleting support contradicts request; user-only configuration would not fix defaults. No new price subsystem or migration is needed. Existing large registry/estimator files are extended narrowly, not split opportunistically.

SoT sync: `structure/03_catalog-and-subagents.md` and canonical provider reference. Preserve already-correct native 272k default/872k opt-in, low default effort, low-through-ultra ladder, v2, and visibility policy.
