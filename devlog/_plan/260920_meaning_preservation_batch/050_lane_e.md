# Lane E — output budgets, queue memory, per-key policy

Status: OPEN. Branch `codex/260920-lane-e-budgets-key-policy` against `dev`, one pull request.
Covers phase 2 bundles 10, 11 and 12 from [010_phase2.md](010_phase2.md).

## What each bundle turned out to be

### 10 — Devin output budget and the history ceiling

Two defects, not one. The adapter forwarded only a caller-supplied
`max_output_tokens`, and Codex never sends one, so every `devin/*` turn was capped at
the cloud-direct encoder's 8192 fallback however the provider was configured. The
escape hatch was closed too: no OAuth preset declares `defaultMaxOutputTokens` or
`modelMaxOutputTokens`, so the delete-when-preset-undefined branch in
`applyOAuthPresetCatalog` was the only branch either field ever took and a
hand-edited value was gone before the next startup finished. Both had to move, or
wiring the adapter alone would have been unreachable in practice.

The resolver reads the caller's explicit value, then the configured per-model cap,
then the provider default, then nothing — leaving the encoder fallback. It never
reads `contextWindow` or `modelContextWindows`: CompletionConfiguration #2 is the
output cap and #3 is the context window, and collapsing them would ask Cognition to
generate a whole window of output.

The history ceiling is the other half and stays a separate quantity. #5189 is
carried with attribution: it derives the coding-agent projected-history bound from
the declared context window in characters. That bounds replayed history memory;
nothing there decides how long a reply may run.

No retry change was needed. Source review of `stated-reset-retry.ts` and
`upstream-retry.ts` confirms an upstream `incomplete / max_output_tokens` is a
successful streaming response that has already emitted events, so it matches none
of the replay conditions. The repeated identical attempts in #5190 are the client's.

### 11 — adapter event queue memory

PR #5182 had the right idea and the wrong number. Its 1 MiB aggregate default
aborts a legitimate turn: a synchronous producer fills the queue before its
consumer is scheduled, and the image loop does exactly that with over a million
one-character deltas that coalesce into roughly 1.2 MB of retained text. Its own CI
proved it, which is why it sits at `CHANGES_REQUESTED`.

The work is carried with attribution and reshaped around two budgets rather than
one, because a stalled consumer and a malformed event are different failures and an
operator reading the terminal error should learn which happened. Accounting is now
exact by construction: each queued item records what it was charged, so a merge
pays only for appended text, a refused event is priced before anything is retained
and never charged, and the terminal record explaining a refusal is admitted past
the budget it reports but still charged and released. `retainedCodeUnits()` exposes
the counter so the regressions assert it reaches zero rather than inferring it from
an abort that happened to fire.

Retention is measured by a bounded walk of own enumerable properties rather than a
per-variant table. A table would be exhaustive over `AdapterEvent`, which is the
union class `AGENTS.md` records: a member added on another branch would silently
stop being counted.

### 12 — per-admission-key model and provider scope

The security question is where the check goes, not what it compares. A scope
evaluated against the client's string authorizes one destination and reaches
another, because alias resolution, policy and combo selection, subagent fallback
and compaction override all rewrite that string. So the scope names destinations
and is applied to the resolved route.

On the Responses path every route produced by the request — direct name, alias,
policy, combo child, shadow-intercept target and both subagent-fallback re-routes —
passes through one capture point, which is where the check sits. Chat and Messages
translate into that path; their native lanes and the compaction route send without
re-entering it, so each applies the same predicate itself. `/v1/models` filters by
the same predicate, and that filter is explicitly not the boundary.

A malformed scope drops the key rather than degrading to `undefined` like every
other field on the record, because degrading a permission field reads as "allowed
everything".

Out of scope and deliberately not started: Redis, a full multi-tenant conversion,
and any budget or RPM/TPM system.

#### What the scope does not cover, stated rather than implied

An adversarial review of the branch found authenticated data-plane endpoints that
spend provider quota without resolving a model through the router, so the scope
does not reach them:

- `/v1/images/generations` and `/v1/images/edits`,
- `/v1/audio/transcriptions` and its streaming form,
- `/v1/live`, `/v1/realtime/calls` and the standalone realtime sockets,
- the non-account-qualified branch of `/v1/alpha/search`, which forwards the caller's
  model to a search sidecar without routing it.

The account-qualified search branch does route a model and is checked. The rest
need a destination definition this lane does not own — an image or audio endpoint
has a fixed-purpose model rather than a routed one — and inventing one here would
be the multi-tenant expansion this batch rules out. They are recorded so the
contract is not read as broader than it is.

The review also found that resolving an OpenAI virtual model rewrites
`route.modelId` to the wire id after the initial check. That one was a real hole in
the stated contract and is fixed: the settled route is re-checked after
normalization, so the id that is billed is the id that was authorized.

## Verification

Static source review plus exact-head hosted CI. No local suite, individual test,
typecheck, build, install or live `ocx` execution was run — those are NOT RUN, not
passing.

Union-defect classes checked before pushing. No file in the touched set carries a
`file-size-baseline.json` cap; the largest, `src/oauth/index.ts` and
`src/server/index/serve-options.ts`, stay under the 2000-line new-file threshold.
The two new test files are registered in both `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json`. Nothing here restates a count or
enumerates a union.

## Ownership

Lane E owns the adapter event queue budget and the Devin and coding-agent limits.
Retry classification — `sendCount`, the send budget, the stage and cause vocabulary —
is lane C's and is untouched.

## Carried work

- #5182 (luvs01) — adapter event queue backlog budget.
- #5189 (mdwsk88) — coding-agent projected-history ceiling.

Both carry a `Co-authored-by` trailer in the branch commit. Neither original pull
request is closed here; the coordinator handles that after this lane lands.
