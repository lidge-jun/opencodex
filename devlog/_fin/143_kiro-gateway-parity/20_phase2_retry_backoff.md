# Phase 20 — Retry / backoff on transient upstream failures

## Problem
Gateway (network_errors.py) classifies 403/429/5xx as retryable and retries.
opencodex kiro has no retry: a transient 429/503 fails the whole turn.

## Plan (to be finalized in this phase's P)
- Decide layer: adapter-level wrapper around the upstream fetch vs shared
  transport. Prefer the smallest correct layer that the kiro path already owns.
- Classify retryable: 429, 500, 502, 503, 504; honor Retry-After when present;
  exponential backoff with jitter; bounded attempts (e.g. 3).
- Do NOT retry non-idempotent partial streams once bytes have been yielded;
  retry only pre-first-byte failures to avoid duplicate output.

## Tests
- 429 then 200 -> succeeds after one retry.
- exhausted retries -> surfaces last error.
- post-first-byte error -> NOT retried (no duplicate stream).

## Commit
feat(kiro): retry transient 429/5xx with bounded backoff (gateway parity)
