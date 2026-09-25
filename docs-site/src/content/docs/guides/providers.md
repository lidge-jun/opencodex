---
title: Providers
description: Every way opencodex authenticates and talks to an LLM provider — OAuth, API key, ChatGPT forward, and local.
---

A **provider** is one upstream LLM endpoint plus how to reach it: an adapter, a base URL, an auth
mode, and an optional model list. Providers live under `providers` in `~/.opencodex/config.json`.

The dashboard provider Overview separates connection details, account usage and editable notes.
Notes appear once, below the connection and authentication sections. Supported sponsor presets
also show a short introduction, a Sponsor label and links to the provider's site or console.
These links preserve the preset's referral parameters. Sponsor information is shown only when
the configured provider name, adapter and endpoint match the preset; it never changes routing,
account selection or defaults.

## OpenAI account modes

| Provider id | Use | Credential/account rule |
| --- | --- | --- |
| `openai` | Codex login | Pool(default) selects main plus added accounts; Direct uses the current caller/main login only. |
| `openai-apikey` | OpenAI API | Configured API key/key pool only; never reads Codex accounts. |

Use bare `gpt-5.6-sol` with the Pool/Direct option on the Providers page, or
`openai-apikey/gpt-5.6-sol` for API. The credential routes never fall through into one another.
The API route publishes 1,050,000 context / 922,000 max input metadata. Its
`sol-pro`, `terra-pro`, and `luna-pro` virtual ids keep their selected public identity while the wire
uses the base model plus `reasoning.mode: "pro"`.

If the built-in `openai` provider is missing or disabled, the dashboard Accounts picker and Codex
Auth page can restore it: absent rows are created from the canonical preset, disabled canonical
rows are re-enabled without replacing saved mode or model settings, and noncanonical `openai`
rows are not offered that recovery path.

Luna Reserve compatibility is a ChatGPT account capability on the canonical OpenAI forward path,
not an OpenAI API-key entitlement. Its manual stored-main selector requires effective local authless
Desktop mode and current credential-bound upstream permission; a catalog entry alone does not
authorize a request. See [Luna Reserve alongside routed models](/reference/cli/providers-accounts/#luna-reserve-alongside-routed-models)
for setup, restart order, authorization requirements, and unsupported helpers.

For adding an account with exhausted quota and finishing its deferred validation, see
[Codex account warmup](/guides/codex-integration/#codex-account-warmup).

### Providers overview pool capacity

For Codex login in Pool mode, the Providers overview shows a configured-weight estimate of the
pool's used capacity rather than presenting one arbitrary account as the provider total. The same
row also shows the current effective account's raw quota percentage, so you can distinguish the
pool estimate from the account that a new request would use.

When reset information is available, the overview shows the next reset time and the capacity that
reset is expected to recover as `+N% pool capacity`. **Incomplete coverage** means one or more pool
accounts could not safely contribute to the estimate, for example because their plan or quota is
unknown, their reading is stale, or the account is paused or needs reauthentication.

A **partial window coverage** warning means some included accounts reported one quota window but
not another. The overview keeps those windows separate and marks each affected window incomplete
instead of treating the missing reading as usage for that window.

This estimate is display-only. It does not change account selection, session affinity, automatic
switching, cooldowns, or any other routing decision. Use the [Codex Auth account pool](/guides/web-dashboard/#codex-auth-and-account-pools)
for the individual account state and routing controls.

Shipped v1 configs migrate automatically to marker 2 and one option-aware row. The original config
is retained once at `~/.opencodex/config.json.pre-openai-tiers-v2.bak`; restore it with
`cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json`.

## Anthropic image input

The built-in Claude model seeds advertise text and image input for both `anthropic` (OAuth) and
`anthropic-apikey`, consistent with [Anthropic's model overview](https://platform.claude.com/docs/en/models/overview).
Explicit per-model input-modality overrides remain authoritative; unknown models are not assumed
image-capable. This applies across integrations wherever the client's configuration supports image
capability metadata: OpenClaw exports a declared `input` array, and Kimi Code exports
`capabilities: ["image_in"]` only for image-capable models. OpenClaw omits `input` when no supported
modalities are declared; Kimi omits `capabilities` for unknown or text-only models. Clients without
a supported capability field keep their existing configuration shape. After updating opencodex,
regenerate or refresh the client configuration managed by opencodex to receive the updated metadata.

## Auth modes

Provider configs accept three `authMode` values (`key` is the default). The built-in registry also
labels local presets separately; those normally omit both `authMode` and `apiKey`.

| `authMode` | How it authenticates | Used by |
| --- | --- | --- |
| `key` | Sends your API key (`Authorization: Bearer …`, or `x-api-key` / `api-key` per adapter). The key may be a literal or an `${ENV_VAR}` reference. | Most providers. |
| `forward` | Relays **your incoming Codex auth headers** verbatim to the provider — no key stored. This is the ChatGPT-login passthrough. | OpenAI (`openai-responses` adapter). |
| `oauth` | Resolves a stored OAuth access token (auto-refreshed before expiry) and uses it as the bearer key. | xAI, Anthropic, Kimi, Kiro, Google Antigravity, Cursor, Command Code, GitHub Copilot, Nous Portal. |

The [`retryOn429`](/reference/configuration/) same-key 429 replay applies only to API-key
providers (`authMode: "key"`). OAuth, forward, and local presets are excluded — their
credentials must never be replayed on the same token, and local runtimes have no remote key to
preserve. It is opt-in: when the option is absent the feature is off; object presence enables
it unless `enabled: false`.

### Which account a request spends

The question people ask before connecting an account is whether opencodex will draw on the
subscription that login already pays for, or bill a separate API account. The answer follows the
`authMode` above rather than the vendor's marketing tier.

- `forward` — the ChatGPT login. The request carries your Codex credential, so it spends the
  ChatGPT plan behind that login and reports that plan's Codex quota windows. Which windows exist
  is plan-dependent: not every plan has a five-hour window. It never reads an API key.
- `oauth` — a subscription login. The request carries a stored access token, so it spends whichever
  account you logged in as, and opencodex reports whichever usage windows that provider exposes.
- `key` — the request carries the key you supplied, so usage lands on the account that owns that
  key, on that key's own terms. That is metered usage for a pay-as-you-go API account, but a plan
  allowance when the key *is* a subscription: Z.AI GLM Coding Plan, Kimi Code, the BigModel coding
  plan, Command Code and CodeBuddy all sell one that way.

A request uses exactly one of these, and opencodex does not fall back from one to the other. When an
OAuth credential cannot be resolved the request fails with an authentication error instead of
reaching for a stored key, and the key-pool failover that answers a 429 or a 401 is refused outright
for OAuth and forward providers.

Two exceptions are worth knowing because you can hit them:

- `xai` and `github-copilot` accept `authMode: "key"` on the same provider id, and if that provider
  already had a key stored, running `ocx login` for it can leave it in key mode rather than
  switching it to the subscription. What that changes differs: an `xai` key retargets the provider
  to `https://api.x.ai/v1`, so a different account pays, while a `github-copilot` key is still a
  Copilot credential against `api.githubcopilot.com`, so the Copilot subscription pays either way.
- `orcarouter-oauth` is a consent flow that mints a user-owned `sk-orca-…` API key. Once it has,
  the request carries a key, so it follows the `key` rule above.

#### Providers that accept both a login and a key

| Provider | Subscription login | API key |
| --- | --- | --- |
| OpenAI / ChatGPT | `openai` — Codex login; spends the ChatGPT plan behind it | `openai-apikey` — a separate provider; usage lands on the OpenAI Platform account that owns the key |
| Anthropic | `ocx login anthropic` — signs in as your Claude account. opencodex reads its five-hour and seven-day usage windows; that endpoint reports no subscription tier | `anthropic-apikey` — direct Anthropic API billing, no Claude subscription |
| xAI | `ocx login xai` — the Grok CLI subscription gateway. opencodex reads SuperGrok weekly credits, or the monthly pool | the same `xai` provider with `authMode: "key"`, which targets `https://api.x.ai/v1`, so usage lands on that API account |
| Kimi | `ocx login kimi` — log in with your Kimi account. `kimi-responses` is the same Kimi account login routed over the OpenAI Responses wire (thinking content stays encrypted server-side, tool calls stay visible; the default Chat preset keeps plaintext reasoning) | `kimi-code` — the API-key form of the same Kimi Code Plan transport |
| Command Code | `ocx login command-code` — opencodex reads five-hour and weekly windows plus a credit balance | `commandcode` — the same service on `/provider/v1` with a key |
| GitHub Copilot | `ocx login github-copilot` — requires an active Copilot subscription | the same `github-copilot` provider with `authMode: "key"`. The device flow above is the supported path, and either credential is a Copilot one, so the subscription still pays |
| OrcaRouter | `ocx login orcarouter-oauth` — consent mints a user-owned, long-lived `sk-orca-…` key, and the request then carries a key | `orcarouter` — the same key pasted by hand |
| Meta Muse | `ocx login meta-muse` can import a local Muse Code CLI key or start device login. Meta scopes that credential to its own CLI, so this is an unsupported use: how the calls settle is not observable from the API, and you should treat every call as billable against your account | `meta-model` is the supported path — every call is metered per token, and a Muse Code subscription does not work there |

Cursor, Kiro and Nous Portal are login-only and have no API-key equivalent. Google Antigravity is
login-only too: `ocx login google-antigravity` signs in with your Google account over the Cloud Code
Assist wire, and the `google` preset beside it is the AI Studio Gemini API — a different product
reached with its own key, not a key mode for the same login.

To check which mode a provider is actually using, open it on the Providers page: the **Connection**
block's **Authentication** row reads `OAuth`, `API key`, `ChatGPT passthrough`, `Local`, or
`No key needed`. It is a provider-level setting, so the account rows below it do not repeat it.

## 1. ChatGPT login (forward / passthrough)

The `openai` provider needs **no API key**. Direct forwards credentials from your existing
`codex login`; Pool resolves a main or added Codex account before using the same backend:

```json
{
  "openai": {
    "adapter": "openai-responses",
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "authMode": "forward"
  }
}
```

Only a curated set of headers is forwarded (`FORWARD_HEADERS`: authorization, ChatGPT account id,
OpenAI beta/originator/session — see [Adapters](/reference/adapters/)). This path is also
what powers the [web-search and vision sidecars](/guides/sidecars/).

The ChatGPT passthrough catalog also layers in the bare GPT-5.6 Sol/Terra/Luna slugs
(`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`) for accounts that can use them.

## 2. Account login (OAuth)

Provider presets can use account login — including GitHub Copilot via an experimental unofficial
device-flow bridge. opencodex stores their credentials in
`~/.opencodex/auth.json`; refreshable tokens are refreshed automatically, while durable keys are
reused until the provider revokes them. `ocx login codex` is accepted as well, but it is not one of
these providers: it routes to the Codex account pool — the same flow as `ocx account login codex`,
which keeps its own account ledger and needs a running proxy. `chatgpt` and `openai` are aliases of
that route.

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx login nous         # Nous Portal (device grant; free + paid models)
ocx login kiro         # import kiro-cli credentials (or token fallback)
ocx login google-antigravity
ocx login cursor       # standalone Cursor PKCE login
ocx login command-code # Command Code browser OAuth (or import ~/.commandcode/auth.json)
ocx login orcarouter-oauth # OrcaRouter browser consent + PKCE
ocx login devin       # Cognition/Devin: import Devin CLI credential, else Auth0 browser sign-in
ocx login github-copilot  # GitHub device flow → Copilot token (Copilot Pro/Business)
ocx login codex        # Codex account pool (aliases: chatgpt, openai; needs a running proxy)
ocx logout <provider>
```

| Provider | Adapter | Base URL | Notes |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://cli-chat-proxy.grok.com/v1` | OAuth uses the separate Grok CLI subscription gateway. The API-key override uses `https://api.x.ai/v1` and may inject Priority Processing. Live-first Grok catalog; `grok-4.5` is the fallback default. |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude models; live model list fetched from `/v1/models`. |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi Code Plan coding models. Defaults to the stable `kimi-for-coding` alias (currently K2.8 Preview): 1M-token context window, adjustable `low`/`high`/`max` thinking (default `max`), text + image input. Retired `kimi-k2.x` selections are migrated to the alias on upgrade. |
| `kimi-responses` | `openai-responses` | `https://api.kimi.com/coding/v1` | Same Kimi account login (reuses the `kimi` OAuth credential) over the OpenAI Responses wire. Same model roster and capabilities as `kimi`; thinking content stays encrypted server-side, tool calls and results stay visible. |
| `nous` | `openai-chat` | `https://inference-api.nousresearch.com/v1` | Nous Research subscription gateway (same backend Hermes Agent uses). Device-grant login against `portal.nousresearch.com`; the access token is the per-request inference JWT. Mixed paid + `:free` model catalog (`tencent/hy3:free`, `stepfun/step-3.7-flash:free`, ...) discovered live from the signed-in account. Refresh tokens are single-use and rotated on every refresh. |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | Initial login imports the installed, signed-in `kiro-cli` session (on Unix, install with `curl -fsSL https://cli.kiro.dev/install` &#124; `bash`; on Windows PowerShell, use `irm 'https://cli.kiro.dev/install.ps1'` &#124; `iex`; then run `kiro-cli login`). **Add account** logs `kiro-cli` out, starts a fresh browser login that switches the account used by `kiro-cli`, and stores account-scoped profile metadata. Existing OpenCodex accounts are preserved, and cancellation or failure restores the previous `kiro-cli` session. |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | Google OAuth over the Cloud Code Assist wire. Live discovery uses CCA's authenticated `v1internal:fetchAvailableModels` endpoint and publishes the agent models available to the signed-in account; the maintained catalog remains the fallback. |
| `cursor` | `cursor` | `https://api2.cursor.sh` | Experimental PKCE login, live HTTP/2 transport with an opt-in HTTP/1.1 compatibility path, and account-filtered model discovery. |
| `orcarouter-oauth` | `openai-chat` | `https://api.orcarouter.ai/v1` | Browser consent and key exchange use `https://www.orcarouter.ai` with S256 PKCE. The returned user-owned `sk-orca-…` API key is stored in the existing credential store and reused until revoked. |
| `devin` | `devin` | `https://server.codeium.com` | Experimental unofficial Cognition/Devin bridge. Login first imports the credential the installed Devin CLI already holds (`devin auth login` writes a `devin-session-token` to its own `credentials.toml`); when none is present it opens Auth0 browser sign-in and exchanges the pasted token via Cognition's `RegisterUser` for a long-lived API key. `ocx login devin-cli` remains as a deprecated alias. Models are discovered per account with `GetCascadeModelConfigs`. Not shown in the dashboard preset by default. Chat and usage reporting are verified against a live account across three models. |
| `github-copilot` | `openai-chat` | `https://api.githubcopilot.com` | Experimental. GitHub device flow + `copilot_internal` exchange (VS Code OAuth client). Requires an active Copilot subscription; not an official third-party API. |

Google Antigravity account and provider quota probes use fixed Google accounting endpoints, including the models fallback. They support transparent Fake-IP DNS for those destinations while retaining TLS verification, redirect rejection and private-address checks. A custom provider base URL changes model requests, not quota destinations; `NO_PROXY` continues to select the direct-route policy.

### Google tool-schema loss diagnostics

Google tool declarations are compiled against the selected endpoint class. When provider debug is
on — `ocx debug provider on`, the dashboard Logs toggle, or `OCX_DEBUG=1` — schema loss during compatibility
conversion on the omitted or `compatible` policy path emits a `[ocx:google:google-tool-schema-loss]`
record (tail with `ocx debug provider logs -f`)
carrying only the report version, endpoint class, a `lossy` indicator, a bounded uncertainty count,
fixed loss categories with bounded counts, and a truncation flag. Tool and property names, paths, values, and schema text are
never included. With an omitted or `compatible` policy, this diagnostic observes the existing
conversion without rejecting it. Under `reject-lossy`, an initially lossy or comparison-indeterminate
compilation is refused before dispatch; no separate loss record is emitted for the refused request. Under
`reject-lossy`, a Vertex or Cloud Code Assist repair that would erase constraints emits a similarly
content-free `google-tool-schema-repair` record and returns the original 400 without a changed send;
with an omitted or `compatible` policy, the repaired request is replayed as before. Direct AI
Studio never performs this repair. Native output schemas are outside both policy paths. See the
[debug command reference](/reference/cli/agents/).


After a terminal Nous refresh failure, run `ocx login nous` to reauthenticate.

For the canonical Kimi Coding Plan presets (`kimi` account login and `kimi-code` API key),
opencodex forwards only a caller-supplied stable `prompt_cache_key` to the Chat Completions request
(the Responses wire accepts the same field, but opencodex does not send it there today);
it never generates one. Kimi documents a stable session/task key as required to improve Code Plan
cache hit rates, while requests without a key remain keyless. If an opted-in upstream rejects the
field, opencodex does not strip it and retry or mutate saved configuration. Other providers remain
deny-by-default.

Kimi Coding usage prices for `k3`, `k3[1m]`, and `k3-256k` are **API-reference estimates** across
`kimi`, `kimi-code`, and `kimi-responses`, using the published default 5-minute cache-write rate.
They do not reproduce Code Plan billing or quota: K3's 1M variant consumes about twice the quota
of `k3-256k`. `kimi-for-coding` now points to K2.8 Preview, so its former K2.7 price is no longer
used; its estimate remains unavailable unless the operator supplies `modelCosts`. Unknown-price
routing policies and cost caps that exclude unknown estimates can therefore exclude this alias.
See [Kimi's model configuration](https://www.kimi.com/code/docs/en/kimi-code/models.html) and
[API pricing](https://platform.kimi.ai/docs/pricing/chat).

A custom `openai-chat` provider can opt in when its upstream documents support for
`prompt_cache_key`:

```json
{
  "providers": {
    "example-compatible-provider": {
      "adapter": "openai-chat",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "${EXAMPLE_API_KEY}",
      "promptCacheKey": true
    }
  }
}
```

The adapter forwards the key it is given and never invents one. It can still receive a key the
caller did not send: Claude Messages translation derives one from `metadata.user_id`, or from a
model/system/tools cohort when the client sends no metadata, because the OpenAI backends report
`cached_tokens: 0` for every keyless turn. So "forwarded, not fabricated" describes this adapter,
not the whole request path.

Preserve the rest of the provider configuration when adding the option, then reload or restart
opencodex. To validate caching, compare the initial cold request with later requests carrying the
same stable key. Leave the option omitted or set it to `false` for incompatible upstreams, and
disable or remove it if a strict gateway returns an HTTP 400 unknown-field error.

You can also start OAuth from the [web dashboard](/guides/web-dashboard/).

### Logging in from another browser profile, or another machine

When a login starts, the proxy opens the authorization URL on **its own** machine, using the OS
default browser — and therefore the default profile. That is the right behavior for a local
desktop and the wrong one in two common cases: you need a different browser profile (a work
identity, a second account), or the dashboard is open against a proxy running somewhere else.

Every login surface shows the authorization URL with a copy button, the device code when the
provider issues one, and a field to paste the redirect URL or authorization code back. So you can
always finish a login by hand.

To stop the proxy from opening a browser at all, tick **Don't open a browser on the proxy machine**
beside the login button, or set it permanently:

```json
{ "oauthOpenBrowser": false }
```

Absent and `true` both open, so nothing changes for an existing install; only an explicit
`false` declines. `POST /api/oauth/login` and `POST /api/codex-auth/login` also accept a
per-request `openBrowser` boolean that overrides the stored setting for that login.

Two cases behave differently, and it is worth knowing which you are in:

- **A different browser profile on the same machine** works with the copied link alone. The
  loopback callback on `127.0.0.1` still completes the flow.
- **A browser on a different machine** also needs the paste fallback, because the redirect URI is
  still `http://127.0.0.1:<port>/callback` on the proxy's host. Finish the login there, then paste
  the redirect URL (or just the code) back into the dashboard or `ocx account code`.

Device-code providers never open a browser from the proxy in either case: they show a code and a
verification URL to open wherever you are signed in.

### Multiple OAuth accounts

OAuth providers whose credentials include a stable account id or email can keep more than one
login. The Providers page shows those accounts in a dropdown, lets you add another, and switches the
active account without logging the others out. A normal login with an identity-less Kimi credential
replaces the active slot, while an explicit **Add account** preserves that slot and activates a new,
distinct one. Kiro accounts are keyed by profile ARN. `chatgpt` is always single-slot because Codex
pool accounts have a separate ledger.
Tokens stay in `~/.opencodex/auth.json`; `/api/oauth/accounts` returns masked metadata only.

### Cockpit Tools Antigravity import

For v1, OpenCodex imports only a **Cockpit Tools Antigravity** JSON export for the `google-antigravity` provider. In the Providers dashboard, choose the local JSON file from that provider's Accounts tab. The dashboard does not show the file contents or credential values; it reports only imported, updated, failed, and unsupported counts. Other Cockpit providers are rejected in v1.

The CLI accepts the export from a file or standard input only — never paste it into a command argument:

```bash
ocx account import google-antigravity --format cockpit-tools --file <path> [--json]
cat accounts.json | ocx account import google-antigravity --format cockpit-tools --stdin [--json]
```

Inline JSON and extra positional arguments are rejected. Keep exported files private and delete or store them securely after import.

### OAuth reliability

opencodex coordinates token refresh and Codex pool routing so concurrent requests do not race the
credential store. This is reliability and diagnostics work — it does **not** guarantee protection
from provider enforcement, rate limits, or account actions.

**Refresh coordination.** Before a routed call, an expired access token is refreshed once per
`(provider, account)`:

1. In-process single-flight — concurrent callers share one refresh promise.
2. Per-account file lock — cross-process writers serialize on the same account.
3. Generation CAS — persist only when the stored credential generation still matches; a newer writer
   wins, and an older refresh result cannot overwrite it.

Terminal refresh failures mark the account as needing reauthentication instead of retrying forever.

**Cooldowns (Codex pool).** Upstream `429` / quota responses set a hard cooldown from
`Retry-After`, quota `reset` headers (capped), or a short default backoff. Accounts on an explicit
`Retry-After` cooldown are not probed early; reset-derived cooldowns may receive a paced probe lease
so recovery can be detected without flooding the provider. Reset-derived native-model cooldowns
keep shared native quota (including GPT-5.6 Terra/Luna) separate from `gpt-reserve`.
Models in the shared group still protect one another; an ordinary success cannot clear a Reserve cooldown.
Explicit `Retry-After` and default cooldowns always remain account-wide.

**Session affinity.** Codex thread→account affinity is process-local (in-memory only; not persisted
across proxy restarts). On credential failures (`401` / `403`) the account is quarantined for
reauth and affinities for that account are cleared. On `429`, the account enters cooldown, affinities
are cleared, and pool selection may rotate — threads are not pinned through a rate-limit response.

**Return to a recovered account.** To resume using the highest-priority account during an
ongoing task, enable `ocx config set codexAccountPriorityFailback true` and keep the Pool strategy
at `quota` with automatic switching enabled. For example, a task can move from Plus to another
account when its five-hour window fills, then return to Plus after the quota refresh confirms
recovery. While requests are flowing, background refresh attempts run at most once every five
minutes. The request that triggers a refresh may still use the previous account; the next request
after the refresh completes can move back. Already-running requests finish on their captured
account. Manual account pins and model-access restrictions still apply. This feature is off by
default; use `ocx config set codexAccountPriorityFailback false` to restore stable bindings.

The bound source account's effective threshold controls this preference: override `0` disables it,
and a positive override works even when the global threshold is `0`. A candidate must have known,
non-exhausted usage below its own positive effective threshold. Candidate `0` removes only that
threshold preference; eligibility, cooldown and hard locks still apply. Each window contributing
to its score needs a recent live observation in this process. Credits-only updates, retained
windows and hydrated display bars do not by themselves prove recovery.

**Codex client metadata.** The ChatGPT forward path passes through the curated `FORWARD_HEADERS`
allowlist (authorization, `chatgpt-account-id`, originator, session/thread ids, and related Codex
headers — see [Adapters](/reference/adapters/)). Pool mode overwrites only auth and
`chatgpt-account-id` to match the selected credential. opencodex does **not** fabricate official
client identity (for example `originator`, session, or thread headers) when the caller did not send
them.

For account-switch compatibility diagnosis, enabling provider debug (`ocx debug provider on`) adds
one `[ocx:codex:affinity]` line per canonical ChatGPT forward response. The line contains header
presence, coarse size buckets, process-local HMAC equality tags, safe summaries of known top-level
turn fields, and a count of unknown turn fields. It never includes raw credentials, account ids,
attestation values, thread/session ids, turn metadata, or request bodies; the tags intentionally
change after every proxy restart. Use `ocx debug provider logs -f` while
reproducing the two requests, then run `ocx debug provider off`. This capture is observation-only and
does not strip metadata, retry a request, switch accounts, reset a thread, or otherwise affect routing.

**Diagnostics and reauth.** Human `ocx status` prints an OAuth health block (redacted account ids,
no tokens). `ocx doctor` adds an OAuth reliability section with writable-store / single-flight checks
and WARN rows that include a recovery Action. When an OAuth provider account needs reauthentication, run
`ocx login <provider>` (or use Reauthenticate in the dashboard). Codex pool accounts are not one of
those providers, but `ocx login codex --reauth` routes to their account-pool reauthentication, which
the dashboard Codex account pool also performs. See
[`ocx status` / `ocx doctor`](/reference/cli/) in the CLI reference.

### Kiro credential import

Kiro login expects the Kiro CLI: on Unix, install it with `curl -fsSL https://cli.kiro.dev/install | bash`;
on Windows PowerShell, use `irm 'https://cli.kiro.dev/install.ps1' | iex`; then sign in with `kiro-cli login`.
Without a `kiro-cli` session, `ocx login kiro` falls
back to a pasted access token or the `KIRO_ACCESS_TOKEN` environment variable.

The `ocx login kiro` import path searches the platform Kiro CLI stores and opens SQLite databases
read-only. Two environment variables make the source and token row selection explicit:

- `KIROCLI_DB_PATH` selects a nonstandard Kiro CLI SQLite database. The path must already exist;
  during this import path, opencodex does not create or modify the database, WAL, or SHM files.
- `KIROCLI_TOKEN_KEY` selects the exact `auth_kv` token key when a database contains multiple
  otherwise ambiguous token rows. A missing selection fails login instead of guessing.

On Windows, import looks for `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3`. Forced/add-account login
also needs the local CLI binary: opencodex first uses `PATH`, then falls back to
`%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe` and `C:\Program Files\Kiro-Cli\kiro-cli.exe`.
If neither folder has `kiro-cli.exe`, a `kiro.exe` inside those same two `Kiro-Cli` folders is used.
opencodex never runs a short `kiro` or `kiro.exe` found on `PATH` or in shared macOS/Linux bin
directories, so install or link the CLI as `kiro-cli` there.

After a successful import, opencodex persists the imported credential to
`~/.opencodex/auth.json`.
Keep these variables and the selected database private. Do not attach database files or raw login
diagnostics to bug reports.

**Add account** is a separate write workflow: it snapshots the current session, logs `kiro-cli` out,
and imports the fresh browser login. If the login is cancelled or fails, including while OpenCodex
persists the credential, rollback replaces the Kiro CLI database and removes its current WAL, SHM,
and journal sidecars before publishing the previous session snapshot.

Because that rollback is only possible from a snapshot, **Add account** refuses to sign `kiro-cli`
out when a session store is present but cannot be captured (unreadable file, mismatched schema, or
an ambiguous token selection), when `KIROCLI_DB_PATH` / `KIRO_CLI_DB_FILE` redirect import reads away
from the live CLI store, or when an existing primary CLI database has no recognized token row.
Repair or remove the unreadable database under the normal `kiro-cli` data path, unset those import
selectors, then retry. Signing in from a machine with no existing `kiro-cli` session is unaffected.

## 3. API-key catalog

opencodex ships 99 built-in presets: 82 key-based, 13 OAuth, three local, and one default
ChatGPT-forward preset. The dashboard's **Add provider** picker opens a key provider's dashboard,
validates the key, and stores it; validation is provider-specific. Notable entries:

**ClinePass** uses a Cline API key with the [official subscription catalog](https://docs.cline.bot/getting-started/clinepass)
and [Chat Completions endpoint](https://docs.cline.bot/api/chat-completions), operated by Cline Bot Inc. under
[Cline's terms](https://cline.bot/tos). A routed id such as `cline-pass/cline-pass/kimi-k3` is
intentional: the first segment selects the opencodex provider, while `cline-pass/kimi-k3` is the
full model slug sent upstream. ClinePass quota is shared by the account across rolling 5-hour,
weekly, and monthly limits. A 2026-08-13 live probe verified that every static ClinePass model
accepts `low`, `medium`, `high`, `xhigh`, and `max` at the gateway input boundary. opencodex
preserves those requested tiers; any backend-specific normalization remains ClinePass's responsibility.

**Cline** is the same API key and endpoint on pay-as-you-go usage billing across 100+ models
(OpenRouter-style ids like `anthropic/claude-sonnet-4-6`). Cline's promotional free models are only
available in the Cline IDE/CLI, not through the API; `minimax/minimax-m2.5` is the documented API
free-experimentation model.

**OrcaRouter** ([sponsor](https://github.com/lidge-jun/opencodex/blob/main/SPONSORS.md)) is an
OpenAI-compatible gateway at `https://api.orcarouter.ai/v1` with vendor-namespaced model ids
(`openai/gpt-5.5`, `anthropic/claude-opus-4.8`, `deepseek/deepseek-v4-flash`, ...) and an adaptive
router, `orcarouter/auto`, that grades each prompt and picks the model. Create a key in the
[OrcaRouter console](https://www.orcarouter.ai/console); the preset pins the row near the top of the
Add provider picker and marks it as a sponsor, and nothing else about routing or defaults changes.

**PackyCode** ([sponsor](https://github.com/lidge-jun/opencodex/blob/main/SPONSORS.md)) is an API
relay for Claude Code, Codex, Gemini and more. The preset targets their OpenAI-compatible Chat
Completions endpoint, `https://cf.api.fan/v1`, with live model discovery narrowed to what your
token group allows (`gpt-5.5` and `gpt-5.1-codex` are seeded). Register at
[packyapi.com](https://www.packyapi.com/register?aff=k5KT) and create a Codex-group token; the preset
pins the row near the top of the Add provider picker and marks it as a sponsor, and nothing else about
routing or defaults changes.

**Opper** is the EU-hosted AI gateway from Opper AI (Stockholm): one key (created at
[platform.opper.ai](https://platform.opper.ai)) and one OpenAI-compatible endpoint in front of 700+
models from 30+ providers. Bare model ids such as `claude-sonnet-4-6` or `gpt-5.5` are *pools*: Opper
picks the provider and region per request, so the seeded ids stay valid as routes come and go. A
`vendor/model` id (`anthropic/claude-sonnet-4-6`, `aws/claude-sonnet-4-6-eu`) pins one route instead.
The catalogue is discovered live from `/v3/compat/models` with your key; the public list, including
region-pinned EU routes, is at [opper.ai/models](https://opper.ai/models). Opper is also a
[models.dev](https://models.dev) provider (`opper`), which uses the same bare pool ids.

| Provider | Base URL |
| --- | --- |
| **OpenAI (API key)** | `https://api.openai.com/v1` |
| **Anthropic (API key)** | `https://api.anthropic.com` |
| **OpenRouter** | `https://openrouter.ai/api/v1` |
| **Cline** | `https://api.cline.bot/api/v1` |
| **ClinePass** | `https://api.cline.bot/api/v1` |
| **Ollama Cloud** | `https://ollama.com/v1` |
| Google Gemini · Google Vertex AI | `https://generativelanguage.googleapis.com` · `https://aiplatform.googleapis.com` |
| Azure OpenAI | `https://{resource}.openai.azure.com/openai` |
| Umans AI · Neuralwatt | `https://api.code.umans.ai` · `https://api.neuralwatt.com/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| MiniMax · MiniMax (CN) | `https://api.minimax.io/v1` · `https://api.minimaxi.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| Cerebras | `https://api.cerebras.ai/v1` |
| Chutes | `https://llm.chutes.ai/v1` |
| DeepInfra | `https://api.deepinfra.com/v1/openai` |
| Hyperbolic | `https://api.hyperbolic.xyz/v1` |
| Nscale Serverless Inference | `https://inference.api.nscale.com/v1` |
| Vultr Serverless Inference | `https://api.vultrinference.com/v1` |
| Baseten Model APIs | `https://inference.baseten.co/v1` |
| Command Code | `https://api.commandcode.ai/provider/v1` |
| OrcaRouter | `https://api.orcarouter.ai/v1` |
| PackyCode | `https://cf.api.fan/v1` |
| Meta Model API | `https://api.meta.ai/v1` |
| Meta Muse Code (CLI credential) | `https://api.meta.ai/v1` |
| SambaNova Cloud | `https://api.sambanova.ai/v1` |
| Nebius Token Factory | `https://api.tokenfactory.nebius.com/v1` |
| Crusoe | `https://api.inference.crusoecloud.com/v1` |
| DigitalOcean Serverless Inference | `https://inference.do-ai.run/v1` |
| Scaleway Generative APIs | `https://api.scaleway.ai/v1` |
| Featherless AI | `https://api.featherless.ai/v1` |
| Novita AI | `https://api.novita.ai/openai/v1` |
| Together | `https://api.together.xyz/v1` |
| Fireworks | `https://api.fireworks.ai/inference/v1` |
| Moonshot (Kimi API) · Kimi (coding) | `https://api.moonshot.ai/v1` · `https://api.kimi.com/coding/v1` |
| Hugging Face | `https://router.huggingface.co/v1` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` |
| Z.AI (GLM Coding) | `https://api.z.ai` — Responses at `/api/v1/responses` by default; Chat Completions at `/api/coding/paas/v4/chat/completions` per model through `modelAdapters` |
| Zhipu AI (BigModel) | `https://open.bigmodel.cn/api/paas/v4` |
| BigModel Coding Plan (Responses, static roster) | `https://open.bigmodel.cn/api/v1` |
| Qwen Cloud | Token plan (default): `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` · Pay as you go: `https://dashscope.aliyuncs.com/compatible-mode/v1` · or Custom |
| Tencent Cloud Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/v3` |
| SiliconFlow | `https://api.siliconflow.cn/v1` |
| Volcengine Ark · Coding Plan · Agent Plan | `https://ark.cn-beijing.volces.com/api/v3` · `https://ark.cn-beijing.volces.com/api/coding/v3` · `https://ark.cn-beijing.volces.com/api/plan/v3` |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Xiaomi MiMo (OpenAI Chat) | `https://api.xiaomimimo.com/v1` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| Opper | `https://api.opper.ai/v3/compat` |
| GitLab Duo | `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic` |
| …and more | opencode zen, Vercel AI Gateway, Venice, NanoGPT, Synthetic, Qianfan, Alibaba, Parallel, ZenMux, LiteLLM |

**OpenCode Go** requires a stable session identifier for routing. OpenCodex derives
its Go session header from Codex thread/session headers, or from a client's
`x-opencode-session` header when Codex headers are absent. This applies to direct
Chat Completions requests and requests bridged to Responses. Even an `ocx_`-prefixed
inbound value is treated as client input and
hashed into Go affinity; the internal bridge carries the original value, so native
Chat, bridged Chat, and Responses derive the same result. Explicit provider-config
session headers are operator overrides and are sent unchanged. Clients must keep the
identifier stable within a conversation and distinct across conversations. A request
without any session identifier is not given an inferred cross-request identity; it is
instead sent under a session allocated for that request alone, isolated from every
other request (see the provider reference for how that value is carried).
For Claude Messages, configured OpenCode Go session headers remain authoritative.
Otherwise, valid explicit session or thread headers take precedence, and valid
conversation identity in `metadata.user_id` supplies the fallback. This fallback is
applied to the final Go destination, including random combo selections and fallback
attempts, rather than the preliminary route. Shared system-prompt cache keys do
not identify conversations, and Go-specific identity is not sent to non-Go targets.
Generated Pi provider configurations enable `compat.sendSessionAffinityHeaders`
so Pi sends its per-session identity to the proxy. Existing manually managed Pi
configurations can set this option on their `opencodex` provider as well.
Pi can omit session affinity when `cacheRetention` is `none`; enable cache retention
when a stable upstream session is required.

**MiMo tool-call echoes.** On OpenCode Go and other Chat Completions routes, a bare
`<tool_call>` block is hidden when it duplicates one structured call to the same tool
with the same effective input. If the input differs or several calls could explain
the block, the markup remains visible. Tool execution still uses the structured call.

**OpenCode Zen** (`opencode-zen`) and the keyless **OpenCode Free** preset share
`https://opencode.ai/zen/v1`. Free models on that gateway often hit a short-window burst
limit around 15–20 requests/minute (community-measured; OpenCode does not publish RPM).
Zen may return generic rate-limit 429 responses without `Retry-After` / `X-RateLimit-*`
headers. That is separate from the keyless desktop quota OpenCode advertises
(~200 Big Pickle/free-model requests per 5 hours on `opencode-free`). When Zen omits
`Retry-After` on such a 429, opencodex adds provider guidance to the client error and a
synthetic `Retry-After`; an upstream `Retry-After` still takes precedence. Same-key
wait-and-retry remains opt-in via [`retryOn429`](/reference/configuration/).

**The keyless `opencode-free` tier is currently closed to third-party clients.** Zen refuses
any request that arrives without an `x-opencode-session` header, answering with error type
`MissingSessionID` and the message "OpenCode's free tier can only be used in OpenCode". Presence
of the header is the entire gate, so a proxy could pass it by inventing a value — opencodex does
not. Minting a session identifier and a versioned `opencode/<version>` User-Agent is a claim to
*be* the OpenCode client, and OpenCode publishes no third-party integration contract for this
keyless tier; an HTTP 200 obtained that way is a bypassed admission check rather than
permission. opencodex therefore reports the restriction instead of working around it: a request
to `opencode-free` returns an error explaining the upstream gate and pointing here.

The supported route to the same models is the keyed **`opencode-zen`** provider with an OpenCode
Zen API key from [opencode.ai/auth](https://opencode.ai/auth). If OpenCode later publishes a
supported third-party path for the keyless tier, opencodex can follow it; until then the preset
stays as documentation of the restriction. Upstream terms:
[opencode.ai/docs/zen](https://opencode.ai/docs/zen/).

Most use the `openai-chat` adapter with a bearer key; Anthropic-compatible presets such as
**Xiaomi MiMo** (`xiaomi`) use the `anthropic` adapter (`x-api-key`). Xiaomi also has an OpenAI Chat
preset, `xiaomi-mimo`, and a token-plan preset, `mimo`. All three default to MiMo V2.6 (`mimo-v2.6-pro`,
or `mimo-v2.6-flash` on `xiaomi-mimo`). Xiaomi retires `mimo-v2.5` and `mimo-v2.5-pro` on 2026-10-21
with no redirect, so switch a saved V2.5 default before then; opencodex does not rewrite it for you.
Volcengine Coding Plan and Agent Plan use their native Responses endpoints through `openai-responses`.
During validated Ark Coding Plan tool continuations, replaying the returned Responses `reasoning` item
answered `400 InvalidParameter`, so the Coding Plan preset drops replayed reasoning items before
forwarding continuation input; that is lossy, and `dropResponsesReasoningItems: false` turns it off.
An install that already saved the Coding Plan provider on `openai-chat` keeps that wire — nothing
rewrites a stored row — so switching is a deliberate edit: set `adapter` to `openai-responses` and
`responsesPath` to `/responses`, or delete and re-add the preset. Explicit per-model `openai-chat`
overrides remain available either way. The built-in DeepSeek preset also routes `deepseek-v4-flash` over its native Responses endpoint and
keeps upstream SSE streaming enabled. If that model finishes every output item but omits the final
Responses event, opencodex applies a five-second model-scoped grace repair; malformed or partial
streams close as incomplete rather than being reported as successful.
The first-party `deepseek-flash` model advertises native `text` and `image` input, so image requests
are sent directly to DeepSeek by default instead of through the vision sidecar. Explicit
`noVisionModels` or text-only declarations remain authoritative. First-party `deepseek-chat`,
`deepseek-reasoner`, and `deepseek-v4-flash` remain sidecar-backed by default. Zen routes are
unchanged and were not probed in this update.

> **Three Volcengine billing routes:** `volcengine` is the pay-as-you-go Ark API,
> `volcengine-coding-plan` consumes Coding Plan quota, and `volcengine-agent-plan` consumes Agent
> Plan quota. Use the key and endpoint issued for the same product; the ordinary `/api/v3` endpoint
> can incur pay-as-you-go charges even when a Plan subscription exists.
> The presets use curated static model catalogs because Ark's `/models` response also includes
> embedding, image, video, and 3D resources, the Coding gateway returns that same broad catalog,
> and the Agent Plan gateway has no `/models` resource. Pay-as-you-go defaults to
> `doubao-seed-2-1-pro-260628`; its curated catalog also includes current DeepSeek and GLM text
> models. Coding Plan defaults to `ark-code-latest`, while Agent Plan defaults to
> `deepseek-v4-flash`.

> **Volcengine Plan usage restriction:** Volcengine documents Coding Plan and Agent Plan quota as
> valid only inside supported AI coding tools, and warns that using a plan key for general API
> calls may suspend the subscription or ban the account. Routing Codex or Claude Code through
> opencodex is the documented use; pointing other automation at a plan key is not. The
> pay-as-you-go `volcengine` route carries no such restriction.

**Chutes discovery.** The `chutes` preset uses Chutes' fixed shared OpenAI-compatible LLM gateway.
It reads the public `/v1/models` catalog, keeps only rows whose `supported_features` advertise
`tools`, preserves slash-containing model ids and safe live metadata, and caps discovery at 256 KiB
and 128 raw rows. Because that catalog is public, it cannot prove a supplied key is valid; chat
requests still use the configured Bearer key. User-deployed custom Chute hosts and Chutes' non-LLM
APIs remain custom-provider territory. Create a key from the [Chutes dashboard](https://chutes.ai/auth/start).

**DeepInfra discovery.** The key-based `deepinfra` OpenAI Chat Completions provider uses the
`openai-chat` adapter with a Bearer API key. Its registry-owned model-list URL keeps only rows tagged
`chat`, preserves slash-containing native model ids, and caps live discovery at 512 KiB and 512 raw
rows. Create keys in [DeepInfra's dashboard](https://deepinfra.com/dash/api_keys).

**Hyperbolic discovery.** The preset reads `/v1/models` with the configured bearer key, preserves
slash-containing native model ids, and caps live discovery at 256 KiB and 256 raw rows. It covers
serverless text and vision-language chat only; Hyperbolic's separate image, audio, and GPU endpoints
are out of scope. Create keys at [Hyperbolic](https://app.hyperbolic.ai).

**Nscale and Vultr discovery.** Both presets read the provider's authenticated `/v1/models` catalog,
preserve native ids, and cap discovery at 256 KiB and 256 raw rows. Nscale's catalog mixes chat,
image, and embedding models without a modality field, so the preset admits only
`meta-llama/Llama-3.1-8B-Instruct`, the model used by Nscale's official tool-calling API example.
Vultr currently documents tool calling only for `kimi-k2-instruct`, so its preset exposes only that
model. Other rows remain hidden until the provider publishes equivalent agent-tool evidence. Create
an Nscale service token in the [Nscale Console](https://console.nscale.com); copy Vultr's inference
key from the subscription overview in the [Vultr Console](https://my.vultr.com).

**Command Code discovery.** The preset reads Command Code's `/provider/v1/models` list from
the fixed Provider API host, preserves provider-native ids, and caps discovery at 256 KiB and 256 raw
rows. `ocx login command-code` supports OAuth via browser sign-in (with optional local CLI credential
import from `~/.commandcode/auth.json` for existing Command Code CLI users); the model catalog is
account-scoped and comes from the authenticated discovery endpoint after login. The Provider-API
preset (`commandcode`) sends the active configured key: most model ids use Chat Completions with a
Bearer header, while `claude-*` ids use Anthropic Messages with `x-api-key`, because Command Code
serves them only on `/provider/v1/messages`. A provider that reuses the `commandcode` name for a
different endpoint keeps its own wire. The OAuth preset (`command-code`) uses the stored account bearer for
authenticated discovery and streams generation from `/alpha/generate` as NDJSON. MiMo tool-call
markup echoed by the gateway as text is removed when it duplicates a real call. On MiMo models, a
complete declared-tool call with no native counterpart is restored only after a clean finish;
interrupted or filtered turns leave the markup as text. Create Provider-API keys at
[Command Code Studio](https://commandcode.ai/studio/).

**OrcaRouter authentication and discovery.** Choose either `ocx login orcarouter-oauth` for
one-click browser authorization or `ocx login orcarouter` to paste an existing API key. The PKCE
flow starts a loopback listener first, sends a fresh S256 challenge and state to
`https://www.orcarouter.ai/auth`, exchanges the single-use code at
`https://www.orcarouter.ai/api/v1/auth/keys`, and stores the returned user-owned key in
`~/.opencodex/auth.json`. The manual-key preset continues to use the normal provider key store.
Both modes route to `https://api.orcarouter.ai/v1` and discover the public live catalog with
`capability=chat`; non-chat media/rerank rows are excluded, and reported input modalities control
whether Codex offers image attachments. Because the catalog itself is public, manual key setup
reports validation as unknown instead of accepting that response as proof that the key works.

During OrcaRouter browser sign-in (`ocx login orcarouter-oauth`), a successful key-exchange
response body must be valid UTF-8 JSON no larger than 64 KiB. The request's existing 30-second
budget covers both the response headers and the full body; oversized or malformed bodies are
rejected before the key is saved. These limits apply only to the login key exchange, not inference
request payloads. Scope validation is unchanged: an omitted `scope` is allowed, while an explicitly
invalid `scope` is rejected.

For a one-origin self-hosted deployment, set the shared origin before the first PKCE login; the saved
inference URL is derived from the same origin:

```bash
ORCAROUTER_BASE_URL=https://router.example ocx login orcarouter-oauth
```

For a split self-hosted deployment, set `ORCAROUTER_API_BASE_URL` and
`ORCAROUTER_AUTH_BASE_URL` separately.

The value must be an HTTPS origin (or HTTP loopback for local development) with no credentials,
query, or fragment. Before the first login to a loopback/private self-hosted endpoint, explicitly
allow that destination in your `~/.opencodex/config.json` provider row. For example, merge this
entry into the existing `providers` object for a local development server:

```json
{
  "orcarouter-oauth": {
    "adapter": "openai-chat",
    "baseUrl": "http://127.0.0.1:9999/v1",
    "authMode": "oauth",
    "allowPrivateNetwork": true
  }
}
```

Then run `ORCAROUTER_BASE_URL=http://127.0.0.1:9999 ocx login orcarouter-oauth`.
Login preserves this explicit consent; setting the URL alone never enables private-network access.
Without the opt-in, destination validation rejects inference and model discovery for that endpoint.
This requirement concerns the provider endpoint; the browser callback listener needs no such opt-in.
Re-run the login after a relay `401`; OrcaRouter keys are durable and do not have a refresh-token grant.

**Meta Model API (`meta-model`).** Muse Spark on Meta's own OpenAI-compatible endpoint,
served over `/v1/responses`. Create a key in
[the Meta developer console](https://dev.meta.ai/docs/authentication) — Meta calls this
variable `MODEL_API_KEY`, but opencodex derives the env var from the provider id, so
export it as **`META_MODEL_API_KEY`** (or paste it during `ocx init`). The account needs a
payment method before it will serve requests, and every call is metered per token. Two
models are seeded — `meta-model/muse-spark-1.3` and `meta-model/muse-spark-1.3-contributor`
— with the vendor's `minimal`/`low`/`medium`/`high`/`xhigh` ladder and a 1M context window.
Discovery stays off until an authenticated roster is verified, because Meta serves image and
voice models on the same host.

Two things worth knowing before you pick it. **A Muse Code subscription does not apply
here:** Meta scopes that credential to the Muse Code CLI and bills any other key
pay-as-you-go. And the Contributor tier is cheap because Meta trains on your prompts —
roughly 92% off input, 96% off output, and 99% off cached input — so keep confidential
material off it. Muse Spark is also reachable through resellers, with a narrower roster:
`command-code` carries both tiers, while `opencode-go` serves only
`muse-spark-1.3-contributor`.

**Meta Muse Code (`meta-muse`).** A plain macOS login first tries the API key already
stored by `muse login`. With no local credential, or on another platform, it starts the
browser device-approval flow. Add-account and reauthentication skip local import to avoid
reusing the account being replaced. OpenCodex never launches the Muse CLI. If device login
fails without cancellation, an available manual-input surface can accept a pasted key;
that key faces the same format and Model API validation as an imported key. See
[Platform support](/reference/platform-support/) for the full per-platform picture.

Starting any Meta Muse login through the management API requires a dashboard session,
including add-account and reauthentication. A raw admin token or forged GUI headers receive
`403 oauth_consent_required` before a credential is read or a grant starts. This gate uses
the server-resolved session principal, not a separately recorded warning-checkbox receipt.
Direct `ocx login meta-muse` and other OAuth providers keep their existing login policies.

Both seeded `meta-muse` models expose `minimal`/`low`/`medium`/`high`/`xhigh`/`max` to
routed clients, including Grok's effort picker. Requests use
`User-Agent: muse-build/1.3.0 (opencodex compatibility)` so Meta accepts the Muse Code
effort contract. An explicit provider User-Agent overrides this default and may cause
`max` to be rejected. The `meta-model` and OpenCode Go effort ladders remain unchanged.

**Read this before enabling it.** Meta scopes that credential to the Muse Code CLI, so
using it here is an *unsupported* path. Meta does not authorize subscription coverage
outside its own client, how these calls settle is not observable from the API, and you
should treat every call as billable against your account. The key, imported or pasted, is copied into
OpenCodex's auth store (`~/.opencodex/auth.json`, mode 0600) like every other OAuth
credential. The dashboard shows a Terms-of-Service warning before the first login and
before any reauthentication — the same treatment Anthropic and Google Antigravity get.

Meta reports subscription window usage inside streaming responses, and OpenCodex reads it
from there. The account row shows the last observed 5-hour and weekly windows with how old
that reading is — Meta publishes no endpoint to query them on demand, so a value is only
refreshed by another streaming turn through this provider, and a turn that goes through
request translation rather than passthrough reports none. An account that has not yet
served a streaming turn simply shows no quota, which is not an error. Rate limits apply
per team, not per key.

For a supported setup, use `meta-model` above with your own key.

**Command Code quota.** The dashboard and `ocx account refresh` probe Command Code's
`/alpha/billing/credits` windows (5-hour and weekly) on the canonical
`https://api.commandcode.ai` host. The OAuth preset (`command-code`) uses the stored
account bearer; the Provider-API key preset (`commandcode`) uses the active configured
key. A user-edited lookalike base URL is never probed. Remaining monthly, purchased, and
free credits are shown as a USD window when Command Code also reports period spend.

**SambaNova Cloud discovery.** The preset reads SambaNova Cloud's public `/v1/models` list from the fixed API
host, preserves provider-native ids, and caps discovery at 128 KiB and 128 raw rows. Because the
catalog is unauthenticated, the CLI login flow reports the key as unverifiable instead of treating
the public response as proof. Chat requests still use the configured Bearer key and disable parallel
function calls, which SambaNova does not yet support. Private SambaStudio deployment endpoints are
out of scope. Create keys in
[SambaNova Cloud](https://cloud.sambanova.ai/apis).

**Nebius Token Factory discovery.** The preset requests the authenticated verbose model catalog and
keeps only rows whose architecture produces text, excluding embedding and image-generation models.
It preserves slash-containing native ids plus reported context and input-modality metadata, and caps
discovery at 512 KiB and 512 raw rows. Dedicated deployment hosts are out of scope. Create keys in
[Nebius Token Factory](https://tokenfactory.nebius.com).

**Crusoe discovery.** The key-based preset uses the `openai-chat` adapter and sends its Bearer key
only to Crusoe's fixed Serverless Inference host. `/v1/models` rejects unauthenticated requests with
401, so a successful list response counts as key validation. Discovery preserves slash-delimited
native ids such as `zai-org/GLM-5.3` and `moonshotai/Kimi-K2.6` exactly as Crusoe returns them and is
capped at 256 KiB and 256 raw rows. Rows are kept only when they report `is_public: true` and a text or multimodal `architecture.modality`, which excludes account-private deployments and any embedding or media rows. Reasoning models return their thinking in the Chat Completions
`reasoning` field, which the adapter reads. Only `openai/gpt-oss-120b` accepts a `reasoning_effort`
ladder (`low`, `medium`, `high`); the other reasoning models treat the field as an on/off toggle, so
the preset declares no provider-wide effort ladder and no provider-wide parallel tool calls. Rate
limits apply per project and per model (429 when exceeded, 503 while a shared deployment scales), and
new accounts start with $5 of free credits. Create a key in the
[Crusoe Cloud console](https://console.crusoecloud.com) under Intelligence Foundry, Inference.

**DigitalOcean discovery.** The preset uses a model access key against the fixed shared Serverless
Inference host and intersects the authenticated `/v1/models` response with DigitalOcean's
docs-backed Chat Completions allowlist. Unknown, Responses-only, embedding, and media-generation
ids fail closed. Discovery is capped at 256 KiB and 256 raw rows; agent-specific and dedicated
hosts are out of scope. Create a key in the [DigitalOcean Control Panel](https://cloud.digitalocean.com/model-studio/manage-keys).

**Scaleway discovery.** The preset intersects the authenticated model list with Scaleway's
documented Serverless Chat Completions allowlist. Unknown, Responses-only, embedding,
transcription, and other media-model ids fail closed; discovery is capped at 128 KiB and 128 raw
rows. It uses the default Project's shared endpoint; project-qualified URLs and dedicated
deployments require a custom provider. Create an API key in the
[Scaleway console](https://console.scaleway.com/generative-api).

**Featherless discovery.** The preset authenticates against the fixed OpenAI-compatible host and
requests only the first 100 popular models filtered upstream to chat and the current plan. Registry
rules then fail closed unless each row independently reports plan availability, no Hugging Face
gate, and `features.tool_use: true`. Discovery is capped at 128 KiB and 100 raw rows, so the service's
tens-of-thousands-model catalog is never downloaded or cached in full. Because `/v1/models` is documented as callable with or without authentication, it cannot prove a supplied key is valid; chat requests still use the configured Bearer key. Featherless terms reserve
individual plans for interactive/prototyping use; arbitrary applications require a Scale plan.
Create a key in the [Featherless dashboard](https://featherless.ai/account/api-keys).

**Novita discovery.** The key-based preset uses the `openai-chat` adapter and sends its Bearer key
only to Novita's fixed OpenAI-compatible host. Its public model list is filtered to rows that report
both `model_type: chat` and the `chat/completions` endpoint, with discovery capped at 512 KiB and 256
raw rows. Model ids must be preserved exactly as Novita returns them, including slash-delimited ids,
and must not be normalized or rewritten before routing. Because the catalog is public, login reports
the key as unverifiable instead of treating a successful list response as proof. Model capabilities
vary, so the preset does not advertise provider-wide parallel tool calls or OpenAI `reasoning_effort`.
Create a key in [Novita's key manager](https://novita.ai/settings/key-management).

> **Baseten scope:** The preset covers Baseten's shared [Model APIs](https://docs.baseten.co/inference/model-apis/overview)
> only. Use a personal [API key](https://docs.baseten.co/organization/api-keys) for local use, or a team key
> with **Call Model APIs** access for shared/production use. Dedicated Truss `predict` endpoints use different
> hosts and schemas and are not routed by this preset.
> Live discovery for this preset is capped at a 1 MiB response and 256 raw model rows.

### Official CodeBuddy Code CLI (Global & CN)

OpenCodex provides official adapter support for Tencent Cloud's CodeBuddy Code CLI via the `codebuddy` (Global) and `codebuddy-cn` (China) presets.

```json
{
  "providers": {
    "codebuddy": {
      "adapter": "codebuddy",
      "baseUrl": "https://www.codebuddy.ai",
      "apiKey": "${CODEBUDDY_API_KEY}"
    },
    "codebuddy-cn": {
      "adapter": "codebuddy",
      "baseUrl": "https://www.codebuddy.cn",
      "apiKey": "${CODEBUDDY_CN_API_KEY}"
    }
  }
}
```

- **Prerequisites:** Install the official CodeBuddy CLI globally:
  ```bash
  npm install -g @tencent-ai/codebuddy-code
  ```
- **Authentication:** Obtain your official API key from the vendor console:
  - Global: [CodeBuddy Global API Keys](https://www.codebuddy.ai/profile/keys)
  - CN: [CodeBuddy CN API Keys](https://copilot.tencent.com/profile/keys)
- **Region Isolation:** `codebuddy` and `codebuddy-cn` use separate canonical endpoints (`https://www.codebuddy.ai` and `https://www.codebuddy.cn`) and isolated child environments (`CODEBUDDY_INTERNET_ENVIRONMENT=public` vs `internal`). Credentials are strictly region-scoped and never exchanged across environments. Overriding the canonical base URL fails closed.
- **Tool Ownership and the Tool Bridge:** The CLI is always spawned with `--tools ""` and `--strict-mcp-config`, so it has no built-in or user-configured tools of its own. When a request carries a Codex tool catalog, the provider arms a capture-only MCP bridge: the validated catalog and MCP config are written to a private temp dir, the CLI is launched with `--mcp-config` and an exact `--allowedTools` list, and the `system/init` frame must report exactly that bridge server as connected or the turn fails closed. The bridge advertises the Codex tools and captures proposed calls but never executes anything: a completed tool-call batch is returned as `function_call` items (names mapped back to the request's wire names, at most 16 calls per assistant message), the process tree is terminated at `message_stop`, and the external Codex client alone performs approval, sandboxing, and execution. Tool results come back as the next request's input, and the conversation continues. Requests without tools keep the plain text-and-reasoning shape. If the CLI writes an unquoted DSML `calls` control line followed by a `functions.*` invoke control line into text or reasoning, OpenCodex refuses the turn instead of forwarding the scaffold or interpreting it as an executable call. DSML discussed or quoted in prose, inline code, fenced code, or source examples remains ordinary answer text.
- **Entitlements and Billing:** The provider uses the same vendor-documented CodeBuddy account/CLI authentication surface. Availability and billing of free, promotional, trial, or subscription credits remain determined by the user's CodeBuddy account entitlement.
- **Tool Choice Enforcement:** When a request specifies `tool_choice: "required"` or selects a specific named tool, the bridge expects a tool call from the model. If the CLI completes the turn with plain text instead of capturing a tool call, OpenCodex fails closed with a 502 `tool_call_required` error rather than returning an invalid text completion.
- **Governance Status:** Whether routing this vendor automation surface behind a proxy for a third-party agent satisfies CodeBuddy's acceptable-use terms is an open question flagged for maintainer security review (see the governance note in the provider registry entry). Treat this provider as pending that review, and keep the tool bridge's ownership boundary in mind: the nested CLI advertises tools but never executes them, and approval, sandboxing, and execution remain with the external Codex client.

### Official Qoder CLI (Global & CN)

OpenCodex provides official adapter support for Qoder through the `qoder` (Global) and `qoder-cn` (China) presets. Both use a user-supplied Personal Access Token and the vendor's headless CLI; OpenCodex never reads Qoder Desktop sessions, browser cookies, refresh tokens, or private console APIs.

```json
{
  "providers": {
    "qoder": {
      "adapter": "qoder",
      "baseUrl": "https://qoder.com",
      "apiKey": "${QODER_PERSONAL_ACCESS_TOKEN}"
    },
    "qoder-cn": {
      "adapter": "qoder",
      "baseUrl": "https://qoder.cn",
      "apiKey": "${QODERCN_PERSONAL_ACCESS_TOKEN}"
    }
  }
}
```

- **Prerequisites:** Install the official CLI for the region you use:
  ```bash
  npm install -g @qoder-ai/qodercli        # Global: qoder / qodercli
  npm install -g @qodercn-ai/qoderclicn    # CN: qodercn / qoderclicn
  ```
- **Authentication:** Create a PAT in the account integrations page
  ([Global](https://qoder.com/account/integrations), [CN](https://qoder.cn/account/integrations)) and paste it as the provider's API key. The stored key reaches the CLI only as `QODER_PERSONAL_ACCESS_TOKEN` (Global) or `QODERCN_PERSONAL_ACCESS_TOKEN` (CN) in a scoped child environment.
- **Region Isolation:** Each preset accepts only its canonical destination (`https://qoder.com` or `https://qoder.cn`) and resolves its own executable. Credentials, model cache, usage, and health are independent; neither region falls back to the other. An older custom provider named `qoder` with a different destination keeps its existing adapter and URL.
- **Model Discovery:** `qoder --list-models` is the authoritative entitlement roster for the current PAT. The cache is bound to an irreversible fingerprint of the token, so switching accounts never reuses another account's roster. If discovery fails, the provider degrades to a stale cache and then the documented static seed.
- **Tool Ownership:** The CLI runs single-turn `stream-json` with `--tools ""`, `--strict-mcp-config`, setting sources disabled, and session persistence disabled, so Codex keeps exclusive tool ownership. v1 is text and reasoning only; image input fails explicitly.
- **Quota:** No public quota API is used, so totals and reset times are unavailable. Insufficient-credit errors (vendor code 118) surface as HTTP 429 `insufficient_quota`.
- **Operators:** Qoder Global is operated by BRIGHT ZENITH PRIVATE LIMITED under the [product service terms](https://qoder.com/product-service); Qoder CN by 通义云启（杭州）信息技术有限公司 with Alibaba Cloud. Verify `ocx provider test qoder` (or `qoder-cn`) after configuring.

### Claude Code CLI (subscription)

OpenCodex can spend a Claude subscription through Anthropic's own harness instead of replaying a
Claude Code identity against the Messages API. The `claude-cli` preset runs the official Claude Code
CLI headlessly (`claude -p`, `stream-json`) once per turn:

```json
{
  "providers": {
    "claude-cli": {
      "adapter": "claude-cli",
      "baseUrl": "https://api.anthropic.com"
    }
  }
}
```

- **Prerequisites:** `npm install -g @anthropic-ai/claude-code`, then sign in once with `claude`
  (or `claude setup-token`). The CLI uses the machine's own Claude Code sign-in (the macOS Keychain
  entry, or `~/.claude/.credentials.json` elsewhere).
- **No credential stored:** this row holds no API key, and OpenCodex never reads, copies or forwards
  a Claude token. The CLI owns the login and bills the account itself. A CLI that is not signed in
  fails the turn with a sign-in error naming the command, instead of a generic `401`.
  Classification follows the same fact: the preset is a keyless key row (`keyOptional`), so it needs
  no API key and no key field is offered for it. An API key saved on this row by other means is never
  handed to the harness — key billing belongs to the `anthropic-apikey` preset.
- **One sign-in serves the whole proxy:** the harness reads the Claude Code sign-in of the user
  OpenCodex runs as, so every request routed through this row — from any client of the proxy —
  spends that one Claude account. There is no per-client account, no pooling and no multiplexing;
  giving several people their own Claude usage needs one proxy user per sign-in.
- **Input media:** the row publishes its models as text-only for v1. The CLI accepts an image frame
  on its stream-json input, but no headless turn has been shown to hand those bytes to the model, so
  an image sent straight to this provider is refused (`unsupported_input_modality`, the same
  refusal the Qoder presets make) instead of being silently dropped and answered blind. With the
  vision sidecar on the request path, images are captioned into text before they reach the row.
- **Isolation:** every turn runs in a scoped child environment with no inherited `ANTHROPIC_*`
  variable (a `claude` already pointed at this proxy therefore cannot loop back into it), telemetry,
  feedback and the auto-updater disabled, and `--tools ""`, `--strict-mcp-config` plus
  `--setting-sources ""`. The harness loads no CLAUDE.md, skill, hook, plugin or MCP server from the
  machine and can neither read, write, exec nor browse. No session is persisted between turns.
- **System prompt:** the caller's system and developer prompts replace the Claude Code preset
  (`--system-prompt-file`), so the turn answers the client's contract rather than the harness
  persona. The folded prompt is staged in a private per-turn file (mode `0600`) and passed by path,
  because process arguments are world-readable through process listing; a request that carries
  neither a system nor a developer prompt gets an empty file, which replaces the preset with nothing.
- **Tool ownership:** v1 is text and reasoning only, exactly like the CodeBuddy and Qoder presets:
  with no tool channel, approval, sandboxing and execution stay with the client. The shared
  capture-only tool bridge is the documented follow-up.
- **Destination:** the canonical row names `https://api.anthropic.com` because that is where the
  subscription's traffic lands. OpenCodex never sends that request itself, and overriding the base
  URL fails closed rather than handing the turn to another environment.

> **Terms:** this preset spends your Claude subscription through Anthropic's own CLI. Whether
> driving that harness headlessly from a proxy fits your plan's terms is a question between you and
> Anthropic. OpenCodex does not convert the login into an API key and does not reproduce the CLI's
> HTTP identity.

### A6API credit quota

A custom `openai-chat` provider using `authMode: "key"` and the canonical
`https://api.a6api.com` or `https://api.a6api.com/v1` base URL receives an A6API credit meter in
the dashboard and from `ocx account refresh <provider>`. The provider name is arbitrary; detection
uses the canonical HTTPS endpoint. The meter converts A6API token units into USD using the account's
hard credit limit and displays the percentage consumed plus remaining credit. Token expiration is
not shown as a quota reset because expiration does not imply that credit replenishes.

```json
{
  "providers": {
    "my-a6": {
      "adapter": "openai-chat",
      "authMode": "key",
      "baseUrl": "https://api.a6api.com/v1",
      "apiKey": "${A6API_API_KEY}"
    }
  }
}
```

Quota probes send only the active key to the canonical A6API host and reject redirects. Malformed,
negative, or internally inconsistent billing totals produce no report rather than a misleading bar.

> **Tencent Cloud Coding Plan usage restriction:** Tencent documents this subscription for
> interactive coding tools only. General API automation, custom application backends, and
> non-interactive batch use are prohibited and may cause the plan key to be suspended.

> **GLM billing routes:** `zai` is the Z.AI international coding-plan subscription; `zhipu-bigmodel`
> is Zhipu's domestic BigModel pay-as-you-go endpoint. Different hosts, different keys, different
> billing — a key issued for one will not authenticate against the other.

### BigModel Coding Plan over Responses

Select **Zhipu AI — BigModel Coding Plan (Responses)** (`zhipu-bigmodel-responses`)
for the `openai-responses` endpoint `https://open.bigmodel.cn/api/v1`. This is separate
from `zhipu-bigmodel-coding`, which uses Chat Completions at `/api/coding/paas/v4`.

The preset uses a **static roster** (`liveModels: false`) taken from the published
[GLM Coding Plan documentation](https://docs.bigmodel.cn/cn/coding-plan/tool/codex.md):

| Model | Context tokens | Upstream selectable effort | Default effort | Reasoning summaries |
| --- | ---: | --- | --- | --- |
| `glm-5.3` | 1,048,576 | `low`, `high`, `max` | `max` | Supported |
| `glm-5.3-flash` | 1,048,576 | `low`, `high`, `max` | `max` | Supported |
| `glm-5-turbo` | 204,800 | None (empty list) | `max` | Supported |

`glm-5.3` and `glm-5-turbo` declare upstream text-only input. The Codex catalog
advertises text and image for them because opencodex's existing vision sidecar can
describe images for text-only models; that path requires an available, enabled vision
sidecar and does not claim native BigModel image support.

`glm-5.3-flash` is the exception: it declares native `text` and `image` input, because
upstream documents it as a natively multimodal model. It therefore reads pictures
directly instead of being routed through the describe-it-first sidecar detour.

The default model is `glm-5.3`; Responses reasoning content is preserved on replay.
The existing Codex export adds its compatibility
`ultra` tier to GLM-5.3 and omits Turbo's default-effort field because Turbo has no
selectable ladder; the provider metadata still records `max` for both models.
For Turbo, outgoing Responses requests omit `reasoning.effort`, including a caller's
`max` or `ultra`, while preserving requested reasoning summaries. This leaves effort
selection to the upstream default; opencodex does not inject a selectable or wire `max`.

The example's `models.json` is a local catalog file, not a documented HTTP model-list
response, and not the set of models the endpoint serves — the Coding Plan pages state
that every plan tier reaches GLM-5.3 and GLM-5.3-Flash, and that GLM-5-Turbo calls are
auto-switched to Flash, so this endpoint was already serving Flash under the Turbo id.
This preset still does not perform live model discovery. An existing custom provider
with the same name keeps its configured destination and metadata.
CLI key login also skips the undocumented `/models` probe and reports validation as
unknown; successful key authentication is established by a subsequent inference request.

### Multiple API keys

Key-based providers can also keep multiple keys. Adding a key through the Providers page stores it
under `provider.apiKeyPool`, makes it active, and mirrors it to `provider.apiKey` so routing and
adapters continue to read the same field as before. The same dropdown can switch or remove keys; the
management API is `/api/providers/keys` and returns masked keys only.

### Switching accounts from the terminal

Use `ocx account list`, `ocx account current`, and `ocx account use` to inspect or switch the same
Codex, OAuth, and API-key pools without opening the dashboard. See the
[CLI reference](/reference/cli/providers-accounts/#ocx-account-subcommand) for commands, JSON output, and
new-session behavior.

#### Subscription tier in account listings

`ocx account list <provider> --json` and `GET /api/oauth/accounts` report a `plan` field on every
OAuth account, using the same name and placement as the OpenAI/Codex provider so a consumer can
read one shape across providers.

The field is always present. It is `null` when the tier is unknown, which is deliberate: an
**absent** key means the proxy predates this field, while `null` means this version looked and the
provider did not report a tier. Collapsing the two would let a consumer quietly assume a tier.

For Anthropic the value is `null` today. Its usage endpoint returns quota buckets only — the
five-hour and seven-day windows, the model-scoped weekly windows, and a `limits` array — and no
subscription or tier field; the OAuth token response carries only the account id and email. There
is nothing to map, so nothing is mapped. The tier is also not derivable from the quota it does
return, because percentages are normalized per account: a Max ×5 seat at 50% is indistinguishable
from a Max ×20 seat at 50%. If you need weighted pool capacity across mixed Anthropic tiers, keep
that mapping outside OpenCodex until upstream reports the tier itself.

### GPT-5.6 preview paths

GPT-5.6 Sol/Terra/Luna are seeded in provider fallback lists so `ocx sync` can keep the models
visible even while live catalogs lag:

| Codex route | Seeded model ids | Codex-visible context |
| --- | --- | --- |
| Codex login (Pool or Direct) | `gpt-5.6-*` | 922,000 |
| OpenAI (API key) | `openai-apikey/gpt-5.6-*` plus `*-pro` | 922,000 (922,000 max input) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna` | 922,000 |
| Cursor | `cursor/gpt-5.6-sol`, `cursor/gpt-5.6-terra`, `cursor/gpt-5.6-luna` | 1,000,000 |

The native GPT-5.6 entries preserve the pinned upstream reasoning ladders (for example, Luna has
`max` but no `ultra`). Routed entries use their provider metadata and reasoning mappings. All four
paths remain upstream-gated; Cursor's live discovery additionally filters its static seed to models
the logged-in account can use.

:::note[Gateways & subscription proxies]
A provider is included when opencodex has a matching wire adapter, **not** based on whether it is an
"agent" product. The current adapter ids are `openai-chat`, `openai-responses`, `anthropic`, `google`
(AI Studio, Vertex, and Antigravity/Cloud Code Assist modes), `azure` / `azure-openai`, `kiro`, and
`cursor`. A proprietary API without one of these implementations, such as native Amazon Bedrock,
is not supported directly.

Provider configuration selects the adapter; upstream transport selection is separate. Eligible
Responses traffic can use WSS with [explicit proxy routing](/reference/proxy-formats/#json-and-sse-output).
Invalid or unsupported WebSocket proxy settings fall back to HTTP/SSE, which uses the
[server's configured outbound fetch](/reference/configuration/server/). A server SOCKS5 proxy from
`config.proxy` or an inherited SOCKS5 `ALL_PROXY` uses the built-in tunnel when `NO_PROXY` does
not exempt the target. Scheme-specific HTTP(S) proxy variables retain their separate native handling; non-SOCKS
`ALL_PROXY` is not a native HTTP fetch route.

**GitHub Copilot** is an OAuth provider (`ocx login github-copilot`) that exchanges a GitHub
device-flow login for a short-lived Copilot API token — not a pasted API key. **GitLab Duo** remains
a key/subscription-token gateway on its OpenAI-compatible endpoint. **Cloudflare AI
Gateway** needs your account + gateway ids filled into the URL.

Copilot fronts a mixed-wire catalog: the following models (`gpt-5.3-codex`, `gpt-5.4`,
`gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-astra`, `grok-4.5`, `grok-4.6`, `mai-code-1.1-flash`, `mai-code-1-flash-picker`) reject
`/chat/completions` for agent traffic, so opencodex routes those models over the
Responses API by built-in default while every other Copilot model stays on chat
completions. The precedence is: hard wire pin → your explicit
[`modelAdapters`](/reference/configuration/providers/) entry → registry default →
provider-wide adapter. To opt a model without a built-in default (for example
`gpt-5.4-nano`) into Responses, set `"modelAdapters": { "gpt-5.4-nano": "openai-responses" }`.

Cursor is tracked separately as an experimental adapter. `adapter: "cursor"` appears in `ocx init`
and the dashboard Add Provider picker as an experimental local config entry with Cursor's static
fallback model catalog metadata. When a Cursor access token is configured, opencodex uses Cursor's
live HTTP/2 transport. Set `upstreamHttpVersion: "http1.1"` when a proxy requires Cursor's HTTP/1.1
compatibility path; the setting covers both inference and live model discovery and is exposed at
**Providers → Cursor → Settings → Cursor transport**. Its bundled fallback seed includes `gpt-5.6-sol` / `terra` / `luna` (1M context),
regular/Fast rows for Grok 4.5, 4.6, and 4.7 (500K), and `kimi-k3` (262K); live discovery decides which
remain visible for the account. Grok 4.6 and 4.7 expose `low` / `medium` / `high` / `xhigh` in both forms,
while 4.5 stops at `high`. Grok 4.5 and 4.6 Fast requests send the matching base model with separate
`effort` and `fast=true` `requested_model` parameters; their flattened
`cursor-grok-{version}-{effort}-fast` ids are discovery and picker identities only. Grok 4.7 is listed
without the `cursor-` prefix and sends `grok-4.7-{effort}-fast` directly. Cursor serves Kimi K3 only as
effort-suffixed wire ids, so
`cursor/kimi-k3` exposes a `low` / `high` / `max` ladder and defaults to `max`, matching the
model's documented API default. Cursor server-driven native read/write/delete/ls/grep/shell/fetch execution
is disabled by default because it bypasses Codex's approval and sandbox path; set
`unsafeAllowNativeLocalExec: true` on the `providers.cursor` object in `~/.opencodex/config.json`
only for trusted local experiments (or via **Providers → Cursor → Edit JSON** in the dashboard).
See the [Configuration reference](/reference/configuration/providers/#cursor-provider-adapter-cursor)
for a full example. MCP, screen recording, and computer-use are available as executor hooks; without a
configured local executor, opencodex returns typed no-executor results instead of policy-blocking
the request. Cursor OAuth and live model discovery are enabled for this experimental adapter;
Cursor is still not shown in key-login lists.
:::

### Ollama Cloud

Ollama Cloud is a hosted (not local) Ollama. Configure it at `https://ollama.com/v1` with a key
from [ollama.com/settings/keys](https://ollama.com/settings/keys). opencodex reaches it over
Ollama's own REST API (`POST /api/chat`) rather than the OpenAI-compatible surface, and discovers
the live model roster from the provider, so new Ollama Cloud models appear without a config
change. opencodex classifies its cloud
lineup by vision capability so the [vision sidecar](/guides/sidecars/) only kicks in for
text-only models. Text-only models (e.g. `glm-5.2`, `deepseek-v4-flash`, `gpt-oss`, `qwen3-coder`,
`minimax-m2.x`, `nemotron-3-*`) are listed in `noVisionModels`; vision-native models (e.g.
`kimi-k2.6`, `minimax-m3`, `gemma4`, `qwen3.5`, `gemini-3-flash-preview`) are not. Matching is
tolerant of Ollama's `:size` tags, so `gpt-oss` covers `gpt-oss:120b` and `gpt-oss:20b`.

Ollama currently documents structured outputs as unsupported on Ollama Cloud. For canonical
`ollama-cloud`, opencodex therefore refuses structured-output requests (`text.format`) with a clear
error instead of silently returning unconstrained prose; local and custom `ollama-native`
endpoints keep Ollama's native `format` behavior.

## 4. Local providers

Point opencodex at a local OpenAI-compatible server — usually with a blank key:

| Provider | Base URL |
| --- | --- |
| Ollama (local) | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |

## Any OpenAI-compatible endpoint

If a provider speaks Chat Completions, the `openai-chat` adapter handles it — choose **Custom** in the
dashboard or `custom` in `ocx init` and enter the base URL. See the
[Configuration reference](/reference/configuration/) for every provider field
(`headers`, `noReasoningModels`, `noVisionModels`, `models`, …).

## Approval reviewer per provider

Codex asks a second model to review approval requests, and takes that reviewer from
`auto_review_model_override` on the catalog row of the current turn's model. The root
`auto_review_model` in `$CODEX_HOME/config.toml` applies one reviewer to every row. To give a
routed provider its own — usually cheaper — reviewer, set the selector on that provider row in
`~/.opencodex/config.json`:

```json
{
  "providers": {
    "blsc": {
      "autoReviewModel": "opencode-go/deepseek-v4-flash",
      "autoReviewModelOverrides": { "kimi-k3": "gpt-5.6-terra" }
    }
  }
}
```

`autoReviewModel` covers every routed row of the provider. `autoReviewModelOverrides` targets a
single upstream model id and wins over it. A value is either a bare model id of that same provider
or a public catalog slug such as `opencode-go/deepseek-v4-flash`, and a provider stamp wins over the
root selector on its own rows while the root selector stays the fallback elsewhere.

A bare value resolves against the provider's own rows first and then against a bare catalog row,
which is how a native model such as `gpt-5.6-terra` is named; a value that matches neither is left
unresolved, and a bare value that lands outside the provider prints a note naming the row that
supplies the reviewer. Giving the full slug avoids the question entirely when the reviewer is
another provider's routed model.

Selectors are resolved against the final catalog on the next sync, each one on its own, and each
fails closed by itself: an unresolved `autoReviewModel` prints a diagnostic and stamps no
provider-wide rows, an unresolved `autoReviewModelOverrides` entry prints a diagnostic and stamps
no per-model override, leaving a valid provider-wide target as fallback. Whatever resolves is still applied. Rows without a provider stamp
keep the root selector, or upstream behavior when that is unset. Removing the root selector leaves
provider stamps alone, and removing a provider selector clears only that provider's stamps.

These fields are available through configuration, `PATCH /api/providers?name=<provider>`, and
the dashboard raw JSON provider editor; dedicated form controls are not present. The canonical `openai` provider
rejects them. Field-by-field rules live in the
[provider configuration reference](/reference/configuration/providers/#auto-review-approval-model-selection).

## Rate limits in the providers overview

The **Rate limits** section of the Providers overview shows live utilization
bars refreshed from each provider's own usage/billing endpoint when one exists.
The bars show how much of a window (5-hour, weekly, monthly, or
provider-specific) is already consumed.

Providers with a live probe: OpenAI/Codex, Anthropic, xAI, Cursor, Kimi,
Google Antigravity, OpenCode Go, OpenRouter, DeepSeek, ClinePass, Z.AI, MiniMax,
Moonshot, Venice, Synthetic, DeepInfra, Neuralwatt, Command Code, and any a6api-backed
custom provider.

**OpenCode Go quota.** The canonical `opencode-go` preset reads
`GET https://opencode.ai/zen/go/v1/usage` with the configured key as a Bearer token and
does not follow redirects. The response's rolling, weekly, and monthly `percent` values are
already-consumed utilization: rolling maps to the 5-hour bar, while weekly and monthly keep
their matching bars. OpenCodex does not reconstruct dollar caps from local usage logs, and a
provider using a non-canonical `baseUrl` is never sent the key for this probe.

**Z.AI GLM Coding Plan quota.** The `zai`, `glm`, `glm-cn`, and `zhipu-bigmodel-coding`
presets read `GET /api/monitor/usage/quota/limit` and do not follow redirects. The probe
runs against the region the provider points at:
`api.z.ai` (bare or `/api/coding/paas/v4`) or `open.bigmodel.cn` (bare,
`/api/coding/paas/v4`, or the OpenAI Responses endpoint `/api/v1`).

Authentication differs by region: `api.z.ai` takes the key as a Bearer token, while
`open.bigmodel.cn` expects the key directly in `Authorization` with no scheme prefix and
rejects a Bearer header. The response's `limits` rows fill the utilization bars:
`TOKENS_LIMIT` / `CREDIT_LIMIT` rows with `unit` 3 / `number` 5 fill the 5-hour bar and
`unit` 6 / `number` 1 the weekly bar.

`TIME_LIMIT` rows are **not** model quota and are ignored. They are the shared monthly
MCP call allowance for Web Search, Web Reader, and Zread, so treating them as a model
window would let a spent web-search budget read as exhausted model capacity in
quota-aware account ranking. A plan that reports only `TIME_LIMIT` rows therefore shows
no quota bars rather than a fabricated one, and windows the plan does not report stay
absent instead of rendering as 0%.

A provider using a non-canonical `baseUrl` is never sent the key for this probe.
### Diagnosing an Antigravity quota refresh

The account quota view and `ocx account list google-antigravity --quota --refresh` distinguish access denial, rate limiting, blocked destinations or redirects, DNS/connection/timeouts, and unusable quota data. Last-known bars remain visible with their observation time when a refresh fails. Reauthentication retires diagnoses from the previous credential; a successful refresh clears the failure.

An access-denied result does not by itself prove an expired login or an ineligible plan. A blocked destination is a network-policy decision, not proof of a Fake-IP defect. Canonical Google quota destinations retain TLS verification and redirect/private-address restrictions. Authenticated TUN behavior must be checked in the affected environment; injected transport fixtures alone do not establish that field result.

## Large inline images on Chat providers

Translated OpenAI-compatible Chat requests shrink inline images when their combined base64 data exceeds 3.5 MiB. Older images lose detail first. This is a best-effort image budget, so large text, schemas, or images that cannot be processed may still exceed an upstream request limit. Remote image URLs are not downloaded, and images that cannot be shrunk remain attached. Native Chat passthrough keeps its original image bytes.
