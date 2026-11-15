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

While a provider login is in progress, its Accounts panel offers **Cancel** once sign-in
instructions appear.

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

Business Premium seats reported as `self_serve_business_prolite` count as five Standard-seat units in this estimate. This display weight does not select accounts or create a five-hour window when the upstream reports only weekly usage. The calibration follows the [official Business usage limits](https://help.openai.com/en/articles/12003714-chatgpt-business-models-and-limits), checked 2026-10-20; unknown plans continue to count at the baseline with the unknown-plan count disclosed. An enabled Anthropic OAuth account pool with two or more accounts gets the same kind of estimate, every routable account weighted equally: inactive accounts use their last measured reading (no extra usage requests), paused, reauthenticating or stale accounts count as incomplete coverage, and with the pool off or one account the row shows the active account's own reading as before.

A **partial window coverage** warning means some included accounts reported one quota window but
not another. The overview keeps those windows separate and marks each affected window incomplete
instead of treating the missing reading as usage for that window.

This estimate is display-only. It does not change account selection, session affinity, automatic
switching, cooldowns, or any other routing decision. Use the [Codex Auth account pool](/guides/web-dashboard/#codex-auth-and-account-pools)
for the individual account state and routing controls.

Shipped v1 configs migrate automatically to marker 2 and one option-aware row. The original config is retained once at `~/.opencodex/config.json.pre-openai-tiers-v2.bak`; restore it with `cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json`.

[Claude OAuth client-version errors](/guides/claude-code/#claude-oauth-client-version-errors)

## Claude Opus 5.5 progress updates

When the `anthropic` adapter sends Claude Opus 5.5 to `api.anthropic.com` (OAuth or API key),
OpenCodex defaults to Anthropic's [progress-update display mode](https://platform.claude.com/docs/en/build-with-claude/thinking#progress-updates).
Progress updates and mid-turn acknowledgements appear as visible assistant commentary in Codex,
even when thinking summaries are hidden. Reasoning summaries are omitted in this mode because
Anthropic cannot distinguish progress updates from reasoning under `display: "summarized"`.
The original signed thinking blocks are preserved for tool continuation; no signature is decoded
or rewritten. Updates appear once their signed block completes. Other models and compatible
third-party endpoints retain their existing thinking display behavior.

To request summarized thinking instead, explicitly send `reasoning.summary: "concise"` or
`"detailed"`. OpenCodex then sends `thinking: {type: "adaptive", display: "summarized"}` without
the updates beta and returns thinking text as reasoning instead of progress commentary. In this
mode, Anthropic's progress updates may be folded into the reasoning summary. The choice also
works when reasoning effort is omitted or `"none"`; it does not change the requested effort.
Omitting `reasoning.summary` or sending `"auto"` (the Codex default) or `"none"` keeps the updates default. Local summary hiding
still controls reasoning visibility and does not hide progress commentary in updates mode.

## Anthropic image input

The built-in Claude model seeds advertise text and image input for both `anthropic` (OAuth) and
`anthropic-apikey`, consistent with [Anthropic's model overview](https://platform.claude.com/docs/en/models/overview).
Explicit per-model input-modality overrides remain authoritative; unknown models are not assumed
image-capable. This applies across integrations wherever the client's configuration supports image
capability metadata: OpenClaw exports a declared `input` array, and Kimi Code exports
`capabilities: ["image_in"]` only for image-capable models, adding `"thinking"` when the model
declares an effort ladder. Kimi Code also receives that ladder as `support_efforts` (limited to
`low`, `medium`, `high`, `xhigh` and `max`, in that order) and the declared default as
`default_effort` when it is in the ladder. OpenClaw omits `input` when no supported modalities are
declared; Kimi omits `capabilities` for models that declare neither image input nor an effort ladder. Clients without
a supported capability field keep their existing configuration shape. After updating opencodex,
regenerate or refresh the client configuration managed by opencodex to receive the updated metadata.

## Replayed Anthropic thinking signatures

On the Responses endpoint, an Anthropic-compatible upstream can reject a replayed thinking
signature because it belongs to a different conversation prefix. When the error explicitly
identifies this signature-binding problem, opencodex can remove replayed signed/redacted thinking
and retry once within the request's send budget. This covers HTTP 400 refusals and initial stream
errors before output or tool activity. Hosted web search and image/video bridges share one recovery
limit across their model iterations: only the rejected inference is resent, while completed sidecar
calls and tool results are retained. An empty-completion retry shares its request's allowance;
ordinary continuations after output cannot use it. A failed replacement is
returned without another signature retry. Other errors keep their existing handling.

Sidecar recovery is disabled when enforced spend accounting cannot establish receipts for earlier
ordinary sidecar sends. It never increases a caller or Combo send allowance.

Only a successful, nonempty completion remembers the rejection for that conversation and serving
identity for five minutes. Only the refused opaque payloads are suppressed when they can be
identified; newly issued thinking remains replayable. Plaintext history remains available; a failed or cancelled retry does
not disable thinking replay on later requests.

## xAI Responses includes

For xAI Responses requests, OpenCodex removes the unsupported `output.encrypted_content` entry
from `include`, including on the [US regional endpoint](https://docs.x.ai/developers/advanced-api-usage/regions).
Other include entries are preserved; an empty result omits the field. Other providers are unaffected.

## Auth modes

Provider configs accept three `authMode` values (`key` is the default). The built-in registry also
labels local presets separately; those normally omit both `authMode` and `apiKey`.

| `authMode` | How it authenticates | Used by |
| --- | --- | --- |
| `key` | Sends your API key (`Authorization: Bearer …`, or `x-api-key` / `api-key` per adapter). The key may be a literal or an `${ENV_VAR}` reference. | Most providers. |
| `forward` | Relays **your incoming Codex auth headers** verbatim to the provider — no key stored. This is the ChatGPT-login passthrough. | OpenAI (`openai-responses` adapter). |
| `oauth` | Resolves a stored OAuth access token (auto-refreshed before expiry) and uses it as the bearer key. | xAI, Anthropic, Kimi, Kiro, Google Antigravity, Cursor, Zed Hosted AI, Command Code, GitHub Copilot, Nous Portal. |

The [`retryOn429`](/reference/configuration/) same-key 429 replay applies only to API-key
providers (`authMode: "key"`). OAuth, forward, and local presets are excluded — their
credentials must never be replayed on the same token, and local runtimes have no remote key to
preserve. It is opt-in except for documented destination-specific defaults. Canonical Mistral
Chat uses a patient retry policy (6 replays, 10-second fallback interval), within the
existing request-wide send allowance. Explicit `retryOn429` settings, including
`enabled: false`, take precedence. The Mistral preset also forwards supplied prompt-cache
keys by default; `promptCacheKey: false` disables forwarding. Cache affinity improves the
chance of reuse, but does not guarantee a cache hit or remove token-throughput limits.

Mistral uses one API-key provider for both Studio and Vibe keys. Key types and plan allowances are
described in [Mistral's API-key documentation](https://docs.mistral.ai/admin/identity-access/api-keys),
and the proxy does not infer a subscription tier from the key. At `https://api.mistral.ai/v1`, the
dashboard reads API and Vibe budgets from `/v1/billing/budget` and the plan from
`/v1/billing/subscription`, using the inference credential and egress. Measured windows show usage,
total and recognized plan name. Budgets are
display-only: they do not rank keys, route or pause traffic, or enter the quota pool. Missing,
malformed or non-positive budgets, malformed currencies, out-of-range percentages and unknown plan
names are unknown or omitted. Fresh last-good readings survive 402, 408, 429, 5xx and transport
failures, but 401, 403 and other non-retryable client refusals suppress them.

For every model, explicit upstream `Retry-After` deadlines are shared between calls on the same
credential and model; [the `retryOn429` reference](/reference/configuration/providers/) covers the
recovery wait after a 429 without one, its single probe, and the `requestPacing` and
`respectRetryAfter` opt-outs. Context windows and per-model compaction preferences remain
independent.

The provider header also lists passively observed request and token limits for OpenAI, Anthropic,
xAI, Groq and Mistral, per observed key and model; [the dashboard guide](/guides/web-dashboard/)
covers those display-only readings, which never probe the OS keychain or affect routing.

Mistral accepts a different set of `reasoning_effort` values for each model and refuses the
rest with HTTP 400 (or 422 for `ultra`). The preset ships the accepted rungs as registry
`modelReasoningEfforts` rows. Client exports such as `ocx export --client opencode` offer only
these variants. The Codex catalog still adds its synthetic `ultra` rung, plus `max` where a
model's list omits it, and requests clamp those to the highest listed rung:

| Model | Efforts |
|---|---|
| `zai-glm-5-3`, `zai-glm-5-3-flash` | `low`, `high`, `max` |
| `mistral-large-4`, `mistral-large-4-0` | `low`, `medium`, `high` |
| `deepseek-v4-1-flash-1017` | `low`, `high`, `xhigh`, `max` |

The GLM and Large 4 rows follow [Mistral's reasoning guide](https://docs.mistral.ai/capabilities/reasoning).
Mistral documents no values for DeepSeek V4.1 Flash 1017, so its row is the set measured to
answer HTTP 200 in November 2026 and may change. A `modelReasoningEfforts` entry of your own
for a model replaces its row.

On native Chat Completions, for a model with reasoning enabled, a caller's `ultra` is sent as `max`, or as the model's highest
declared rung below `max` (`high` on Large 4). This applies to every `openai-chat` provider
unless the model's declared ladder lists `ultra` itself. A `reasoningEffortMap` alias for `max`
applies to the folded value, and `__omit__` drops the effort field. On models with independent
thinking and effort controls, the effort still selects the thinking switch; legacy thinking-toggle
wires keep their existing discriminator mapping. Models with reasoning disabled (for
example `noReasoningModels`) drop `reasoning_effort` entirely. Other caller values are forwarded
as sent unless an effort pin or a qualifying effort cap rewrites them; rewritten values also go
through the provider's wire mapping.

When round-robin key selection is enabled, queued requests recheck key cooldowns before sending and acquire pacing capacity for any replacement key. This applies to native Chat, Messages, Responses and compact. Waiting for replacement-key capacity does not consume the upstream response-header timeout. Per-key pacing and round-robin use guarded HTTP/SSE even when upstream WebSockets are enabled; WebSocket-only steering and injection require a route without those key policies. This does not change the saved active key. An established upstream turn keeps its credential; later sends are refused if that key cools. Pre-output key rejection can recover to a healthy key within the existing request limit. Direct Images and compact requests record genuine 401/429 cooldowns without replaying that paid POST.

### Anthropic API-key credit exhaustion

Anthropic API-key pools with at least two keys automatically try a sibling key when a complete HTTP `400` or `402` error states that the credit balance is too low to access the Anthropic API. This applies to `invalid_request_error`, `billing_error`, and `permission_error` before any text or tool output. Key rotation and pool strategies skip the failed key for one hour, because an empty balance only clears when credits are added; when every key is out of credit, requests still use the active key and return Anthropic's original error; choosing the key as active in the dashboard, or restarting the proxy, clears that hold after a top-up. Replacement sends share the request's send limit. Ordinary `400` errors stay terminal, and this does not enable same-key retries or change OAuth account routing. A header override that sends a different credential cannot cool or rotate the selected pool key.

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

When the Grok subscription catalog publishes selectable context windows, opencodex uses the
widest published rung: `[256000, 500000]` exposes 500k for Grok 4.5–4.7, including the 4.7 Fast
lane. Your configured model window and enabled Context cap still lower that value. If your plan
serves a shorter window, configure that limit; the catalog does not verify account entitlement.

Cursor, Kiro, Zed Hosted AI and Nous Portal are login-only and have no API-key equivalent. Google Antigravity is
login-only too: `ocx login google-antigravity` signs in with your Google account over the Cloud Code
Assist wire, and the `google` preset beside it is the AI Studio Gemini API — a different product
reached with its own key, not a key mode for the same login.
If Antigravity login cannot discover a Cloud Code Assist project, the failure includes a sanitized
summary for `loadCodeAssist` and the last `onboardUser` response: HTTP status, response category,
completion/error presence and known project-field types. It distinguishes HTTP refusal, unusable
JSON, invalid roots, unfinished onboarding and completion with an error or without a project.
The summary omits upstream values, arbitrary key names and account/project identifiers. Login
still requires a discovered project and saves no account when discovery fails.

The Antigravity Accounts tab shows an observed membership tier as a badge beside the account
label, using the upstream tier ID (for example `free-tier` or `gemini-pro`). No badge appears
when the plan is unknown; it does not affect routing or quota.

Gemini 4 Argon (`gemini-4-argon`) is listed on the `google` preset with low, medium (the
default), and high thinking levels. Google offers it on the paid Gemini API tier only, not the free
tier. On `google-antigravity`, Argon is listed with the same three levels, which map to the
`gemini-4-argon-low`, `-medium`, and `-high` wire models. Google limits it there to AI Ultra and
eligible Enterprise accounts. Cloud Code Assist serves Argon only to the Antigravity CLI client, so
OpenCodex sends every Gemini 4 model request and model discovery with the CLI User-Agent
(`antigravity/cli/1.3.4`) and keeps the IDE User-Agent for every other model. Gemini 4 Hydrogen (low, medium, high by default, and xhigh) appears on `google-antigravity` only when your account's model list includes it, each level mapping to its `gemini-4-hydrogen-*` wire model; requesting `max` or `ultra` also selects xhigh.

Vertex AI model discovery, its credential rules and how Gemini 4 Argon, Carbon and Hydrogen
receive tool images are described in [Google Vertex AI](/guides/google-vertex/).

For Gemini on Antigravity, including Argon, provider-marked thought summaries stay separate
from the answer: Responses uses reasoning summary items, Chat Completions uses
`reasoning_content`, and Messages uses `thinking` blocks. Clients decide how to display those
fields. A Responses client can request `reasoning.summary: "none"` to suppress summaries;
this does not turn off the model's internal reasoning. A thought signature is continuation
metadata and can accompany ordinary text, so its presence alone does not hide that text.
OpenCodex preserves unmarked answer text even when its wording sounds like planning or analysis.

Gemini models, Argon in particular, sometimes skip thinking on a tool-calling turn and write their
planning into the visible progress text, for example a progress line followed by "Let's read
google.ts next." Once that text is sent back as history, the model tends to repeat the pattern
on every later turn. To stop it from spreading, OpenCodex sends Gemini only the first sentence of
the text that came before a tool call in earlier turns. Final answers are sent back in full, and
what your client displays is not changed.

The built-in `google-antigravity` model list is Gemini 3.8 Flash (`gemini-3.8-flash`), Gemini 4 Argon
(`gemini-4-argon`), Claude Opus 5.5 (`claude-opus-5-5`), and Claude Sonnet 5.5
(`claude-sonnet-5-5`), each with low, medium, and high efforts. What you actually see is your
account's own model discovery, because Google enables models per account: some accounts list
Claude Sonnet 4.6 and Claude Opus 4.6 (Thinking), others only Claude Opus and Sonnet 5.5 (directly
billed, non-trial Pro or Ultra plans), and Gemini 4 Argon only on Ultra and Enterprise. Both Claude
generations map: 4.6 takes its effort as a thinking level, 5.5 as its `-low`, `-medium`, or
`-high` model.

Antigravity requests go only to accounts that may serve the requested model. OpenCodex remembers
each account's model list from that account's own discovery, in memory, for six hours. An account
whose list includes the model is preferred; an account with no current list (not yet discovered,
expired, or forgotten by a restart) is still used, because nothing proves it lacks the model. An
account whose current list omits the model is never sent the request, including on 429 and
authentication failover. If the selected account omits it and `oauthAccountFailover.enabled` is on,
the request moves to another account that is not paused or awaiting reauthentication. Otherwise
OpenCodex refuses the request locally with HTTP 403 `permission_denied` and sends nothing upstream:

- `The selected Google Antigravity account does not list the model "<model>" in its model discovery. Select an account that lists it, or enable oauthAccountFailover so OpenCodex can choose one.`
  Another usable account may serve the model, but failover is off.
- `The selected Google Antigravity account does not list the model "<model>" in its model discovery, and no account that may serve it could be used for this request. Retry the request.`
  Failover is on and chose another account, but that account could not be used for this request.
- `No usable Google Antigravity account lists the model "<model>" in its model discovery. Choose a model your accounts list, or add an account that has access to it.`
  Every usable account's current list omits the model.

A saved selection of a model that left the list follows the same rule.

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
ocx login zed          # Zed native-app callback login (experimental)
ocx login command-code # Command Code browser OAuth (or import ~/.commandcode/auth.json)
ocx login orcarouter-oauth # OrcaRouter browser consent + PKCE
ocx login devin       # Cognition/Devin: import Devin CLI credential, else Auth0 browser sign-in
ocx login dsh-account # DeepSeek Harness Desktop (import ~/.dsh/.credentials.yaml grant)
ocx login github-copilot  # GitHub device flow → Copilot token (Copilot account)
ocx login codex        # Codex account pool (aliases: chatgpt, openai; needs a running proxy)
ocx logout <provider>
```

| Provider | Adapter | Base URL | Notes |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://cli-chat-proxy.grok.com/v1` | OAuth uses the separate Grok CLI subscription gateway. The API-key override uses `https://api.x.ai/v1` and may inject Priority Processing. Live-first Grok catalog; `grok-4.5` is the fallback default. |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude models; live model list fetched from `/v1/models`. |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi Code Plan coding models. Defaults to the stable `kimi-for-coding` alias (currently K2.8 Preview): 1M-token context window, adjustable `low`/`high`/`max` thinking (default `max`), text + image input. `k3.1-pro` and `k3.1-pro-highspeed` (K3.1 Pro) are also listed: 1M-token context, thinking-only on the same ladder (default `max`). Retired `kimi-k2.x` selections are migrated to the alias on upgrade. |
| `kimi-responses` | `openai-responses` | `https://api.kimi.com/coding/v1` | Same Kimi account login (reuses the `kimi` OAuth credential) over the OpenAI Responses wire. Same model roster and capabilities as `kimi`; thinking content stays encrypted server-side, tool calls and results stay visible. |
| `nous` | `openai-chat` | `https://inference-api.nousresearch.com/v1` | Nous Research subscription gateway (same backend Hermes Agent uses). Device-grant login against `portal.nousresearch.com`; the access token is the per-request inference JWT. Mixed paid + `:free` model catalog (`tencent/hy3:free`, `stepfun/step-3.7-flash:free`, ...) discovered live from the signed-in account. Refresh tokens are single-use and rotated on every refresh. |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | The dashboard Login and Add account buttons offer AWS IAM Identity Center, Builder ID, Google, GitHub device login, or Kiro CLI. Native device login adds an account without signing `kiro-cli` out. The Kiro CLI choice imports or starts a CLI session; its Add account workflow temporarily switches the CLI account and restores it on cancellation or failure. |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | Google OAuth over the Cloud Code Assist wire. Live discovery uses CCA's authenticated `v1internal:fetchAvailableModels` endpoint and publishes the agent models available to the signed-in account; the maintained catalog remains the fallback. |
| `cursor` | `cursor` | `https://api2.cursor.sh` | Experimental PKCE login, live HTTP/2 transport with an opt-in HTTP/1.1 compatibility path, and account-filtered model discovery. |
| `zed` | `zed` | `https://cloud.zed.dev` | Experimental Zed Hosted AI bridge. Uses Zed's native-app RSA callback, exchanges the account token for a short-lived hosted-inference token, and discovers the account's live roster. |
| `orcarouter-oauth` | `openai-chat` | `https://api.orcarouter.ai/v1` | Browser consent and key exchange use `https://www.orcarouter.ai` with S256 PKCE. The returned user-owned `sk-orca-…` API key is stored in the existing credential store and reused until revoked. |
| `devin` | `devin` | `https://server.codeium.com` | Experimental unofficial Cognition/Devin bridge. Login first imports the credential the installed Devin CLI already holds (`devin auth login` writes a `devin-session-token` to its own `credentials.toml`); when none is present it opens Auth0 browser sign-in and exchanges the pasted token via Cognition's `RegisterUser` for a long-lived API key. `ocx login devin-cli` remains as a deprecated alias. Models are discovered per account with `GetCascadeModelConfigs`. Account quota comes from `GetUserStatus` under one eight-second request and body deadline: dated daily and weekly windows, plus the monthly prompt and flex credit pool for a credit-billed plan or an unknown strategy with both reset dates absent when a balance field is present. Negative used credits omit the monthly window; valid zero available credits mark it exhausted. A timed-out probe keeps the last good quota. Not shown in the dashboard preset by default. Chat and usage reporting are verified against a live account across three models. |
| `dsh-account` | `dsh-account` | `https://api.deepseek.com/anthropic` | Experimental import-first account provider reusing an installed and signed-in DeepSeek Harness (DSH) Desktop account. Reads credentials strictly read-only from `~/.dsh/.credentials.yaml` upon explicit import. Independent from DeepSeek API key billing. |
| `github-copilot` | `openai-chat` | `https://api.githubcopilot.com` | Experimental. GitHub device flow + `copilot_internal` exchange (VS Code OAuth client). Requires an active Copilot subscription; not an official third-party API. |

Google Antigravity groups a model's complete `low` / `medium` / `high` variants into one entry with an effort selector. This includes Claude Opus and Sonnet 5.5 and future versions discovered during automatic refresh. Partial sets remain separate. Existing enabled/disabled choices carry into the grouped entry; genuinely new models still follow your New model policy. Saved suffix IDs continue to request their original tier. Grouped effort routing survives a proxy restart when model discovery is temporarily unavailable. A running Codex session may need to reload its model list after catalog refresh. Usage groups known Claude Sonnet and Opus 5.5 tier IDs under their base model, including historical tier records. Their displayed costs are derived Anthropic reference estimates, not Antigravity subscription charges.

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

### Zed Hosted AI (experimental)

:::caution[Unofficial — use at your own risk]
Zed does not provide or endorse this bridge. It reuses your Zed account's hosted-model
entitlement outside the Zed editor, which may be outside Zed's terms of service. Zed may rate
limit, restrict, or suspend the account. Review Zed's current terms before you sign in; the
provider stays off until you add it and run `ocx login zed` yourself, and the dashboard asks
you to acknowledge this risk before it starts the login.
:::

Run `ocx login zed` and complete Zed's native-app sign-in in the browser. OpenCodex starts a
loopback callback, gives Zed an RSA public key, and keeps the matching private key local while
the callback returns the account identity and encrypted access token. The stored account id and
token are paired on every request; OpenCodex exchanges that credential for Zed's short-lived LLM
token before calling `https://cloud.zed.dev/completions`.

Zed's live model roster is account-scoped display metadata. The selected model id is forwarded as
provided, and the bridge infers the hosted backend family from the live row or the model name;
model discovery is not an allowlist. The Zed access token has no refresh endpoint, so when Zed
revokes it, run `ocx login zed` again.

For Zed-hosted OpenAI models, OpenCodex translates `developer` instructions to `system` messages and removes OpenAI-private fields and unsupported built-in tools such as `web_search`. Function and custom tools remain available through the delegate; a tool choice with no supported tools left becomes `none`.

Current-turn tool declarations carried in Codex's `additional_tools` input are promoted into the
supported tool catalog. Function calls and custom-tool input are relayed in order, including
interleaved calls, so a tool-using turn can continue after its introductory text. Incomplete calls
keep only received arguments and remain incomplete; cancellation releases buffered data. Conflicting
completed custom input, including later deltas, fails the turn with incomplete calls. Function arguments accept JSON whitespace differences outside strings, decoded string escapes, and compatible partial snapshots while preserving delivered bytes. Number literals must match exactly (`1` and `1.0` conflict); object-key order and duplicate members must match too. These conservative conflicts fail the turn. JSON nesting is limited to 65,536 containers; deeper input fails with a clear depth-limit message. Late fragments are validated incrementally. On upstream failure, received text and
reasoning remain visible and usage retains numeric counters only. The relay is covered by synthetic stream fixtures; live hosted-stream compatibility remains unverified.

For the canonical Kimi Coding Plan presets (`kimi` account login and `kimi-code` API key),
opencodex forwards only a caller-supplied stable `prompt_cache_key` to the Chat Completions request
(the Responses wire accepts the same field, but opencodex does not send it there today);
it never generates one. Kimi documents a stable session/task key as required to improve Code Plan
cache hit rates, while requests without a key remain keyless. If an opted-in upstream rejects the
field, opencodex does not strip it and retry or mutate saved configuration. Other providers remain
deny-by-default.

Kimi Code's native Responses route omits explicit content-empty assistant history messages
to avoid its `assistant must not be empty` rejection. Nonempty text, whitespace, refusals,
reasoning and tool calls/results are retained; stored client history is not rewritten.
An empty message referenced by an `item_reference` in the same input is retained rather than leaving a dangling reference.

Kimi Coding usage prices for `k3`, `k3[1m]`, `k3-256k`, `k3.1-pro`, and `k3.1-pro-highspeed` are
**API-reference estimates** across `kimi`, `kimi-code`, and `kimi-responses`, using the published
default 5-minute cache-write rate (the `moonshot` API preset prices the same models as `kimi-k3`,
`kimi-k3.1-pro`, and `kimi-k3.1-pro-highspeed`). They do not reproduce Code Plan billing or quota:
K3's 1M variant consumes about twice the quota of `k3-256k`, and K3.1 Pro Highspeed about twice
that of `k3.1-pro`. `kimi-for-coding` now points to K2.8 Preview, so its former K2.7 price is no longer
used; its estimate remains unavailable unless the operator supplies `modelCosts`. Unknown-price
routing policies and cost caps that exclude unknown estimates can therefore exclude this alias.
See [Kimi's model configuration](https://www.kimi.com/code/docs/en/kimi-code/models.html) and
[API pricing](https://platform.kimi.ai/docs/pricing/chat).

The `moonshot` (Kimi API) preset lists `kimi-k3.1-pro` and `kimi-k3.1-pro-highspeed` next to
`kimi-k3` and the K2 ids. Both have a 1M-token context window and text + image input, and always
think: the picker offers `low` / `high` / `max` (default `max`), Codex `medium` is sent as `high`
and `xhigh` as `max`, and an explicit `none` leaves `reasoning_effort` out so the upstream default
applies. Fixed sampling parameters (`temperature`, `top_p`, penalties) are not sent. A saved
`moonshot` model list that is still the previous built-in list gains both ids at startup when it
points at the International or China endpoint; this roster refresh adds no models to an edited
list or a Custom URL. The retired-id migration below applies separately.
The preset defaults to the vendor-recommended `kimi-k3.1-pro`. `kimi-k2.5`, discontinued on
2026-08-31, is removed from the API seeds; saved selections on the official International or China
endpoint migrate to `kimi-k3.1-pro`, refreshing old built-in context and reasoning metadata while
preserving explicit overrides. Custom destinations keep their saved selections. `kimi-k2.6` and
`kimi-k2.7-code` (including highspeed) remain selectable for existing users: Moonshot closes the
K2 series to new accounts on 2026-10-31 and plans to retire it by the end of December 2026; see the
[Kimi API model list](https://platform.kimi.ai/docs/models.md) (checked 2026-10-28).

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
provider issues one, and the current instructions. Browser callback flows also show a field to
paste the redirect URL or authorization code back. During device approval that field is hidden:
enter the displayed code on the provider's verification page instead. If the provider switches
to manual input, the dashboard replaces the old code and instructions on its next status poll.

If the proxy tries to open a browser and cannot, the login says so above the URL and keeps
going: open the sign-in page from the link or copy it. A device login never opens a browser by
itself; **Copy code & open** copies the code and opens the verification page in one click, and
the dashboard keeps waiting for as long as the provider's code stays valid. In the desktop app
these links open in your default browser.

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
- **A browser callback flow on a different machine** also needs the paste fallback, because the redirect URI is
  still `http://127.0.0.1:<port>/callback` on the proxy's host. Finish the login there, then paste
  the redirect URL (or just the code) back into the dashboard or `ocx account code`.

Device-code providers never open a browser from the proxy in either case: they show a code and a
verification URL to open wherever you are signed in.

### Headless Claude login (code-display mode)

For Anthropic there is a cleaner path than pasting a dead redirect: the **code-display** login.
Anthropic redirects to its own page and shows a `code#state` string instead of calling back to the
proxy, so nothing needs to reach `127.0.0.1` on the proxy's host.

```bash
ocx login anthropic --headless
```

Over the management API, start with `POST /api/oauth/login` and `{"provider":"anthropic","mode":"code"}`;
the response carries a `flowId` and an `expiresAt` (10 minutes). Submit the pasted string to
`POST /api/oauth/login/code` with that `flowId`. The answer is the result of the token exchange —
`{"ok":true,"account":…}` or `{"ok":false,"error":…}` — so a hosted caller with a single paste box
knows whether the login actually worked. A paste with the wrong state, or with no code in it, is
refused before any token request and leaves the flow open for another try; a paste that reaches the
token exchange uses the flow up, so start a new login if that exchange fails.

Only `anthropic` and `anthropic2` support this mode; other providers answer `code_mode_unsupported`. Several code
logins can be in flight at once, each pinned to its `flowId`, but they all write the same account
store: the most recent successful one becomes the active Claude account. This is meant for one
operator on a headless host, not for isolating unrelated users on a shared instance.

### Multiple OAuth accounts

OAuth providers whose credentials include a stable account id or email can keep more than one
login. The Providers page shows those accounts in a dropdown, lets you add another, and switches the
active account without logging the others out. A normal login with an identity-less Kimi credential
replaces the active slot, while an explicit **Add account** preserves that slot and activates a new,
distinct one. Kiro accounts use the profile ARN together with the signed-in user's email when available; different users can keep separate credentials for one organization profile. `chatgpt` is always single-slot because Codex
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

Each record may carry an optional `project_id` for an account whose Cloud Code Assist project is not discovered automatically. It must be a Google Cloud project id (6–30 lowercase letters, digits or hyphens). OpenCodex uses it only when discovery finds no project, and only after a quota check with that account's own token succeeds for it; otherwise the record fails with `missing_project` and nothing is saved. A discovered project always takes precedence.

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

For the native main Codex credential in `CODEX_HOME/auth.json`, cancelling a request stops a
waiting refresh before the token exchange starts. An exchange already started finishes within
its own 30-second timeout and saves successful access and refresh tokens before reporting the
request's cancellation. This preserves the rotated refresh token for later requests; a concurrent
external credential replacement still takes precedence.

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

### Kiro request credits

On tool-enabled turns, opencodex holds Kiro's ordinary text until completion is validated.
If Kiro ends with plain text instead of its private final-answer tool, one bounded retry
still runs, and only the resulting final answer is displayed. Progress accompanying a real
tool call remains visible. A normal private final answer needs no completion retry.

When Kiro's safety filter stops a turn (`CONTENT_FILTERED`, for example the Claude `BIO` classifier), the request ends as a refusal that clients do not retry: Claude clients see `stop_reason: "refusal"` and Codex sees a failed response carrying Kiro's category and explanation. If the filter stops the bounded retry, no final answer is displayed; the progress held from the first attempt and any partial text from the retry are shown as commentary before the refusal.

When Kiro emits credit metering, request logs preserve the reported spend as
`usage.providerCredits`, including in the persisted usage ledger. These are Kiro credits;
token counts may still be estimated, and the credit value does not replace USD cost estimates.
Completion fallback requests add their reported credits. An absent value means Kiro did not
report credit usage; an explicit zero means it reported no spend.

### Kiro refresh attention

If an AWS SSO refresh returns `400 invalid_request` and matching Kiro CLI recovery does not
succeed, the dashboard shows the affected account as needing re-authentication once its access
token expires. The active provider then reports `loggedIn: false` from `/api/oauth/status`.
A still-valid access token remains logged in. You can sign in again through the dashboard;
a later successful automatic refresh also clears the attention state. This status does not
classify the refresh grant as revoked or disable future refresh attempts. Network and server
errors do not trigger this status.

For desktop-auth accounts, an HTTP 401 with exactly `Bad credentials` requires a new login
and immediately marks the rejected credential generation as needing re-authentication.
Other messages, statuses, and AWS SSO responses do not trigger this desktop-specific rule.

### Kiro credential import

The dashboard offers native AWS IAM Identity Center, Builder ID, Google, and GitHub device login without Kiro CLI.

For an organization account, choose **AWS IAM Identity Center**, enter your AWS access portal URL
(for example `https://example.awsapps.com/start`) and the region where your organization configured
IAM Identity Center. Open the verification link in your own browser, enter the displayed code,
and authorize the account. The hub completes the grant; no SSH session or browser callback to
the hub is required. If AWS lists several Kiro profiles, choose the profile to save. With one
profile the account is saved automatically. The SSO region and the selected profile's API region
are kept separately. Profile discovery checks AWS's US East and Frankfurt service regions.
The signed-in user's email is resolved from AWS for the selected profile before saving; users
sharing one organization profile keep separate account credentials. Cancellation or expiry before
the credential write saves no account. Native login adds a slot and keeps the existing selection.

The Kiro CLI choice and `ocx login kiro` import path use the CLI: on Unix, install it with `curl -fsSL https://cli.kiro.dev/install | bash`;
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

For the **Kiro CLI** choice, **Add account** is a separate write workflow: it snapshots the current session, logs `kiro-cli` out,
and imports the fresh browser login. If the login is cancelled or fails, including while OpenCodex
persists the credential, rollback replaces the Kiro CLI database and removes its current WAL, SHM,
and journal sidecars before publishing the previous session snapshot.

Because that rollback is only possible from a snapshot, the Kiro CLI **Add account** choice refuses to sign `kiro-cli`
out when a session store is present but cannot be captured (unreadable file, mismatched schema, or
an ambiguous token selection), when `KIROCLI_DB_PATH` / `KIRO_CLI_DB_FILE` redirect import reads away
from the live CLI store, or when an existing primary CLI database has no recognized token row.
Repair or remove the unreadable database under the normal `kiro-cli` data path, unset those import
selectors, then retry. Signing in from a machine with no existing `kiro-cli` session is unaffected.
The native dashboard choices are add-only and do not sign out `kiro-cli`. A device dialog shows the code and verification destination. Only recognized Kiro or regional AWS device-SSO hosts are opened as links, plus your organization's `<id>.awsapps.com/start` access portal on an IAM Identity Center sign-in; an unexpected destination is shown as copyable text for review. Closing the dialog sends cancellation and leaves a bounded background status check to reconcile a commit already in progress. A stalled status response is retried; exhausting the flow deadline produces the neutral ended outcome rather than claiming success. Google and GitHub approval completes when Kiro reports `authorized` (or the legacy `approved` status) with valid tokens and a profile ARN.
The account list marks Kiro accounts excluded from automatic selection with a reason, when available.

### DeepSeek API

The `deepseek` API-key provider includes `deepseek-flash`, its `deepseek-v4-flash` alias, and `deepseek-v4-pro`. DeepSeek [withdrew the Pro retirement plan](https://api-docs.deepseek.com/updates/) and continues serving it; opencodex retains Pro in the catalog with a 1,048,576-token context window, text-only input, and `low`/`high`/`max` reasoning effort. Responses requests use its native Responses endpoint; Chat Completions requests retain the Chat wire. Flash remains the default. Third-party providers have independent model availability.

On upgrade, startup adds Pro to a saved model list only when it exactly matches the previous built-in DeepSeek seed and still uses the official endpoint and adapter. Customized lists, including empty lists, remain unchanged; live discovery need not be enabled for this repair.

### DeepSeek Account (DSH)

`dsh-account` is an experimental, import-first account provider designed to reuse the authenticated account credentials of an installed DeepSeek Harness (DSH) Desktop application.

- **Independent from DeepSeek API Key:** `dsh-account` runs on the DeepSeek account signed in to DeepSeek Harness, whereas the `deepseek` provider bills against your platform API key balance. The two credential domains and routes are strictly separate and never fall through into one another.
- **Explicit import only:** opencodex reads `~/.dsh/.credentials.yaml` (or `$DSH_HOME/.credentials.yaml`) only when you run `ocx login dsh-account` or select **Log in** on the DeepSeek Account (DSH) row of the dashboard's **Add provider** picker. It never copies, imports, or uses the token on its own.
- **Read-only DSH credential store:** OpenCodeX treats `~/.dsh/.credentials.yaml` as strictly read-only. OpenCodeX never writes, modifies, removes, or alters the permissions of any files belonging to DeepSeek Harness.
- **Isolated credential copy & logout:** Upon import, OpenCodeX validates the token against DeepSeek's authoritative identity endpoint (`/auth-api/v0/users/current`) and saves its own copy to the OpenCodeX auth store. Logging out or removing the account in OpenCodeX only deletes the OpenCodeX local copy; it never triggers upstream remote session logout and will not sign you out of DeepSeek Harness Desktop.
- **No background token rotation & 401 re-import:** DSH session grants do not feature an automatic background refresh endpoint. If upstream returns HTTP 401 (`ACCOUNT_TOKEN_INVALID`), OpenCodeX marks the account `needsReauth` and halts routing. To restore access, the user must explicitly re-import via `ocx login dsh-account`.
- **Third-party disclaimer:** OpenCodeX makes no claim of official endorsement or authorization by DeepSeek for third-party clients reusing session grants.

## 3. API-key catalog

The built-in API-key presets, their base URLs, and the provider-specific notes that go with them
are on the [API-key catalog](/guides/api-key-catalog/) page. Its sections:

- [WorkBuddy AI subscription](/guides/api-key-catalog/#workbuddy-ai-subscription)
- [CodeBuddy CN subscription](/guides/api-key-catalog/#codebuddy-cn-subscription)
- [Official CodeBuddy Code CLI (Global & CN)](/guides/api-key-catalog/#official-codebuddy-code-cli-global--cn)
- [Official Qoder CLI (Global & CN)](/guides/api-key-catalog/#official-qoder-cli-global--cn)
- [Claude Code CLI (subscription)](/guides/api-key-catalog/#claude-code-cli-subscription)
- [A6API credit quota](/guides/api-key-catalog/#a6api-credit-quota)
- [BigModel Coding Plan over Responses](/guides/api-key-catalog/#bigmodel-coding-plan-over-responses)
- [Multiple API keys](/guides/api-key-catalog/#multiple-api-keys)
- [Switching accounts from the terminal](/guides/api-key-catalog/#switching-accounts-from-the-terminal)
  - [Subscription tier in account listings](/guides/api-key-catalog/#subscription-tier-in-account-listings)
- [GPT-5.6 preview paths](/guides/api-key-catalog/#gpt-56-preview-paths)
- [Ollama Cloud](/guides/api-key-catalog/#ollama-cloud)

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

For Claude models reached through the translated Chat adapter, opencodex flattens tool-schema root
`oneOf`, `anyOf`, and `allOf` into an object. This uses the actual upstream model id whose final
slash-separated segment starts with `claude-` (case-insensitive), not every model on the gateway.
Nested schemas retain their existing normalization. Root required fields are retained; `allOf`
branch required fields are merged, while `oneOf`/`anyOf` branch required fields are not promoted.
Local root-branch references are followed for at most 64 references across the schema; unresolved,
cyclic, external, over-budget references or referenced compositions leave the root composition intact
and may be rejected upstream. Inline nested compositions also stay intact when they contain unread
properties or references, or exceed 256 inspected entries per tool schema; constraint-only
nesting still flattens. Property schemas and literal values are not scanned by this guard. Nested
references are preserved. Flattening is lossy: branch constraints
disappear and later property definitions win, so tools must validate arguments. Existing Zen and
Azure schema compatibility rules remain in effect.

See [Verify a custom remote gateway](/guides/custom-gateway/) for the setup and validation checklist.

## Approval reviewer per provider

Codex asks a second model to review approval requests, and takes that reviewer from
`auto_review_model_override` on the catalog row of the current turn's model. The root
`auto_review_model` in `$CODEX_HOME/config.toml` is Codex's fallback. The dashboard's global
**Auto-review override** in Model settings applies one reviewer to all catalog rows that do not
have a provider-scoped reviewer. It stores `autoReviewOverride` in `~/.opencodex/config.json`; the
setting must be enabled and name a model. An enabled setting with no model stays unapplied and
leaves the Codex fallback in effect. A catalog refresh is a separate state: after a save it can
stay pending, and the Models page reports it so you can retry with `ocx sync`. From the CLI, read
the setting with `ocx models auto-review status` or
change it with `ocx models auto-review set <model|-> [--enabled <on|off>]`; use `-` to clear the
model. CLI output recommends `ocx sync` when a refresh can be retried. If a refresh fails, the
setting remains saved and the command exits 1. Resolve the failure before syncing. To give a routed
provider its own — usually cheaper — reviewer, set the selector on that provider row in
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

Provider fields are available through configuration, `PATCH /api/providers?name=<provider>`, and
the dashboard raw JSON provider editor; dedicated provider form controls are not present. The
global override is available in Model settings. The canonical `openai` provider rejects provider
reviewer fields. Field-by-field rules live in the
[provider configuration reference](/reference/configuration/providers/#auto-review-approval-model-selection).

## Rate limits in the providers overview

The **Rate limits** section of the Providers overview shows live utilization
bars refreshed from each provider's own usage/billing endpoint when one exists.
The bars show how much of a window (5-hour, weekly, monthly, or
provider-specific) is already consumed.

Providers with a live probe: OpenAI/Codex, Anthropic, xAI, Cursor, Kimi,
Google Antigravity, OpenCode Go, OpenRouter, DeepSeek, ClinePass, Z.AI, MiniMax,
Moonshot, Venice, Synthetic, DeepInfra, Neuralwatt, Command Code, and any a6api-backed
or Abliteration custom provider.

**Kimi Coding Plan quota.** Account login and API-key providers on the canonical
`https://api.kimi.com/coding/v1` endpoint read `/usages`. API-key providers on the regional
`https://api.kimi.ai/coding/v1` endpoint read `/usages` from that same origin; account login
stays on `api.kimi.com`. Plans that report
`usages.limit_month_total` (or `monthTotal`) show a monthly utilization bar, with
`limit_month_code` (or `monthCode`) as the fallback when total usage is unavailable.
The `used_ratio` / `usedRatio` fraction must be in `[0, 1]` before conversion to a consumed
percentage; invalid ratios are ignored. Empty or unusable `usages` containers do not hide
usable monthly data in another supported envelope. Any reported reset time is retained.
Existing 5-hour, weekly, and total subscription-credit
windows remain separate, and an absent monthly window is not shown as 0%.

**Abliteration credits.** A provider of any name whose `baseUrl` is
`https://api.abliteration.ai` or `https://api.abliteration.ai/v1` reads
`GET https://api.abliteration.ai/v1/credits` with its active key as a Bearer token and does not
follow redirects. `total_credits` minus `total_usage` is the remaining USD balance, shown as a
credits bar of consumed spend. An account with no credits shows no bar. A rejected key clears the
row; `503 credit_balance_unavailable`, 408, and 429 keep the last reading.

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
