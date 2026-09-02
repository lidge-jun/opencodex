# 060 — Phase 6 (wp6): Issue #3279 — dashboard 401 flap

## Finding (gpt-5.6-sol investigator, high effort)

VERDICT NEEDS_REPRO, confidence medium, auth-surface risk YES.

No intermittent invalidation mechanism could be established. An unexpired
session 401s only when absent/evicted or when its exact server-origin,
browser-origin, or CSRF binding fails (`src/server/gui-session.ts:417`);
loopback sessions otherwise expire deterministically after five minutes
(`src/server/gui-session.ts:62`, `:428`). Management auth state initializes once
per server process, so admin-token rotation is not involved
(`src/server/index.ts:653`). The GUI installs its auth wrapper before React
renders and its 401 recovery is single-flight (`gui/src/App.tsx:42`,
`gui/src/api.ts:247`, `:299`). The reported "online then offline" may be cached
health followed by the first failed authenticated poll
(`gui/src/pages/use-dashboard-data.ts:97`, `:220`, `:307`).

PR #3080 is NOT the same fix: it persists a 12-hour opaque session for remote
dashboards, is draft and conflicting, does not change the injected loopback
session path, and cannot survive a proxy restart.

## MODIFY / NEW / DELETE map

None. Making a production change here without the trace would mean weakening
loopback-origin equality on a guess, on an authentication surface.

## Action

Comment on #3279 requesting the exact failing request URL, the session meta
origins, whether the Authorization header was present, and the immediate
`GET /opencodex-session` result. The issue already carries `needs-info`.

Terminal outcome: NEEDS_HUMAN — reproduction requires the reporter's browser and
machine.


## TESTS — what would be RED, once the trace exists

No test can be written yet, and that is the finding rather than an omission: the
report supplies no constructible failing sequence, and the existing suite already
covers deterministic expiry and concurrent refresh. When the reporter supplies
the trace, the RED assertion is:

- `tests/server-management-auth.test.ts` — replay the captured Host/Origin/header
  request against a session that is still valid, and assert
  `GET /api/system/health` returns 200. This must fail on the then-current HEAD
  before any production change.
- `gui/tests/api-auth-memory.test.ts` — replay the first-401 →
  `/opencodex-session` → parallel-retry sequence and assert exactly one
  bootstrap, no admin-token prompt, and 200 for both health and providers.

Writing either test against a guess would encode the guess. That is why this
phase's terminal outcome is NEEDS_HUMAN rather than a speculative patch on an
authentication surface.

