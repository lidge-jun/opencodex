# 40 - Loop 4 Routing and Safety Results

Status: verified.

Date: 2026-06-24

## Checks

| Requirement | Status | Evidence |
| --- | --- | --- |
| Request log provider label distinguishes main `chatgpt` from pool `chatgpt-1`, `chatgpt-2`. | verified | `formatCodexProviderForLog` moved to `src/codex-routing.ts`; regression coverage remains in `tests/session-affinity.test.ts`. |
| Active account API returns expected next-session state. | verified | `GET /api/codex-auth/active` includes `activeCodexAccountId`, `autoSwitchThreshold`, and `upstreamFailoverThreshold`. |
| Auto-switch percent threshold applies to `max(5h, weekly, 30d when present)`. | verified | `computeCodexUsageScore` in `src/codex-routing.ts`; tested in `tests/codex-routing.test.ts`. |
| Existing `autoSwitchThreshold` remains a percent field. | verified | Quota threshold logic remains separate from `upstreamFailoverThreshold`. |
| Optional 30d quota data is parsed, displayed, and included only when WHAM/headers provide it. | verified | `src/codex-quota.ts` parses `tertiary_window`; `gui/src/pages/CodexAuth.tsx` renders 30d only when `monthlyPercent` exists. |
| Consecutive non-200 upstream responses are counted per selected Codex account. | verified | `recordCodexUpstreamOutcome` increments per-account failure state in `src/codex-routing.ts`. |
| Separate `upstreamFailoverThreshold`, default 3 and disabled at 0, controls failure failover. | verified | `src/types.ts`, `src/codex-auth-api.ts`, and `tests/codex-routing.test.ts`. |
| Future new-thread routing moves to lowest-usage available account after failure threshold. | verified | `tests/codex-routing.test.ts` covers three 503 responses then next-thread failover. |
| Existing thread affinity remains pinned. | verified | Existing thread id still resolves to the original account after failover in `tests/codex-routing.test.ts`; token refresh failure no longer deletes affinity in `src/server.ts`. |
| Redaction scan avoids newly committed raw token, refresh token, raw account id, or personal fixture. | verified | Tests use synthetic `*.test` emails and dummy tokens; devlog records only counts, statuses, and booleans. |
| Team/Business collision behavior remains covered. | verified | `tests/codex-auth-collision.test.ts` passed in the full test suite. |

## Safety Notes

- 401 upstream responses mark the account for reauth through `recordCodexUpstreamOutcome`; the picker excludes accounts marked for reauth.
- 2xx upstream responses reset the account failure streak.
- `upstreamFailoverThreshold: 0` disables failure-based failover without disabling percent-based quota auto-switch.
- The current implementation counts HTTP passthrough upstream responses. WS traffic still reaches `handleResponses`, but no separate WS-only status hook was added because the shared HTTP handling path records the selected account's upstream status.

Results: full static/build/test gates passed in Loop 2.
