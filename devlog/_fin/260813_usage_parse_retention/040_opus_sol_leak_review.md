# 040 Opus + Sol review

After 010-030 commits:

1. SHA=$(git rev-parse HEAD)
2. spawn_agent model=anthropic/claude-opus-5 reasoning_effort=medium. If tool rejects, spawn anthropic/claude-opus-4-6 and write fallback in 041_review_verdicts.md.
3. spawn_agent model=gpt-5.6-sol reasoning_effort=medium.
4. Packet both: Review git diff origin/dev...$SHA. Files: src/usage/log.ts, logs-usage-routes.ts, usage-summary-cache.ts, api-key-usage.ts, ws-upstream.ts if touched, GUI usage callers. H1/H2/H3 + falsifiers. Look for retained entries[], unbounded maps, aborted flights, WS backlog. End VERDICT: PASS | GO-WITH-FIXES (blockers=N) | FAIL. MUST NOT push/kill/read secrets.
5. Paste both finals into 041_review_verdicts.md under ## round-1 SHA.
6. If FAIL or High GO-WITH-FIXES: patch, commit, repeat steps 1-5 as ## round-2 SHA then ## round-3 SHA. Stop after round-3 and return to P if still FAIL.
7. PASS or residuals-only: continue to 050.
