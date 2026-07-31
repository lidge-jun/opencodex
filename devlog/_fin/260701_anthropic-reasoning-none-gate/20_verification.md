# Verification plan - anthropic reasoning "none" gate

Date: 2026-07-01
Status: SCAFFOLD (to run during B/C of the fix).

## Red test first (must fail before the fix)

Add to tests/ (anthropic adapter build test):

1. reasoning "none" => NO thinking, sampling preserved
   - buildRequest with options.reasoning = "none", temperature = 0.3, topP = 0.9
   - assert body.thinking is undefined
   - assert body.temperature === 0.3 and body.top_p === 0.9
   - (pre-fix: FAILS - thinking enabled, temp/top_p deleted)

2. reasoning "high" => thinking still enabled (no regression)
   - assert body.thinking.type === "enabled"
   - assert body.max_tokens > body.thinking.budget_tokens
   - assert temperature/top_p dropped (extended-thinking rule)

3. reasoning absent (undefined) => no thinking, sampling preserved
   - confirms the disable path matches the absent path

## Live wire confirmation (resolve the open question)

Before finalizing, capture one real Responses request where the user set
reasoning to its lowest/disabled setting and confirm what arrives in
parsed.options.reasoning ("none" vs undefined). Adjust the sentinel set in the
gate if the wire uses something other than the literal "none".

## Gates

- bun x tsc --noEmit -> exit 0
- bun test tests/<anthropic-build>.test.ts -> new cases green
- bun test ./tests/ -> no regressions
- bun run privacy:scan -> passed

## Done criteria

- "none"/disabled never sends thinking and never strips temperature/top_p.
- All non-disable efforts behave exactly as before.
- Red tests above pass; full suite clean.
