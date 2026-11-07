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

## OpenCode timeout export

`src/types/config.ts` declares `opencodeClientExport`; `src/config/schema/leaf-validators.ts`
accepts positive milliseconds or `false` and drops malformed fields or blocks.

`src/clients/config-export.ts` emits only configured `opencodeClientExport` fields into the
generated V1 provider `options` and V2 provider `settings`: `headerTimeoutMs` maps to
`headerTimeout`, `chunkTimeoutMs` to `chunkTimeout`, and `timeoutMs` to `timeout`. Positive
milliseconds or `false` pass through; unset fields retain the client's native defaults. These
are provider-wide settings, including public and local models multiplexed through that provider.
The builder remains pure; managed writes retain the existing ownership and snapshot rules.
