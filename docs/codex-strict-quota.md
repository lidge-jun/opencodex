# Strict Codex pool quota admission

Strict quota admission is opt-in. It uses the existing account selector, threshold,
manual pin, credential store, and WHAM quota metadata endpoint. It does not introduce
another account selection strategy.

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

- `autoSwitchThreshold` is a soft preference. When strict quota is enabled, selection
  first filters for actually usable accounts (credentials, pause, reauthentication,
  cooldown, model, and hard quota state), then prefers an account below the threshold.
  If none is below it, the current usable account may continue with any remaining
  quota below 100%. Only a confirmed 100% window is a hard quota block. When every
  usable account is truly exhausted, the request waits for new evidence.
- A manual selection and thread affinity cannot make a paused, cooling, reauth-needed,
  model-ineligible, or 100%-blocked account usable. With strict `fill-first`, an
  eligible selected account stays active when no below-threshold replacement exists.
  Higher-priority accounts are preferred when a switch is possible; this reuses the
  existing priority-tier selector without creating a persistent manual pin for an
  automatic selection. The independent `codexMainAccountHardLock` protection switch
  remains separate and may still restrict the main account; strict quota does not
  promise to override it.
- Quota reads use the WHAM metadata endpoint. Selection merges concurrent reads and
  uses a short 10-second cache; a failed read earns a five-minute backoff. A reset
  timestamp only makes the next metadata read due and never implies that quota has
  recovered. Unknown or stale quota is never treated as zero usage.
- A measured block survives stale cache data, token refresh, and predicted reset
  deadlines. A new valid quota reading must establish recovery. Partial or
  credits-only responses cannot clear another window's known block.
- Only pending requests own recovery timers. Usage reads are shared and bounded;
  with no pending request this feature performs no periodic work. Manual usage
  refreshes wake pending requests. This feature sends no warmup model requests and
  never redeems reset credits.
- Selecting main or enabling strict quota while main is active reads its identity-bound
  usage in the management operation. If main usage is missing after startup or has
  gone stale, a real waiting request requests metadata through a separate owned main
  profile claim. Caller-owned authentication still does not read local credentials;
  a failed metadata read keeps the request waiting with backoff.

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
