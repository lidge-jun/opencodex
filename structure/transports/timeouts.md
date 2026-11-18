# Response-header and local JSON deadlines

`src/stall-timeout.ts` resolves an unset inference header budget to 200,000 ms for public
upstreams and zero for local ones. Explicit positive `connectTimeoutMs` applies to either;
non-positive disables the header timer. Responses adapter/passthrough, native Chat/Messages,
Claude passthrough and direct compact use this policy. `src/lib/abort.ts` keeps parent cancellation
linked after clearing or disabling the header timer; `src/server/claude-messages.ts` retains dev's
`fetchWithHeaderDeadline` success/error cleanup and timeout provenance. Local pacing admission
still pauses positive header clocks; `src/web-search/header-deadline.ts` distinguishes disabled
budgets from exhausted positive budgets. Default image/search sidecar deadlines stay unchanged.
Native Chat/Messages, non-forward Responses (including adapter retries/continuations), and keyed
compact start header clocks at the final send after pacing and credential/destination refresh.
Header and subsequent body policy follow the serving URL across local/public transitions.
Responses SSE and direct Chat/Messages encoder watchdogs read that live locality each beat and
reset silence ticks when it changes, including terminal continuations and signature repair.
`src/adapters/command-code.ts` honors non-positive budgets via the clearable deadline;
`src/adapters/kiro/adapter.ts` preserves the fetch budget through its internal text fallback.
`src/server/responses/fetch-helpers.ts` awaits admission only when the executor has a pacing seam,
so wrapping an unpaced physical send adds no yield between final credential validation and dispatch.

## Provider-scoped budgets

`providers.<name>.connectTimeoutMs` and `providers.<name>.stallTimeoutSec` (declared in
`src/types/provider.ts`) override the global values for one provider. `src/stall-timeout.ts`
`providerConnectTimeoutMs` / `providerStallTimeoutSec` return the provider value when it is set,
including `0` (disabled for that provider only), else the global value; the result still goes
through `resolveConnectTimeoutMs` / `resolveStallTimeoutMs`, so the local/public default applies
only when both are unset. The override is read on routed adapter sends (`adapter-dispatch.ts`,
`adapter-delivery.ts`, `adapter-continuation.ts`, `request-transport.ts`), `runTurn` delivery,
the image and web-search sidecars in `sidecar-execution.ts`, and `planWebSearch`, whose bridge
stall covers the provider's budgets. The shared OAuth dispatch also reads the provider header
budget for passthrough. Other Responses passthrough paths, native Chat/Messages and compact use
the global budgets. Buffered `runTurn` has no provider stall watchdog. The image/video bridge
uses its default timers for zero values, and the outer web-search watchdog retains a positive
budget. Load degrades malformed values to "inherit" (`leaf-validators.ts`).

Both fields are editor-owned in `src/server/auth-cors.ts`. The shared provider management
validator requires integers from 0 through 2147483647 ms or 2147483 seconds respectively.
`src/server/management/provider-overwrite-carry.ts` retains an omitted POST override from
the latest live same-name row. Its PATCH mask deletes either override on explicit `null` and
refuses invalid values before persistence. See [Durable provider PATCH](../gui-and-management-api.md#durable-provider-patch).
`tests/responses/provider-upstream-deadlines.test.ts` covers override, inherit and per-provider
disable for the header clock, the stall watchdog, the web-search plan and write validation.
`tests/server/management-provider-compat-carry.test.ts` covers POST carry and PATCH validation.

`src/lib/local-upstream.ts` classifies HTTP(S) destinations without DNS: exact case-insensitive
`localhost` (optional trailing dot), unspecified IPv4 `0.0.0.0`, IPv4 loopback/private/link-local,
IPv6 loopback/link-local/unique-local and IPv4-mapped equivalents, plus `.local`/`.lan` names.
Other names retain public deadlines even if DNS resolves them to loopback; malformed destinations
and unsupported schemes retain safety clocks. This is timeout policy, never network authorization.

Native Chat/Messages local JSON reads use `stallTimeoutSec` only as an inactivity budget, with no
five-second floor or stall-derived total deadline. Client cancellation and enclosing overall
deadlines remain authoritative. Public JSON reads retain their legacy total/inactivity budget,
`max(connectTimeoutMs ?? 200000, 5000)`. `src/lib/bounded-body.ts` arms no non-positive body timer;
byte caps and cancellation remain active. Compact body reads retain their separate 300-second
default even locally. Unset local header and stall clocks do not create an overall bound before
headers. `tests/responses/local-upstream-deadlines.test.ts` covers dispatch, compact and native JSON
policy, public header expiry, client/overall cancellation and explicit local body bounds.
`tests/responses/refreshed-upstream-deadlines.test.ts` covers queued Responses destination changes;
`tests/providers/kiro/kiro-fallback-error-body.test.ts` checks disabled and positive fallback budgets.

## Native Responses SSE stall

Native Responses SSE is the one stall consumer that reads only an explicit budget (#8206).
`explicitStallTimeoutMs` in `src/stall-timeout.ts` returns the positive operator value and `0`
when `stallTimeoutSec` is unset or non-positive, so the unset local/public defaults never reach this
relay. `src/server/responses/passthrough-delivery.ts` guards the upstream body with
`src/lib/response-body-inactivity.ts` before terminal repair, the web-search bridge and the relay (each web-search continuation leg too), measuring byte
silence rather than model progress,
keeping the Response object and its relay markers. The canonical JSON fold keeps its own silence and
whole-turn deadlines. Reset selection in `src/server/responses/passthrough-completion.ts` already
guards the bodies it publishes with the resolved budget and marks them
(`markResponseBodyInactivityGuarded`), so they get no second clock. Guards armed by the explicit budget (delivery, continuation legs, and reset
selection when the field is set) raise `ExplicitBodyStallError`, which `buildFailedTailPayload` in `src/server/relay.ts` and the
leg read catch in `src/web-search/passthrough-bridge.ts` report as `upstream_stall_timeout` (the bridge keeps
`web_search_bridge_failed` for every other leg read failure); a guard on a default budget keeps the earlier `upstream_reset` tail on the relay path, while a default-budget stall during a bridge leg read reaches that catch as an ordinary read failure and reports `web_search_bridge_failed`. Native steering and
injection chains (`isNativeControlResponse`) stay unguarded: between responses they wait for the client's continuation,
which a byte-silence clock cannot tell from upstream silence, and they keep their own timeliness checks. `tests/responses/responses-native-sse-stall.test.ts` covers explicit
local and public expiry and the unset and `0` cases.

## Offline wait and resend

`offlineResendWaitSec` (#7958) is off unless set to a positive number of seconds, capped at 300 by
`resolveOfflineResendWaitMs` in `src/lib/offline-resend.ts`. `createProviderOfflineResendWait` returns one
single-use waiter per request, probing the name the send resolves (`offlineResendProbeUrl`: the provider's
own `proxy`/`noProxy` route, else the global proxy unless `NO_PROXY` exempts the URL, else the provider URL, as
`configuredOutboundFetch` routes it), or none for an IP-literal probe target or a caller-supplied `fetch` executor; OpenCodex's own xAI and Mistral
wrappers carry `isEgressTransparentExecutor` and keep the wait. The initial sends in
`src/server/responses/passthrough-dispatch.ts` and `src/server/responses/adapter-dispatch.ts` hand it to
`fetchWithTransientRetry` / `fetchWithResetRetry` as `offlineWait`, except on a combo attempt, which fails over
to its next member instead of waiting once per target. `fetchWithTransientRetry` gives the waiter to the first
send only; later transient-5xx legs never wait. Only a DNS resolution failure (`isDnsResolutionFailure`:
`ENOTFOUND` or `EAI_AGAIN` through a bounded cause chain, never message text, and never retry-evidence errors)
qualifies, because DNS answering again is the evidence that failure lacked; refused or unreachable connections
would resend into the same failure, and with an outbound proxy a direct reachability probe would not test the
request's path. The waiter polls that name's DNS once a second until it resolves or the wait ends; each
probe races the remaining budget and client cancellation, and a success after the deadline does not count. The
first send's slow-attempt clock restarts when the wait resumes. Adapters with their own `fetchResponse` transport
(google Vertex and Cloud Code Assist, kiro, cursor, zed, command-code, mimo-free) are not wired; direct Google AI Studio is. One resend then
follows inside the request's existing `attempts` budget and send accounting; no budget, a second DNS failure, an
exhausted wait or any other failure returns the original error.
A client cancel during the wait or a probe makes the waiter answer `false` instead of rejecting with the abort
reason, so `fetchWithResetRetry` rethrows the original DNS error and a Codex pool send keeps the host-wide
`connect_neutral` class in `classifyTransportFailureKind`. The resend's send carries its own recovery kind,
`offline-resend` (cause `transport-unsent`, a localized Logs label), never `connection-reset`; like a reset
retry it opts out of keep-alive in `applyUpstreamRecoveryInit`, because sockets pooled before the outage
belong to the network that went away.
`tests/responses/responses-offline-resend.test.ts` drives the probe and clock through
`setOfflineResendDependenciesForTests`.

## OpenCode timeout export

`src/types/config.ts` declares `opencodeClientExport`; `src/config/schema/leaf-validators.ts`
accepts positive milliseconds or `false` and drops malformed fields or blocks.

`src/clients/config-export.ts` emits only configured `opencodeClientExport` fields into the
generated V1 provider `options` and V2 provider `settings`: `headerTimeoutMs` maps to
`headerTimeout`, `chunkTimeoutMs` to `chunkTimeout`, and `timeoutMs` to `timeout`. Positive
milliseconds or `false` pass through; unset fields retain the client's native defaults. These
are provider-wide settings, including public and local models multiplexed through that provider.
The builder remains pure; managed writes retain the existing ownership and snapshot rules.
