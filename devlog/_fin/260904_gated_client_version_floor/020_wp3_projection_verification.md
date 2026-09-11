# 020 — wp3: projection verification on a stale-runtime host

The resolver fix is only meaningful if the rows reach the surfaces the user actually looks at.
This phase proves the path from a granted entitlement to a visible model, on a host whose
persisted runtime is `0.141.0`.

## What to verify

1. `availableAccountGatedNativeModels` includes sol/terra/luna once the roster confirms them.
2. The bare OpenAI list shape (no `client_version`) lists them.
3. The dashboard model rows path (`src/server/management/model-rows.ts`, which passes no
   client version and therefore depends entirely on this fix) lists them.
4. The effort clamp still removes `max`/`ultra` for a 0.141.0 runtime. This is the control:
   the fix must NOT accidentally re-advertise efforts the local binary does not list.

Explicitly NOT claimed: `/v1/models?client_version=0.141.0` continues to omit the rows. Tier 1
answers a self-declared stale client for the version it declared, which is the #2548 contract.
A stale Codex CLI is fixed by upgrading the CLI, not by the proxy overriding what the client
said about itself. See `005_audit_synthesis.md`.

Also not claimed: that a cold first dashboard poll always shows the rows. `model-rows.ts`
waits ~3s while a fetch may take up to 8s. That degradation predates this unit; WP3 asserts
visibility on a warm read.

Point 4 matters as much as the first three. Fixing entitlement visibility while silently
widening the effort ladder would trade a missing-model bug for a broken-request bug.

## Method

Focused tests over the projection helpers, plus a scripted resolution against a fake upstream
that mirrors the measured behaviour (gated rows returned at or above `0.144.0`, absent below).
No live account credentials are used, and no request bodies or tokens are logged.

## Out of scope

Changing runtime selection, the clamp, or the desktop-app detection question. Those are
recorded in `000_research.md` as considered and deferred.
