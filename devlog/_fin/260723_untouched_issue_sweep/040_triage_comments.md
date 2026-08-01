# 040 — GitHub Triage Comments for #320, #324, #326, #294

## Scope

Post English, evidence-backed triage comments on 4 issues. No code changes.

## #320 — Pool OK but native auth expired shows login

**Verdict:** Partially valid — CLI limitation + shim maintenance pain

**Comment plan:**
- Acknowledge the two distinct problems: (1) CLI login gate, (2) shim loss after npm update
- Explain CLI checks native auth.json before proxy intercept — this is upstream behavior
- Note that #327 (needsReauth exposure) will improve diagnosis when main credential dies
- Suggest: `ocx codex-shim install` after npm updates as documented workaround
- Label: the "pool should suppress CLI login" part needs upstream Codex CLI changes

## #324 — websockets:false returns 426

**Verdict:** Intended behavior + docs/UX improvement needed

**Comment plan:**
- Explain Design B: default websockets:false, 426 is the expected rejection
- Codex App should fall back to HTTP after 426 — if it does, this is cosmetic
- If it blocks, user needs `"websockets": true` in config
- Suggest: improve `codex doctor` message to explain this is expected with proxy
- Ask: does the 426 actually block functionality, or is it just a doctor warning?

## #326 — Tool-heavy WS continuation loop

**Verdict:** Needs-info — insufficient data for root cause

**Comment plan:**
- Acknowledge the report quality and distinct symptom from #215/#272
- Note: 200-response continuation is different from retry (distinct request IDs)
- Request: sanitized WS event sequence showing:
  - Whether `response.completed` events appear between continuations
  - Tool output submission pattern (new resp_* creation after tool output)
  - The bridge-side event log (if available via debug logging)
- Note: the second diagnostic (13 requests, no /goal) narrows the surface
- Offer: if reproducible on v2.7.34, maintainer can enable bridge debug logging

## #294 — Claude account pool feature request

**Verdict:** Roadmap park with acknowledgment

**Comment plan:**
- Acknowledge the feature request and parity argument
- Note HaydernCenterpoint's valid concern about Claude account security
- Explain: this is on the roadmap but not prioritized for near-term
- Reason: Claude's stricter session/account policies make pool semantics
  more complex than ChatGPT's (different rate limit structure, potential
  account risk)
- Park with "tracking for future consideration"
