# Logs table polish (260706)

User request (GUI #logs, mobile-first complaints):

1. Cache tokens shown as `c 6.9만` — "cache" label shortened to `c`, one decimal place.
2. One-decimal rounding applies to the main token figure too.
3. Request id: ellipsis clamp, max 2 lines (no more table blowout).
4. Error column too wide relative to its value; shrink it, give space back to others.
5. Error display: status code (e.g. `502`) + a "details" affordance that opens a
   popup (modal) with the detailed log for that request + a per-code explanation
   (429 = rate limit, etc.), localized en/ko/zh.

## Work phases

- P1: format-tokens one-decimal change + Logs cache `c` prefix. Criteria: ko shows
  `6.9만`, en shows `176.6K`-style; cache renders `c 6.9만`.
- P2: request-id clamp + column width rebalance (error narrow). Criteria: 399px
  screenshot shows 2-line-max request id, error column narrow.
- P3: status-code dictionary (subagent gpt-5.5 building gui/src/status-codes.ts)
  + row detail modal with code explanation + raw log JSON. Criteria: clicking a
  row / details button opens modal; 429/502 show localized label + description.
- P4: i18n keys en/ko/zh, rebuild, Playwright screenshots (mobile+desktop), tsc.

## Evidence ledger

- (pending)
