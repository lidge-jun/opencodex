---
title: Providers
description: Every way opencodex authenticates and talks to an LLM provider — OAuth, API key, ChatGPT forward, and local.
---

A **provider** is one upstream LLM endpoint plus how to reach it: an adapter, a base URL, an auth
mode, and an optional model list. Providers live under `providers` in `~/.opencodex/config.json`.

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

Eight provider presets use OAuth login — plus GitHub Copilot via an experimental unofficial
device-flow bridge. opencodex stores their credentials in
`~/.opencodex/auth.json` and refreshes them automatically. `chatgpt` is also accepted by the login
CLI; it acquires a ChatGPT credential while creating a `forward`-mode provider entry.

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx login nous         # Nous Portal (device grant; free + paid models)
ocx login kiro         # import kiro-cli credentials (or token fallback)
ocx login google-antigravity
ocx login cursor       # standalone Cursor PKCE login
ocx login command-code # Command Code browser OAuth (or import ~/.commandcode/auth.json)
ocx login github-copilot  # GitHub device flow → Copilot token (Copilot Pro/Business)
ocx login chatgpt      # standalone ChatGPT OAuth login
ocx logout <provider>
```

| Provider | Adapter | Base URL | Notes |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://cli-chat-proxy.grok.com/v1` | OAuth uses the separate Grok CLI subscription gateway. The API-key override uses `https://api.x.ai/v1` and may inject Priority Processing. Live-first Grok catalog; `grok-4.5` is the fallback default. |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude models; live model list fetched from `/v1/models`. |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi K2.7/K2.6/K2.5 coding models. |
| `nous` | `openai-chat` | `https://inference-api.nousresearch.com/v1` | Nous Research subscription gateway (same backend Hermes Agent uses). Device-grant login against `portal.nousresearch.com`; the access token is the per-request inference JWT. Mixed paid + `:free` model catalog (`tencent/hy3:free`, `stepfun/step-3.7-flash:free`, ...) discovered live from the signed-in account. Refresh tokens are single-use and rotated on every refresh. |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | Initial login imports the installed, signed-in `kiro-cli` session (on Unix, install with `curl -fsSL https://cli.kiro.dev/install` &#124; `bash`; on Windows PowerShell, use `irm 'https://cli.kiro.dev/install.ps1'` &#124; `iex`; then run `kiro-cli login`). **Add account** logs `kiro-cli` out, starts a fresh browser login that switches the account used by `kiro-cli`, and stores account-scoped profile metadata. Existing OpenCodex accounts are preserved, and cancellation or failure restores the previous `kiro-cli` session. |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | Google OAuth over the Cloud Code Assist wire. Live discovery uses CCA's authenticated `v1internal:fetchAvailableModels` endpoint and publishes the agent models available to the signed-in account; the maintained catalog remains the fallback. |
| `cursor` | `cursor` | `https://api2.cursor.sh` | Experimental PKCE login, live HTTP/2 transport with an opt-in HTTP/1.1 compatibility path, and account-filtered model discovery. |
| `github-copilot` | `openai-chat` | `https://api.githubcopilot.com` | Experimental. GitHub device flow + `copilot_internal` exchange (VS Code OAuth client). Requires an active Copilot subscription; not an official third-party API. |

After a terminal Nous refresh failure, run `ocx login nous` to reauthenticate.

For the canonical Kimi Coding Plan presets (`kimi` account login and `kimi-code` API key),
opencodex forwards only a caller-supplied stable `prompt_cache_key` to the Chat Completions request;
it never generates one. Kimi documents a stable session/task key as required to improve Code Plan
cache hit rates, while requests without a key remain keyless. If an opted-in upstream rejects the
field, opencodex does not strip it and retry or mutate saved configuration. Other providers remain
deny-by-default.

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
also preserve known independent quota groups: `gpt-5.3-codex-spark` does not prevent the same account
from trying the shared GPT-5.6 Terra/Luna quota, while models in that shared group still protect one
another. Explicit `Retry-After` and default cooldowns always remain account-wide.

**Session affinity.** Codex thread→account affinity is process-local (in-memory only; not persisted
across proxy restarts). On credential failures (`401` / `403`) the account is quarantined for
reauth and affinities for that account are cleared. On `429`, the account enters cooldown, affinities
are cleared, and pool selection may rotate — threads are not pinned through a rate-limit response.

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
`ocx login <provider>` (or use Reauthenticate in the dashboard). Codex pool accounts are not an
`ocx login` provider — reauthenticate via the dashboard Codex account pool. See
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

opencodex ships 79 built-in presets: 67 key-based, eight OAuth, three local, and one default
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
| SambaNova Cloud | `https://api.sambanova.ai/v1` |
| Nebius Token Factory | `https://api.tokenfactory.nebius.com/v1` |
| DigitalOcean Serverless Inference | `https://inference.do-ai.run/v1` |
| Scaleway Generative APIs | `https://api.scaleway.ai/v1` |
| Featherless AI | `https://api.featherless.ai/v1` |
| Novita AI | `https://api.novita.ai/openai/v1` |
| Together | `https://api.together.xyz/v1` |
| Fireworks | `https://api.fireworks.ai/inference/v1` |
| Moonshot (Kimi API) · Kimi (coding) | `https://api.moonshot.ai/v1` · `https://api.kimi.com/coding/v1` |
| Hugging Face | `https://router.huggingface.co/v1` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` |
| Z.AI (GLM Coding) | `https://api.z.ai/api/coding/paas/v4` |
| Zhipu AI (BigModel) | `https://open.bigmodel.cn/api/paas/v4` |
| Qwen Cloud | Token plan (default): `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` · Pay as you go: `https://dashscope.aliyuncs.com/compatible-mode/v1` · or Custom |
| Tencent Cloud Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/v3` |
| SiliconFlow | `https://api.siliconflow.cn/v1` |
| Volcengine Ark · Coding Plan · Agent Plan | `https://ark.cn-beijing.volces.com/api/v3` · `https://ark.cn-beijing.volces.com/api/coding/v3` · `https://ark.cn-beijing.volces.com/api/plan/v3` |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Xiaomi MiMo (OpenAI Chat) | `https://api.xiaomimimo.com/v1` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitLab Duo | `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic` |
| …and more | opencode zen, Vercel AI Gateway, Venice, NanoGPT, Synthetic, Qianfan, Alibaba, Parallel, ZenMux, LiteLLM |

**OpenCode Zen** (`opencode-zen`) and the keyless **OpenCode Free** preset share
`https://opencode.ai/zen/v1`. Free models on that gateway often hit a short-window burst
limit around 15–20 requests/minute (community-measured; OpenCode does not publish RPM).
Zen may return generic rate-limit 429 responses without `Retry-After` / `X-RateLimit-*`
headers. That is separate from the keyless desktop quota OpenCode advertises
(~200 Big Pickle/free-model requests per 5 hours on `opencode-free`). When Zen omits
`Retry-After` on such a 429, opencodex adds provider guidance to the client error and a
synthetic `Retry-After`; an upstream `Retry-After` still takes precedence. Same-key
wait-and-retry remains opt-in via [`retryOn429`](/reference/configuration/).

Most use the `openai-chat` adapter with a bearer key; a few that expose only an Anthropic-compatible
endpoint (e.g. **Xiaomi MiMo**) use the `anthropic` adapter (`x-api-key`).
Volcengine Agent Plan uses its native Responses endpoint through `openai-responses`.
The built-in DeepSeek preset also routes `deepseek-v4-flash` over its native Responses endpoint and
keeps upstream SSE streaming enabled. If that model finishes every output item but omits the final
Responses event, opencodex applies a five-second model-scoped grace repair; malformed or partial
streams close as incomplete rather than being reported as successful.

> **Three Volcengine billing routes:** `volcengine` is the pay-as-you-go Ark API,
> `volcengine-coding-plan` consumes Coding Plan quota, and `volcengine-agent-plan` consumes Agent
> Plan quota. Use the key and endpoint issued for the same product; the ordinary `/api/v3` endpoint
> can incur pay-as-you-go charges even when a Plan subscription exists.
> The presets use curated static model catalogs because Ark's `/models` response also includes
> embedding, image, video, and 3D resources, the Coding gateway returns that same broad catalog,
> and the Agent Plan gateway has no `/models` resource. Pay-as-you-go defaults to
> `doubao-seed-2-1-pro-260628`; its curated catalog also includes current DeepSeek and GLM text
> models. Coding Plan defaults to `ark-code-latest`, while Agent Plan defaults to
> `deepseek-v4-pro`.

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
preset (`commandcode`) uses the active configured Bearer key for chat requests; the OAuth preset
(`command-code`) uses the stored account bearer for authenticated discovery and chat. Create
Provider-API keys at [Command Code Studio](https://commandcode.ai/studio/).

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

> **Two GLM routes:** `zai` is the Z.AI international coding-plan subscription; `zhipu-bigmodel`
> is Zhipu's domestic BigModel pay-as-you-go endpoint. Different hosts, different keys, different
> billing — a key issued for one will not authenticate against the other.

### Multiple API keys

Key-based providers can also keep multiple keys. Adding a key through the Providers page stores it
under `provider.apiKeyPool`, makes it active, and mirrors it to `provider.apiKey` so routing and
adapters continue to read the same field as before. The same dropdown can switch or remove keys; the
management API is `/api/providers/keys` and returns masked keys only.

### Switching accounts from the terminal

Use `ocx account list`, `ocx account current`, and `ocx account use` to inspect or switch the same
Codex, OAuth, and API-key pools without opening the dashboard. See the
[CLI reference](/reference/cli/#ocx-account-subcommand) for commands, JSON output, and
new-session behavior.

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
**GitHub Copilot** is an OAuth provider (`ocx login github-copilot`) that exchanges a GitHub
device-flow login for a short-lived Copilot API token — not a pasted API key. **GitLab Duo** remains
a key/subscription-token gateway on its OpenAI-compatible endpoint. **Cloudflare AI
Gateway** needs your account + gateway ids filled into the URL.

Copilot fronts a mixed-wire catalog: its GPT-5 family (`gpt-5.3-codex`, `gpt-5.4`,
`gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`) rejects
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
regular/Fast rows for Grok 4.5 and 4.6 (500K), and `kimi-k3` (262K); live discovery decides which
remain visible for the account. Grok 4.6 exposes `low` / `medium` / `high` / `xhigh` in both forms,
while 4.5 stops at `high`. Fast requests send the matching base Grok model with separate `effort`
and `fast=true` `requested_model` parameters; flattened `cursor-grok-{version}-{effort}-fast` ids
are discovery and picker identities only. Cursor serves Kimi K3 only as effort-suffixed wire ids, so
`cursor/kimi-k3` exposes a `low` / `high` / `max` ladder and defaults to `max`, matching the
model's documented API default. Cursor server-driven native read/write/delete/ls/grep/shell/fetch execution
is disabled by default because it bypasses Codex's approval and sandbox path; set
`unsafeAllowNativeLocalExec: true` on the `providers.cursor` object in `~/.opencodex/config.json`
only for trusted local experiments (or via **Providers → Cursor → Edit JSON** in the dashboard).
See the [Configuration reference](/reference/configuration/#cursor-provider-adapter-cursor)
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
text-only models. Text-only models (e.g. `glm-5.2`, `deepseek-v4-pro`, `gpt-oss`, `qwen3-coder`,
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
