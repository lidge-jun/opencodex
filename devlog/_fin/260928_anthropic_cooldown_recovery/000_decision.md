# Anthropic cooldown recovery ownership

## Decision log

- Purpose: let an authoritative Anthropic usage refresh release a stale reset-derived
  cooldown without weakening explicit upstream backoff or clearing another account's state.
- Existing constraints: routing health is process-local, usage probes are asynchronous, and
  credentials or a newer 429 can replace the state observed when a probe starts.
- Alternatives considered: clear every cooldown after any successful usage response; clear
  only through the operator endpoint; or bind recovery to the observed refusal and credential.
- Decision: a probe captures the exact account credential generation and cooldown generation
  before dispatch. Settlement requires the same live credential, the same reset-derived
  cooldown, a fresh timestamp, and utilization below 100% for every window that the 429 marked
  rejected. Account-level single-flight keys also include an active recovery generation, so a
  forced post-429 refresh cannot join work dispatched before the refusal. Any later cooldown
  mutation revokes publication ownership as well as settlement ownership. Partial, failed,
  exhausted, stale, Retry-After, and default-backoff evidence does not recover anything.
- Why this option: a successful quota HTTP response alone says neither which credential it
  measured nor whether a newer refusal arrived while it was in flight. Generation fences make
  those ownership claims explicit while preserving the existing manual escape hatch.
- Impact and trade-off: recovered accounts re-enter routing immediately; uncertain evidence
  remains fail-closed until expiry or `clear-cooldown`. The extra bookkeeping is process-local
  and bounded to one generation plus one health record per account. Superseded probes return an
  unavailable result instead of publishing quota that no longer describes the routing state.

## Data flow

1. A 429 records its source, rejected quota windows, and a monotonic cooldown generation.
2. A fresh usage probe captures that generation plus the stored credential generation.
   When recovery is pending, both the provider-usage flight and the outer account-quota flight
   are generation-scoped, so the probe dispatches after the claim instead of joining older work
   that might describe pre-refusal state.
3. The usage response is parsed and checked for complete headroom evidence.
4. Publication and settlement both require the observed cooldown generation to remain current.
   Settlement deletes only the still-matching reset-derived record.

The CLI dispatches `openai` to `/api/codex-auth/accounts/clear-cooldown` and `anthropic` to
`/api/oauth/accounts/clear-cooldown`. Anthropic IDs and aliases are resolved through the OAuth
account list before the write; other providers remain rejected because they do not expose this
process-local cooldown owner.

## Focused verification

- `tests/providers/anthropic-cooldown-recovery.test.ts`
- `tests/cli/cli-account-pool-verbs.test.ts`
- `tests/adapters/anthropic/anthropic-ratelimit-headers.test.ts`
