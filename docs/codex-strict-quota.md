# Strict Codex pool quota admission

Strict quota admission is opt-in. It uses the existing account selector, threshold,
manual pin, credential store, and quota endpoints. It does not introduce another
account selection strategy.

To keep using a manually selected account until its threshold is reached, select
`fill-first` and enable strict admission in the configuration:

```json
{
  "accountPoolStrategy": "fill-first",
  "autoSwitchThreshold": 95,
  "codexAccountStrictQuota": true
}
```

The existing `PUT /api/codex-auth/auto-switch` management endpoint also accepts
`{"threshold":95,"strictQuota":true}`. Omit `strictQuota` to keep its current value.
`GET /api/codex-auth/active` reports `codexAccountStrictQuota`. Existing management
authentication requirements apply. There is no new GUI control.

## Selection and recovery

- A stored pool account is eligible only when its observed shared quota windows
  are below the configured threshold. The effective ceiling is 99%, even if the
  configured threshold is 100%. Setting the threshold to zero disables this
  admission policy, consistent with the existing auto-switch control.
- A manual selection and thread affinity cannot override the quota gate. With
  strict `fill-first`, an eligible selected account stays active until it is
  unavailable, including accounts selected automatically. Higher-priority accounts
  that recover do not preempt it. When another account is needed, higher selection
  order numbers are preferred. This reuses the existing priority-tier selector
  without creating a persistent manual pin for an automatic selection.
- A below-threshold snapshot is usable for five minutes. Unknown or stale quota
  triggers a coalesced usage read before selection. Failed reads also receive a
  five-minute backoff; they do not turn unknown quota into zero usage.
- A measured block survives stale cache data, token refresh, and predicted reset
  deadlines. A new valid quota reading must establish recovery. Partial or
  credits-only responses cannot clear another window's known block.
- Only pending requests own recovery timers. Usage reads are shared and bounded;
  with no pending request this feature performs no periodic work. A predicted
  reset can schedule an earlier verification. Manual usage refreshes wake pending
  requests. Unexpected upstream resets are discovered by the next due usage read.
- This feature never redeems reset credits. Existing separately configured reset
  automation is independent and must remain disabled when manual redemption is
  desired.

## Request boundaries

A recognized pre-stream quota refusal may try each available account once. When
all candidate accounts are quota-blocked or unknown, a Responses request waits
for new evidence. Streaming requests emit `response.heartbeat` while waiting and
then forward the real upstream stream. Cancellation and service drain terminate
the wait and release its resources. Waiting does not synthesize a completed
response.

Ordinary server errors, an uncertain WebSocket execution outcome, and a stream
that already produced output do not authorize this cross-account replay. The
existing stored-account 401 replay budget remains bounded across waiting cycles.
Client or network disconnects still terminate requests; this is not durable job
storage and does not promise recovery after the proxy process exits.

Explicit Direct credentials and independent Spark/Reserve quota authorization
retain their own policies. An explicit account namespace does not silently switch
to another account. Authentication failures and operator-paused accounts remain
unavailable until their actual cause is repaired.
