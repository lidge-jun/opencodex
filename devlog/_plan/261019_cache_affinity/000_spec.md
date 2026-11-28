# Spec — Provider cache affinity for multi-credential routes

Status: historical design draft. The current implementation contract is in
[`structure/transports/inventory.md`](../../../structure/transports/inventory.md#transport-inventory).
The proposal and contribution notes below are retained for design history and
are not the current implementation contract.

## Problem Statement

I use OpenCodex as my local proxy in front of several subscriptions and API
plans at once — an Anthropic subscription, Kimi Code, Ollama Cloud, and
others — with the Codex app as my main client and other apps on top. Several
of these providers have more than one credential available (an API key pool,
or a primary plus a spare key).

Today, when a conversation makes its second, third, and twentieth request,
OpenCodex is free to send each one through a different credential of the same
provider than the one that answered before. Every time it does, the
provider-side prompt cache that the previous turn paid to create is
abandoned: the new credential has never seen this conversation, so the whole
history is sent and billed as fresh input again. The longer the conversation,
the more this costs, and it costs it on exactly the long agentic sessions
where caching matters most.

The wire-level pieces are already in place: several providers forward a
stable prompt-cache key, and the Anthropic adapter places cache breakpoints.
What is missing is the routing-level half — remembering which credential
served a conversation, and preferring that same credential for the
conversation's next turn while it is still able to serve. The only affinity
OpenCodex has today is the Codex account pool's thread affinity, which covers
ChatGPT accounts only. A conversation routed to Anthropic, Kimi, or any other
multi-credential provider gets no such protection, and ordinary key rotation
after a rate limit can silently throw away a warmed cache even when another
key was never needed.

## Solution

Add **provider cache affinity**: a bounded, per-conversation memory that
records which credential of a provider served a conversation's last
successful turn, together with how much prompt cache that turn read and
wrote. On the conversation's next request, credential selection prefers the
recorded credential — as a preference inside normal eligibility, never as an
override. Quota cooldowns, health holds, per-model barring, request pacing,
and routing policy all still win; affinity only breaks ties among
credentials that could serve anyway.

Affinity is driven by measured cache evidence, not by assumption. A
conversation stays with its credential across turns only while the cache it
built there is worth keeping and has not gone cold (five minutes, or an hour
where the provider reports long-retention cache writes). Providers that
never report cache usage are treated as silently caching: the prompt that
was sent counts as written. A failed turn releases or rests the binding
according to the same failure classification the key-failover logic already
computes, so a conversation is never pinned to a credential that can no
longer serve it.

The feature is per-provider configurable (`auto`, `session`, `turn`, `off`),
defaults to `auto`, and is a no-op for single-credential providers.

## User Stories

1. As a user with two Anthropic API keys, I want a long conversation to keep
   using the key that answered its first turn, so that the prompt cache the
   first turn paid to create is read back instead of rebuilt on the other
   key.
2. As a Kimi Code user, I want my conversation to stay on the credential
   that holds its cache-affinity session key, so that the provider's
   documented cache affinity actually accumulates hits across turns.
3. As an Ollama Cloud user, I want affinity to work even though the provider
   reports no cache tokens, so that a vendor that caches silently still
   keeps my conversation where its prompt was last sent.
4. As a user whose primary key hits a rate limit mid-conversation, I want
   the request to fail over to the spare key as it does today, so that
   availability is never sacrificed to keep a cache.
5. As that same user, I want the conversation to bind to the spare key once
   the spare succeeds, so that subsequent turns rebuild cache once on the
   new credential instead of flapping between keys on every request.
6. As a user whose bound credential exhausts its quota, I want affinity to
   release the conversation rather than retry the exhausted credential, so
   that I never see avoidable quota errors for the sake of a cache.
7. As a user starting a brand-new conversation, I want routing to choose its
   first credential exactly as it does today, so that affinity never
   distorts initial placement, load balancing, or pacing.
8. As a user running several conversations at once, I want each conversation
   bound independently, so that one conversation's affinity never drags
   another conversation onto a busy or exhausted credential.
9. As a user who switches models mid-conversation, I want the binding to be
   re-evaluated for the new model, so that I am never pinned to a credential
   that does not serve the model I just picked.
10. As a user in a long tool-calling turn, I want every tool-result
    continuation in that turn to stay on the same credential, so that
    within-turn cache reads are never lost between steps of one turn.
11. As a user who returns to a conversation after ten minutes, I want
    routing to be free to place it on the best credential again, so that a
    cold cache exerts no pull.
12. As a user of Anthropic's one-hour cache retention, I want a conversation
    that wrote a one-hour cache to stay bound for that hour, so that the
    longer retention I am paying for is actually exploited.
13. As a user with request pacing in round-robin mode, I want affinity to
    pin my conversation without breaking per-key rate limits, so that cache
    locality and pacing guarantees coexist.
14. As an operator, I want to turn affinity off for a provider with one
    setting, so that I can restore today's exact rotation behavior if I ever
    suspect affinity of causing a problem.
15. As an operator, I want a `session` mode that keeps a conversation on its
    credential for the whole session regardless of cache measurements, so
    that I can choose predictability over the automatic heuristic.
16. As an operator, I want a `turn` mode that only holds a conversation
    within a single turn, so that cross-turn placement stays fully dynamic
    while tool loops keep their cache.
17. As a single-key user, I want affinity to change nothing at all, so that
    the feature carries zero risk for the simplest setups.
18. As a combo user, I want affinity to pin the credential inside whichever
    combo target served, without changing which target the combo picks, so
    that combo failover semantics are untouched.
19. As a Codex subscription user, I want the existing Codex thread affinity
    to keep owning my conversations exactly as today, so that this feature
    never interferes with the account pool's generation and probe logic.
20. As a user who removes a key from a provider's pool, I want bindings to
    that key forgotten, so that no conversation is ever offered a credential
    that no longer exists.
21. As a user who disables a provider mid-conversation, I want its bindings
    ignored immediately, so that the next request routes elsewhere instead
    of failing against a stale binding.
22. As a privacy-conscious user, I want the affinity store and my request
    logs to contain no raw API keys, session ids, or account identifiers,
    so that keeping this state creates no new credential-leak surface.
23. As a user inspecting my request history, I want each request to show
    whether affinity kept, released, or newly bound its credential — and
    why — so that an unexpected credential choice is explainable from the
    log alone.
24. As a user whose bound credential is in a short cooldown, I want the
    conversation served by another credential and not re-offered the cooled
    one until it recovers, so that affinity and cooldowns compose instead
    of fighting.
25. As a heavy user with hundreds of conversations, I want the affinity
    store strictly bounded in count and bytes, so that the feature can
    never become an unbounded memory or disk cost.
26. As a user restarting the proxy, I want to be told (in documentation)
    that bindings are forgotten on restart, so that a first post-restart
    request re-placing a conversation is expected behavior, not a bug.
27. As a maintainer, I want affinity decisions covered by tests at the HTTP
    seam with fake upstreams, so that the behavior is proven the way users
    experience it rather than by inspecting internal state.
28. As a maintainer, I want affinity to reuse the existing session-lane
    identity, credential-selection seam, and attempt ledger, so that the
    feature adds one new store and one preference hook instead of new
    plumbing through every handler.

## Implementation Decisions

- **One new module owns affinity.** A provider cache-affinity store holds,
  per conversation, the serving provider, model, and credential identity,
  the last turn's cache-read and cache-write token counts, the input size
  when no cache telemetry was reported, a timestamp, and a retention class
  (short or long). It exposes exactly three operations: *consult* (given a
  conversation and candidate provider, return the bound credential if it is
  still worth preferring), *record* (a turn completed on a credential, with
  its normalized cache telemetry), and *release* (forget or rest a binding,
  with a reason). No other module reaches into its internals.

- **Conversation identity is the existing session lane.** Bindings are keyed
  by the session-lane identity the request pipeline already derives for
  turn admission and combo recall. Only requests carrying a real,
  client-supplied lane identity may create or consult bindings; a
  per-request allocated lane is one-shot by definition and never binds.
  Lane values are used as internal map keys only and are never written to
  logs or disk in raw form.

- **Credential identity is a selection identity, never key material.** The
  store records the same stable per-credential selection identifier the
  key-failover machinery already uses to say which pool entry was attempted.
  Raw API keys, OAuth account ids, and authorization headers are never
  stored, logged, or hashed into the affinity store by this feature.

- **The consult seam is the shared credential-selection step.** Every
  inference path (Responses, Chat Completions, Messages, and Compact)
  already funnels through one proactive credential-selection operation
  before dispatch. Affinity is consulted there, and only there: if it
  returns a credential, that credential is treated as the selection's first
  preference; if it returns nothing, selection proceeds byte-for-byte as
  today. No request handler gains affinity logic of its own. This is the
  feature's single seam.

- **Eligibility always outranks affinity.** A bound credential is preferred
  only if it passes every check normal selection applies: provider enabled,
  credential present in the current configuration, model not barred for
  that credential, no active quota/billing cooldown, no health hold, and
  request-pacing admission. Any failed check releases (or rests) the
  binding with a recorded reason and selection falls through to the normal
  algorithm in the same request. Affinity can never cause a request to be
  sent somewhere normal routing would refuse.

- **Silent-cache detection uses telemetry provenance.** The finalization
  seam already classifies each request's cache telemetry as observed,
  synthesized, or unknown. Only "unknown" (the adapter reported no cache
  detail at all) triggers the silent-cache rule; an adapter that reports
  honest zeros is believed.

- **Recording happens at attempt finalization.** The request-attempt ledger
  already finishes each attempt with the serving credential and normalized
  cache usage (cache-read tokens, cache-creation tokens) regardless of
  which adapter produced it. The affinity store records from that seam, so
  streamed, non-streamed, native, and translated paths all report through
  one place. Only successful terminal attempts bind or refresh a
  conversation; pre-commit failures never do.

- **Worthiness is measured, with a silent-cache rule.** In `auto` mode a
  binding is kept across turns when the last turn read or wrote at least
  1,024 cached tokens. When an adapter reports no cache telemetry at all,
  the turn's input size counts as written once it reaches 1,024 tokens, so
  silently caching providers still accumulate affinity. Below the threshold
  the binding is kept only for within-turn continuations.

- **Within-turn means a detected continuation, never an age guess.** A request
  is a continuation when it returns tool results for the lane's in-progress
  turn (a tool-result final message on the Responses, Chat, or Messages
  wire). Timestamps decide only warm/cold, never turn boundaries. `turn`
  mode and `auto`'s continuation path both require this signal.

- **Cold windows follow reported retention.** A binding's cache is
  considered warm for five minutes after the turn that built it, matching
  the shortest upstream retention; where the turn's cache write carried
  long (one-hour) retention — as the Anthropic path reports under
  long-retention configuration — the warm window is one hour. Past the warm
  window the binding exerts no pull in `auto` mode, though it may be
  refreshed by a later turn that lands on the same credential anyway.

- **Failure handling reuses existing classification.** Affinity introduces
  no new error taxonomy. When the failover machinery classifies a failure
  as quota, credit, or authentication failure for a credential, a binding
  to that credential is released and the credential is not re-preferred
  until the cooldown the failover machinery already computes has passed.
  Rate-limit rotation proceeds exactly as today; when a rotated credential
  ultimately serves the turn, the binding moves to it (recorded at
  finalization like any success).

- **Modes are per-provider configuration.** Providers gain an optional
  cache-affinity setting with values `auto` (default), `session`, `turn`,
  and `off`, validated at the configuration boundary like other provider
  enums, with invalid values rejected rather than silently coerced.
  `session` prefers the bound credential whenever it is eligible, ignoring
  worthiness and cold windows. `turn` prefers it only for within-turn
  continuations. `off` disables both consulting and recording for that
  provider. Providers with fewer than two credentials are unaffected in
  every mode.

- **Interaction with request pacing is explicit.** When pacing selects
  round-robin or distributed keys, an eligible affinity preference is
  honored before the rotation cursor advances, and serving from a binding
  does not consume a rotation step. Per-credential pacing limits still
  apply in full: if the bound credential is pacing-limited, normal
  selection (including its overload refusal) decides the request.

- **Interaction with combos is deliberately narrow.** Combo target
  selection — including existing per-lane combo recall — is unchanged.
  Affinity operates only inside the chosen target, pinning that target's
  credential. Affinity never changes which combo target a request is
  offered, in either direction.

- **The Codex account pool is excluded.** Requests served by the canonical
  OpenAI/Codex forward path keep using the existing Codex thread affinity,
  with its credential generations, probe leases, and lineage rules. The
  generic store never sees them. This keeps two affinity systems from
  owning the same conversation; the generic one owns multi-credential
  key-auth provider routes only.

- **The store is process-local and registered for sweeping.** Following the
  precedent of the combo session-recall store, bindings live in memory,
  bounded to at most 512 conversations with per-entry and total byte caps,
  least-recently-written eviction, a 24-hour hard expiry (the store's bound
  on `session` mode), and expiry evaluated on read. The store
  registers with the state-store sweeper so expired entries are reaped
  periodically and a configuration generation change (provider removed,
  credential removed, provider disabled) reconciles bindings away instead
  of leaving them to fail eligibility one by one.

- **Observability uses the existing decision-reporting pattern.** Each
  request's log records the affinity outcome — newly bound, kept, released,
  or not applicable — with a bounded reason vocabulary (kept for cache,
  kept for session, kept within turn, cold, below threshold, credential
  ineligible, credential resting, no lane, disabled), mirroring how Codex
  affinity decisions are already reported. Reasons never include credential
  or conversation identifiers.

- **No wire behavior changes.** Prompt-cache keys, cache breakpoints,
  retention settings, and adapter request shaping are untouched. Affinity
  changes only which eligible credential a request is sent with.

## Testing Decisions

- **Good tests assert external behavior**: which credential a fake upstream
  actually received across a scripted multi-turn conversation, the status
  and body the client received, and the affinity outcome recorded on the
  request log. Tests must not assert the affinity store's internal map
  contents except in the store's own unit tests, and there only through its
  three public operations.

- **Primary seam: end-to-end through the real server** with a two-key
  provider whose fake upstream reports cache usage. The suite proves, in
  order: first turn binds; second turn arrives on the same credential
  (affinity kept); a forced 429 rotates and the third turn rebinds to the
  spare; after the first credential's cooldown the binding does not flap
  back mid-conversation; a cold conversation (clock advanced past the warm
  window) is placed by normal selection again. Prior art: the existing
  server-level key-failover end-to-end tests and the Codex session-affinity
  tests, which already script multi-account fake upstreams this way.

- **Store unit tests** cover the decision logic in isolation: worthiness
  threshold, silent-cache counting, short and long cold windows, `session`
  and `turn` mode semantics, capacity and byte-cap eviction,
  expiry-on-read, and generation reconciliation dropping bindings for
  removed providers and credentials. Prior art: the combo session-recall
  tests, whose bounded-store contract this mirrors.

- **Credential-selection tests** prove the preference composes with
  existing selection rules: barred model on the bound credential,
  pacing-limited bound credential, disabled provider, and `off` mode all
  fall through to today's selection result unchanged. Prior art: the
  existing key-failover unit tests.

- **Ledger tests** prove recording discipline: a pre-commit failure does
  not bind, a successful streamed turn binds with its reported cache
  telemetry, and a quota failure releases an existing binding. Prior art:
  the request-log attempt tests.

- **Regression gates**: the existing key-failover, combo-recall,
  session-affinity (Codex pool), and chat conversation-affinity suites must
  pass unmodified, demonstrating the Codex pool and combo behavior are
  untouched. New test files are registered in the test-layout map as the
  repository's layout guard requires. Typecheck passes. Because the change
  adds a provider configuration option, the provider documentation and the
  structure document owning routing/provider behavior are updated in the
  same change, per repository rules.

## Out of Scope

- Any change to the Codex account pool: its thread affinity, account
  selection, probe leases, lineage, or quota logic.
- Persistence of bindings across process restarts (a documented follow-up;
  v1 follows the process-local precedent of combo recall and Codex
  lineage, and restart behavior is called out in user-facing docs).
- Multi-account generic OAuth providers (for example multiple Anthropic
  OAuth logins outside the existing Anthropic pool machinery); v1 covers
  key-pool credentials. Extending the store to OAuth account identities is
  a follow-up once the key-pool behavior is proven.
- Changing combo target selection, routing profiles, or policy evaluation.
- Any change to prompt-cache wire behavior: cache keys, breakpoints,
  retention, or adapter request/response shaping.
- Response caching or result reuse of any kind; this feature only
  influences which credential serves a live request.
- GUI or dashboard surfacing of the setting or of affinity decisions;
  configuration is file/API-level and decisions appear in request logs.
  GUI support is a follow-up.
- Cross-provider affinity (moving a conversation between providers to chase
  a cache); bindings only ever prefer a credential of the provider routing
  already chose.

## Further Notes

- **Viability against the current tree** (checked at `6936d9885`, v2.88.0):
  every seam this spec needs already exists. The session-lane identity is
  already derived per request and already keys combo recall and turn
  admission; the proactive credential-selection operation is already the
  single funnel for the Responses, Chat, Messages, and Compact paths;
  attempt finalization already normalizes cache-read and cache-creation
  tokens from every adapter into one usage shape; and the state-store
  sweeper already accepts bounded stores with expiry and
  generation-reconciliation hooks, with the combo session-recall store as a
  working template for the bounds and eviction contract. No new identity,
  ledger, or lifecycle plumbing is required — the change is one store, one
  preference consult, one recording hook, and one configuration field.

- **Design provenance**: the worthiness threshold, cold windows,
  silent-cache rule, and mode vocabulary are modeled on Magpie's gateway
  affinity design, re-expressed in this repository's terms (session lane,
  credential selection, attempt ledger, state-store sweeper). This spec
  deliberately diverges from that design in one place — process-local
  storage instead of an on-disk file — to match this repository's existing
  precedent and keep the change reviewable; persistence is the named
  follow-up if maintainers want restart durability.

- **Contribution hygiene**: this repository's tracker has no
  `ready-for-agent` label, and its issue gates close non-templated
  submissions, so this spec lives as a local planning record rather than a
  freeform upstream issue. Before implementation, open the upstream feature
  issue using the repository's feature-proposal template, link this spec,
  and target the PR at `dev`. Expect the security-review label set to apply
  if the implementation touches credential handling beyond selection
  identity; the design above is specifically shaped to avoid that (no key
  material is stored or logged).

- **Expected benefit, stated honestly**: the win scales with credential
  multiplicity and conversation length. Single-credential users see no
  behavior change. Multi-key users on long sessions should see cache-read
  tokens rise and effective input cost fall on second and later turns; the
  end-to-end tests assert credential stickiness directly, and a before/after
  cache-read comparison on a real multi-key setup is the right acceptance
  evidence to attach to the PR.
