# WP3 — integration verification + close-out

## Scope
- Full `bun test` + `bunx tsc --noEmit` fresh evidence run.
- SoT sync (SOT-SYNC-01): locate repo source-of-truth docs (structure/ or docs/) that document
  provider capability flags / adapter behavior; patch them to mention `parallelToolCalls`.
  If none exists for adapter capabilities, record recommendation in D summary instead.
- Final adversarial review: fresh gpt-5.5 reviewer over the WHOLE unit diff (git diff of all
  changed files), instructed to attack: bridge sequential contract violations, replay/history
  correctness with synthesized ids, catalog regressions for cursor/zai, request-body regressions
  for non-optin providers, and the content ""-vs-null change blast radius.
- OUT: new features, live API probes (recorded as follow-up; needs keys/quota decision).

## Accept criteria
- Full suite pass + typecheck exit 0 (captured output).
- Reviewer verdict PASS or GO-WITH-FIXES with every blocker folded/rebutted (recorded here).
- Goalplan criteria c1-c6 all met with capturedEvidence.
- D summary records: what shipped, evidence paths, LOOP-PESSIMIST-01 (what was not proven:
  live xAI behavior, Z.AI flag honor question), and follow-up recommendation (live probe).

## Execution record (2026-07-09)
- SoT sync: structure/04_transports-and-sidecars.md gained "Parallel tool calls (per-provider
  opt-in)" section.
- Final adversarial review (fresh gpt-5.5 reviewer): round 1 GO-WITH-FIXES, 1 High blocker —
  mixed index/id continuation split one logical call into two sequences sharing a call_id
  (probe-proven). Fix: rescue-by-provider-id lookup before the create-new-call branch
  (src/adapters/openai-chat.ts) + regression tests T9/T9b. Closure round: VERDICT: PASS.
- Final gates: bun test 1718 pass / 0 fail across 174 files; bunx tsc --noEmit exit 0.
- LOOP-PESSIMIST-01 (not proven, follow-ups): live xAI multi-call behavior against api.x.ai
  (needs key/quota decision); whether Z.AI honors parallel_tool_calls:false (unknowable from
  docs — keep zai disabled); whether xAI accepts content:"" in every history shape (the ""
  hardening makes the safe direction more likely, langchain#34140 evidence). Recommended next
  unit: live probe script + soak, then consider Mistral/OpenRouter opt-in.
