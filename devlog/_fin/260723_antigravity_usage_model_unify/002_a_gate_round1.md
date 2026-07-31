A-gate adversarial review (main synthesis; Sol reviewer Bernoulli timed out after 3 waits — retired).

Grounded anchors:
- src/usage/summary.ts:312-313 aggregation key uses raw attribution.model; resolvedModel not identity
- src/usage/summary.ts:359-375 cost accumulation keys entry.model / attempt model raw
- src/usage/summary.ts:266 day-model key raw
- gui ProviderUsage.tsx:88-94 and Usage.tsx:487-488 prefer resolvedModel ?? model
- antigravity-models.ts effort/alias maps provide reverse-map source
- live /api/usage antigravity still 8 fragmented rows (3.5-flash-*, pro-agent, etc.)

Blockers folded into 010/020:
1. [High] cost rebucket must canonicalize
2. [High] GUI resolvedModel preference undoes collapse unless omitted/prefer-model
3. [Medium] day-grid canonicalize
4. [Medium] reverse map completeness + base+resolved wire pairs
5. [Medium] new base calls with resolved wire
6. [Low] preserve OpenAI virtual separation

Docs unit complete at devlog/_plan/260723_antigravity_usage_model_unify/.

VERDICT: GO-WITH-FIXES (blockers=6)
