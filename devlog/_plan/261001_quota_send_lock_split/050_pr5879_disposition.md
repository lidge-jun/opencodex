# 050 — wp5: #5879 auto desktop-authless disposition

Decision: **no carried PR; rationale only.** #5879 is closed with credit after the
split PRs are up.

Reasons (read-only review against `64294638`):

1. Requirement conflict: #6196's reporter requires the signed-in account to stay in
   the UI. Authless removes the account plane (usage, Fast, plugin/thread identity),
   and the 260928 design rejects `requires_openai_auth = false` as the fix.
2. Disruption: every transition calls `performCodexRestart()`, restarting Desktop and
   app servers from a background sweep without user consent.
3. Recovery proof is unsound on today's API: `refreshCodexQuotaForActivation()`
   returns silently for unavailable leases/reauth/missing credentials and
   `isCodexQuotaExhausted(null)` is false, so unknown state releases authless.
4. Persists before injecting, restarts even when injection fails, and the next sweep
   sees the stored state and never retries; overwrites the manual
   `codexDesktopAuthless` preference.
5. Overlap: wp1 lowers the short-window threshold so opencodex traffic leaves the
   main account earlier, and wp2 addresses the client gate directly without leaving
   the signed-in mode.

A revised proposal would need authoritative recovery evidence, a separate automatic
state that never overwrites the manual preference, retry of failed application, and
deferred restarts.

