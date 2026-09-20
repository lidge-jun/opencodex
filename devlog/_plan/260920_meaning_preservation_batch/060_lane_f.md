# Lane F — per-provider egress, and the CodeBuddy/native-wire disposition

Status: OPEN. PR #5289 against `dev` at exact head `40fe2ee7d8`, hosted CI green across the
whole matrix. One branch, ordered commits, one pull request. Covers phase 2 bundles 13 and 15
from [010_phase2.md](010_phase2.md).

Lane F was scheduled after lane B because bundle 13 consumes the request-scoped route decision
that lane B built for #5087. That landed as #5264 (`8e1fdea1`), so this lane reads
`effectiveProxyFor` as the authority for the global decision and does not restate it.

## 13 — per-provider egress

### What the bundle actually was

Issue #2894 asks for two things and only one of them was missing. Global SOCKS5 already ships:
`socks5ProxyFromEnv`, `socks5Fetch` and the `configureSocks5Fetch` wrapper handle it, and
`applyProxyEnv` mirrors a configured value into `ALL_PROXY`. Rebuilding that was never in
scope. What was missing is the two-level model: a per-provider override with direct / inherit /
custom, so one upstream can exit through a regional proxy while another stays direct.

### The decision function

`src/lib/provider-egress.ts` resolves one route for one destination. It deliberately mirrors
#5087's shape: the question is never "is a proxy configured" but "does a proxy apply to THIS
request". Four states — inherit, direct, http(s) proxy, socks5 proxy — with
`providers.<name>.noProxy` applied to whichever route resolved, which is what lets a provider
exempt one destination from an inherited global proxy without owning a proxy of its own.

Two divergences from the issue's sketch, both deliberate:

- **An empty string is rejected, not read as DIRECT.** The issue lists `""` as a third spelling
  of direct. A dashboard field the operator merely cleared would then silently switch a provider
  from inheriting the global proxy to refusing it. The error names both real alternatives.
- **A malformed value throws rather than degrading.** Falling back to the global proxy sends a
  credential out a route nobody chose; falling back to direct leaves a restricted network with
  no exit. Both read as success at the call site, which is the defect class this batch exists
  to remove.

### How direct egress is expressed, and why that needed settling

This was the one genuine unknown. #3901 refused the direct state outright with the message
"direct has no safe request-scoped transport on this runtime". That is correct about the
mechanism it rejected and wrong as a general claim.

Bun's documented `proxy: false` connects directly regardless of `HTTP_PROXY`, `HTTPS_PROXY`,
`ALL_PROXY` **and** `NO_PROXY`. The same documentation states that `undefined`, `null` and
`""` all mean "no option given" and fall through to the environment, so none of them can
express direct egress — which is why the resolver emits the literal `false` and never an empty
string.

`configuredOutboundFetch` had to learn the same distinction. It derived its SOCKS route with
`typeof explicitProxy === "string" ? … : socks5ProxyFromEnv()`, so a `false` fell into the
environment branch and a request pinned to direct egress would have been sent through the global
SOCKS proxy. It would have returned 200 by the wrong exit, which no status-code assertion can
see. That is now a regression.

One path needs nothing from the runtime at all: on `providerOutboundRequest`, direct egress is
the DNS-pinned transport, which connects through `node:http` to an address this process
resolved and never reads the proxy environment. Discovery and quota therefore have direct
egress by construction rather than by flag.

### Reach, stated as coverage rather than implied

Honoured: the main inference dispatch (`providerFetch`), every
`providerOutboundGet`/`providerOutboundPost` caller (provider discovery, the model-catalog
gather, the management provider test, the Ollama show probe), and the seventeen API-key quota
probes in `vendor-probes-key.ts`.

Refused rather than dropped: a caller-supplied `provider.fetch` executor owns its own routing,
so an explicit route throws instead of running the executor by a contradicting route. The
WebSocket upstream picks its proxy from the process environment when it dials, so an explicit
route serves those turns over HTTP/SSE and says so once per provider.

**Not covered, and this is the honest limit of the change:** OAuth token exchange and refresh
under `src/oauth/`, the OAuth-backed quota probes in `vendor-probes-oauth.ts`, and the API-key
validation probes in `key-providers.ts`. All three reach fixed vendor endpoints from modules
that hold no provider config, and `validateApiKey` receives a derived `KeyLoginProvider` whose
caller builds the real provider record only afterwards. Threading provider config through those
call sites is a caller-contract change across roughly a dozen OAuth modules and is not attempted
here. The consequence is stated plainly in the provider guide and the transport inventory: a
provider pinned to its own proxy or to direct still refreshes credentials by the process-wide
route. #2894 therefore stays open for that half.

Also uncovered and recorded: Cursor's default HTTP/2 transport, the coding-agent subprocess
providers whose scoped child environment omits proxy variables, and the Compatibility Lab pinned
sender.

### Overlap with the #5049 router-bypass list

Lane E recorded authenticated data-plane endpoints that spend provider quota without resolving a
model through the router. Every one of them is also outside this lane's egress reach, for the
same structural reason — no routed provider at the send — and the overlap is complete:
`/v1/images/generations`, `/v1/images/edits`, `/v1/audio/transcriptions` and its streaming
form, `/v1/live`, `/v1/realtime/calls`, the standalone realtime sockets, and the
non-account-qualified branch of `/v1/alpha/search`.

### Credential handling

A proxy URL routinely embeds `user:password@`. `proxy` is classified credential-bearing
alongside `apiKey`, so it never reaches the dashboard DTO and the editor may not write it;
`ocx config set` and the config file remain the way to set it. Log output keeps scheme, host
and port only. Nothing derived from the credential is emitted — the carried
`providerEgressRouteKey` FNV-1a digest over the full proxy URL was dropped rather than carried,
because a 32-bit digest over a known host is a guessable stand-in for the secret and a durable
correlation key for the account behind it, and it had no consumer.

### A finding recorded rather than acted on

Bun's documentation states it uses `ALL_PROXY` for `http:` and `https:` alike when the
scheme-specific variable is unset. `effectiveProxyFor` counts a non-SOCKS `ALL_PROXY` only for
`http:` targets. The divergence fails toward keeping the DNS-pinned transport, which is the safe
direction, and lane B reasoned about and tested that boundary explicitly. Changing it is lane
B's surface, not this one, so it is recorded here rather than altered.

### Carried work

#3901 (jingzxy) — per-provider HTTP proxy overrides. Carried with a `Co-authored-by` trailer on
both code commits. The branch was 289 `dev` commits behind and its `provider-outbound.ts` hunks
were written against the pre-#5264 `outboundProxyConfigured` shape, so the work was carried onto
the landed decision rather than replayed. Its management cases would also have pushed
`tests/server/management-provider-validation.test.ts` from 5,498 to 5,612 lines against a 5,506
cap; those cases live in a registered sibling file instead. The original pull request stays open
for the coordinator.

## 15 — CodeBuddy tool bridge and native wire: disposition

Item 15 is delivered as a disposition, not an implementation. All three pull requests were
audited against current `dev` and none is carryable as it stands. Recording why is the
deliverable; carrying a defect with a `Co-authored-by` trailer on it would not be.

No issue is closed by this lane. #5146, #5097 and #5096 stay open.

### #5147 — account-roster discovery: blocked on an attribution defect

The roster is read by running the vendor CLI, which answers for the account **signed in to that
CLI's home directory**. The result is then cached under a fingerprint of the **configured API
key**. Those are two different identities. The fingerprint isolates cache reuse between
configured keys, which is what it was designed for, but it does not make the roster belong to
the key it is filed under: with key B configured and account A signed in to the CLI, the proxy
advertises A's models as B's catalog. That is the same class of defect bundle 8 is about — an
observation outliving the identity it was made under — so carrying it into this batch would
contradict the batch.

The rest of the pull request reviewed clean: the key is passed by environment rather than argv,
output is bounded at 512 KiB with an 8-second timeout, an explicit `liveModels: false` is
preserved, and a missing CLI warns and degrades to the static seed rather than crashing. The
defect is the binding, not the plumbing.

### #5148 — capture-only tool bridge: conflicts, and coverage short of the bar

The capture-only security boundary itself reviewed sound: the MCP server advertises and captures
but never resolves a call, no path traversal or execution route was found, and no secret reaches
the logs. The CLI does not execute tools and client approval is preserved.

It does not apply to current `dev` — `src/adapters/coding-agent/turn.ts` conflicts and seven
touched files drifted since its merge base. More important for this batch, its tests do not
reach the acceptance bar set for item 15. Directly uncovered: a **successful** multi-call
assistant message, call-ID preservation across the capture boundary, bridge-specific reasoning
replay on the continuation turn, and an integrated abort that proves process-tree cleanup rather
than orphaning a child. Those four are exactly the cases a "the first tool call worked" test
cannot see, which is why they were named as the completion condition.

Landing it would mean rebasing the adapter work and writing those four regressions. That is a
lane of its own, not a trailing commit on this one.

### #5188 — Alibaba Token Plan default flip: evidence does not support it

#5198 already landed the opt-in and declined the flip, and added a guard that fails if a
Responses wire default is declared for this entry without `preserveResponsesReasoningContent`
beside it. #5188 proposes exactly that declaration without that flag.

The guard is not bureaucratic. The entry sets `preserveReasoningContentModels`, which the
**Chat** adapter reads; the Responses serializer reads a different flag this entry does not set,
so pinned models would replay continuations with blanked reasoning content — strictly less state
than they carry today. Z.AI and DeepSeek set both flags together and their entry comments say
why.

The live evidence in #5097 covers a tool call and a continuation that replays
`custom_tool_call` and `custom_tool_call_output`. It does not assert that reasoning content
survived that continuation, which is the one thing the flip would change. The delegation's own
constraint applies: do not change inbound behaviour or international endpoints without evidence.
The opt-in stands; the flip waits for a replay that demonstrates reasoning preservation.

## Verification

Static source review plus exact-head hosted CI. No local suite, individual test, typecheck,
build, install, live `ocx` execution or service restart was run — those are **NOT RUN**, not
passing.

Hosted CI at `40fe2ee7d8` is green: all four test shards, both macOS halves, `gates`
(typecheck, GUI tests, privacy scan, generated skill surface), the structure gate, docker smoke,
storage policy, api usage, the three `npm-global` smokes and the three keyring jobs.

### What only CI could tell me, and what only review could

Three defects reached a pushed head and were caught by adversarial review before CI ran, all in
the same seam and all invisible to a status-code assertion:

1. The route was resolved when the fetch wrapper was built, but `dispatchOverride` can rebuild a
   queued request against a different upstream host. A host-scoped `noProxy` decision could
   therefore be applied to a host it was not decided for, sending a bearer out an excluded route.
   The decision moved to `sendWithConnectionPolicy` — the same boundary and the same reason
   #4992 records for the connection policy.
2. Refusing every `provider.fetch` as transport-owning was too broad. The xAI route installs a
   wrapper on every request that only adds a generated request id, so an explicit route would
   have thrown for one of the two providers #2894 names.
3. The executor handed to an override was itself unmarked, so an ordinary provider would have
   been refused on every overridden path — after the attempt had already been recorded. None of
   the regressions written to that point covered the production-shaped nested send; two do now.

CI then found two more that review had cleared. The zod field schemas used
`z.unknown().superRefine(...)` without narrowing, so the parsed provider record carried
`proxy: unknown` and failed to satisfy `OcxProviderConfig` — four typecheck errors, and a
typecheck-based adapter contract test that asserts zero errors reported one. And the privacy
scan reads a URL userinfo pair as an address, so the fixtures that deliberately carry a
credential to prove it never reaches a log were read as one. They moved to the `.test` host the
scanner already allows for fixtures, with the assertions unchanged. Both are the reason this
lane treats hosted CI as the verification and static review as the preparation for it, rather
than the reverse — and the second one repeated itself in this very document, which first
described the defect by quoting the shape that caused it.

Union-defect sweep before pushing:

- **File-size ratchet.** No touched source file carries a cap.
  `tests/server/management-provider-validation.test.ts` does (5,506) and is deliberately not
  touched; the management egress cases are a registered sibling file.
- **Exhaustive over a union.** Adding `proxy` and `noProxy` to `OcxProviderConfig` makes
  `PROVIDER_CONFIG_FIELD_POLICY` — declared `satisfies Record<keyof OcxProviderConfig, …>` —
  fail to compile until both are classified. Both are, and the classification is asserted rather
  than assumed.
- **Derived, not restated.** The tests import `PROVIDER_EGRESS_DIRECT`,
  `MIN_BOUNDED_CODEX_WS_BUN_VERSION` and `CODEX_RESPONSES_HTTP_URL` from source instead of
  repeating their values, and configuration validation calls the resolver instead of restating
  what a valid proxy value is. No count in generated documentation was touched.
- **Test layout.** Four new test files, each registered in both `scripts/test-layout/layout.json`
  and `tests/fixtures/test-layout-expected.json`.
- **Exact-list guards.** `tests/responses/responses-fetch-helpers-boundary.test.ts` pins the
  runtime-import list of `fetch-helpers.ts` and needed the two modules this lane adds. It is the
  restatement class in miniature, and it is the guard working as intended: the list is a
  deliberate classification, so adding to it is a reviewed decision rather than a silent one.

## Ownership

Consumed and not redefined: lane C's send accounting, lane E's adapter event queue budget and
per-key model/provider scope (`src/server/admission-model-scope.ts`), and lane D's per-model
cache views. The `effectiveProxyFor` global decision belongs to lane B and is read, not changed.
