# Measured: the Muse Code credential, and Meta's quota surface

Research doc (000-range). No diffs here: the credential half is implemented by `040`
(wp4), the quota half by `050` (wp5).

Everything below was measured on 2026-09-03 **after the repository owner completed the
Muse Code login and payment setup on his own account** and asked for this to ship. No
secret value is recorded here and none reaches any diff.

## Supersedes, not retracts

`002` concluded no reusable credential existed and `020` closed wp2 as `NOOP`. Both were
correct on their evidence, and the reasoning in `020` — that proving a credential works
is not the same as being allowed to use it — is **not** withdrawn.

What changed is the decider. An agent must not spend a user's ToS risk on its own
initiative; a user may spend his own deliberately. `020`'s reopen conditions named only
first-party vendor changes because they were written for the first case. This is the
second. The repository already models it: `gui/src/oauth-tos-risk.ts` carries
`anthropic` and `google-antigravity` in `HIGH_RISK` for exactly this reason.

## A. Where the credential actually lives

`~/.config/muse/auth.json` (0600) contains **no secret**. It is a pointer:

```json
{ "schema_version": 2,
  "providers": { "meta": {
    "mechanism": "oauth", "storage": "keychain", "obtained_via": "device_code",
    "api_base_url": "https://api.meta.ai/v1",
    "user_full_name": "…", "user_email": "…" } } }
```

The secret is a macOS Keychain generic-password item, service
`ai.meta.dev.credentials`, account `meta`, whose payload is:

```
{ secret_schema_version: int,
  api_key:      str(len=48, "LLM|"-prefixed),
  access_token: str(len=282, opaque) }
```

**Key grammar, measured** (structure only, no value): the `api_key` is 48 characters in
three `|`-separated segments — `LLM` (3 alnum), a 16-digit id, and a 27-character
`[A-Za-z0-9_-]` tail. It matches `/LLM\|\d+\|[A-Za-z0-9_-]{10,}/` exactly. That is the
grammar the `privacy:scan` detector uses, so the rule is evidence-backed rather than a
guess at the vendor's format.

**The third-party report was wrong about the exposure.** It claimed the key sits "in the
Keychain in plaintext so anyone can pull it". It is a normal Keychain item under the
user's own ACL — the same protection class Claude Code uses, which
`src/oauth/local-token-detect.ts` already reads. Not a plaintext file on disk.

## B. Which half authenticates — the finding that shapes the provider

| Credential | `GET https://api.meta.ai/v1/models` |
|---|---|
| `access_token` | **401** `invalid_api_key` |
| `api_key` | **200**, 7 models |

The OAuth access token does **not** authenticate the Model API. The device flow's usable
output is the `api_key` stored beside it — the "automatically connected" Muse Code API
key the subscription docs describe (`001` §E).

So there is no bearer refresh loop to implement. The artifact is a long-lived API key,
which is the shape `src/oauth/command-code.ts` already returns
(`expires: Number.MAX_SAFE_INTEGER`, `access === refresh`).

## C. The live roster confirms the discovery risk was real

```
muse-spark-1.3-contributor, muse-voice-transcribe-1.0, muse-spark-1.3,
muse-image-1.0, muse-spark-1.2-contributor, muse-spark-1.2, muse-spark-1.1
```

The #3321 A-gate reviewer flagged unfiltered discovery when we had no payload. We have
one now, and `muse-image-1.0` and `muse-voice-transcribe-1.0` are exactly the
non-Responses-agent rows he predicted. `liveModels` stays off.

## D. The shipped effort ladder is confirmed against the live endpoint

`POST /v1/responses`, `muse-spark-1.3`:

| effort | result |
|---|---|
| `minimal` | 200 |
| `xhigh` | 200 |
| `max` | 400 — `unknown variant \`max\`, expected one of none, minimal, low, medium, high, xhigh` |
| `none` | 400 — `does not support "none" with this model` |

`META_MUSE_REASONING_EFFORTS`, wired in #3321 from published spec alone, matches the live
API exactly.

## E. Quota: the surface is in the stream, not at a URL

**This section was wrong in its first draft and is corrected here.** The correction
matters more than the finding: I probed only non-streaming requests, concluded "no
machine-readable quota exists", and was disproved by a report that the Muse CLI's
`/quota` command renders instantly — which is only possible if the data already arrived
with the previous turn.

### The finding: `response.subscription_usage`

A **streaming** `POST /v1/responses` (`"stream": true`) emits one extra SSE event
alongside the ordinary `response.*` sequence. Measured on 2026-09-03:

```json
{ "type": "response.subscription_usage",
  "subscription": {
    "tier": "27681393394859588",
    "window": { "used_percent": 0, "resets_at": 1788431188, "window_duration_mins": 300 },
    "weekly": { "used_percent": 0, "resets_at": 1788739200 } } }
```

Full event list from that one turn: `response.created`, `response.in_progress`,
`response.output_item.added` ×2, `response.content_part.added`,
`response.output_text.delta`, `response.content_part.done`,
`response.output_item.done` ×2, **`response.subscription_usage`**, `response.completed`.

This fits `ProviderQuota` in `src/providers/quota-types.ts` without a schema extension:
`window.used_percent` → `fiveHourPercent` (`window_duration_mins: 300` confirms the
5-hour window), `window.resets_at` → `fiveHourResetAt`, `weekly.used_percent` →
`weeklyPercent`, `weekly.resets_at` → `weeklyResetAt`. No new quota shape is needed.

`tier` is an opaque numeric id here, not the human label the CLI prints, so it must not
be displayed raw.

### What is still absent

The rest of the original negative survives, and it constrains **how** the quota is
obtained rather than whether it exists.

**Probed 17 plausible REST paths** with the working key —
`/v1/usage`, `/v1/billing`, `/v1/billing/credits`, `/v1/credits`, `/v1/account`,
`/v1/organization`, `/v1/organization/costs`, `/v1/me`, `/v1/whoami`, `/v1/limits`,
`/v1/rate_limits`, `/v1/quota`, `/v1/usage/costs`, `/v1/dashboard/billing/usage`,
`/v1/subscription`, `/v1/keys`, `/v1/api_keys` — **all 404**.

**Response headers carry nothing, on both request shapes.** A 200 from `/v1/models`, a
200 from non-streaming `/v1/responses`, and a 200 from **streaming** `/v1/responses` all
return only `x-request-id`, `x-route: model-api-rust`, CORS, `Content-Type`, and
(streaming) `Cache-Control` + `Transfer-Encoding`. No `x-ratelimit-*`, no `retry-after`.

Meta's docs publish `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`,
`x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests` and `Retry-After`. Three
measured request shapes carry none of them. They may appear only near a limit, or the
docs may be ahead of the deployment — either way **nothing may depend on them**, and a
parser that reads them when present must treat absence as normal.

**The console does not use a public API.** A signed-in browser observation of
`dev.meta.ai` shows the usage and billing pages calling internal Relay GraphQL:

| Surface | Path | Query |
|---|---|---|
| Usage | `POST /api/graphql/` | `LLMDCUsageQuery` (pinned `doc_id`) |
| API keys | `POST /api/graphql/` | `LLMDCAPIKeysQuery` (pinned `doc_id`) |
| Billing | `POST /api/billing/graphql/` | `BillingContextFactoryQuery`, `BiPSPaymentActivityViewQuery`, … |

Those need `fb_dtsg`, `lsd`, session cookies and a pinned `doc_id` that rotates with
every Meta deploy. Wiring them would mean shipping a Facebook session scraper that breaks
without warning. **Out of scope** — and now unnecessary, since the SSE event carries the
same two windows the dashboard needs.

What the docs do state, and what the provider can therefore say in prose:

> Limits apply per team, not per API key. If you use multiple keys in one team, all
> requests, tokens, images, and audio minutes count toward the relevant shared quota.

Defaults: Standard 3,000 RPM / 4M TPM; Contributor 100 RPM / 3M TPM.

## F. What that means for multi-account

Two consequences, and they cut in opposite directions.

**Reactive 429 failover works with no new code.** `isGenericFailoverProvider` returns
true for any `authMode: "oauth"` provider outside `{openai, anthropic}`, and rotation
arms automatically once two usable accounts exist. A `meta-muse` OAuth provider inherits
it. The only obligation is that upstream exhaustion reaches the router **as HTTP 429** so
`generic-account-failover` sees it.

**Quota display is possible, but only passively.** There is no endpoint to poll, so
nothing can be *probed* on demand: the quota arrives as a side effect of a streaming
turn. That is the same passive shape the Codex pool already uses for its
`x-codex-*-used-percent` headers — read off a real response, then cached.

Two consequences for the implementation:

- A `fetchMetaMuseQuota()`-style probe is **impossible**. Anything that would make
  `ocx account refresh` or a dashboard button issue a fresh quota call cannot exist,
  because obtaining one would mean spending a real inference turn.
- `supportsPerAccountQuota` must stay **false** regardless: that path calls
  `fetchAccountQuota`, which is a probe. Per-account quota would need a
  cache-read-only variant that does not exist today.

So the honest scope for **wp5** is: parse the event when a turn produces one, cache it
under the serving account, and let the dashboard show what was last observed. wp4 ships
the credential only and surfaces no quota.

And a trap worth recording: `fetchAccountQuota`'s fallback branch calls
`fetchAnthropicUsageQuota(token)` for any provider that is not `kiro` or
`google-antigravity`. **Adding `meta-muse` to the allowlist without a dedicated branch
would send a Meta bearer to Anthropic's endpoint.** Since Meta exposes no probe, the
correct action is to add nothing — but the hazard is documented here so a future
contributor does not "just extend the allowlist".

Per-team quota is also the wrong shape for per-account ranking: two keys in one team
share one pool, so ranking accounts by headroom would be measuring the same number twice.
**But subscription windows are per-subscription**, and two different Muse Code accounts
hold two different subscriptions — so the SSE percentages ARE per-account even though the
RPM/TPM limits are per-team. Ranking on them would be sound; it is out of scope only
because the cache-read-only seam does not exist yet.

## G. Method note

The first version of §E asserted a negative from an incomplete search: I probed URLs and
headers, found nothing, and generalized. The disproof came from a behavioral observation
I had already been given and had not used — the CLI's `/quota` answers instantly, which
rules out an on-demand HTTP call and points at data arriving in-band.

Same failure mode as `002` §G, where a docs-site search for "OAuth" returned nothing and
I concluded no flow existed until `muse login --help` disproved it in one command. Twice
now: **absence of evidence in the surface I happened to search is not evidence of
absence.** For a vendor claim, prefer a behavioral probe of the real client over an
inventory of guessed endpoints.
