# Vendor claim ledger — Meta Model API and Muse Code

Every row is a statement Meta publishes, retrieved 2026-09-03 through a signed-in
browser (Aside CLI `1.26.902.1732`, account u0) because `dev.meta.ai/docs` returns
HTTP 500 to a plain fetch and its `.md` exports 500 as well. Rendered DOM was the
only readable surface.

Nothing here is inferred. A fact the vendor does not state is written `NOT STATED`
and does not reach the registry.

## A. Transport

| Claim | Value | Source |
|---|---|---|
| Base URL | `https://api.meta.ai/v1` | `/docs/quickstart`, `/docs/coding-agents` |
| Responses endpoint | `POST /v1/responses` | `/docs/protocols` |
| Chat endpoint | `POST /v1/chat/completions` | `/docs/protocols` |
| OpenAI compatibility | "It is OpenAI-compatible and exposes the full feature set" (Responses) | `/docs/protocols` |
| SDK base_url, verbatim | `base_url="https://api.meta.ai/v1"` / `baseURL: 'https://api.meta.ai/v1'` | `/docs/quickstart` |
| Auth header | `Authorization: Bearer $MODEL_API_KEY` | `/docs/api-reference`, `/docs/authentication` |
| Env var | `MODEL_API_KEY` (the CLI's own var is the different `META_API_KEY`) | `/docs/authentication`, `/docs/muse-code/auth` |
| Recommended surface | Responses is "the recommended default for new work" | `/docs/protocols` |

**Independent liveness check, no key issued.** `GET https://api.meta.ai/v1/models`
returned `401 {"error":{"code":"invalid_api_key","message":"Unauthorized",...}}`.
That is worth more than a docs quote: it proves the host exists, terminates TLS,
routes `/v1`, and answers in OpenAI error shape — while confirming we hold no
credential. This is the whole of our contact with the endpoint.

## B. Model facts

| Claim | `muse-spark-1.3` | `muse-spark-1.3-contributor` | Source |
|---|---|---|---|
| Model id, verbatim | `muse-spark-1.3` | `muse-spark-1.3-contributor` | `/docs/models` |
| Context window | 1,048,576 | 1,048,576 | `/docs/models` |
| Max output tokens | NOT STATED | NOT STATED | see below |
| Input modalities | text, image, video, audio\*, PDF | same | `/docs/models` |
| Output | text only | text only | `/docs/models` |
| Input price /1M | $1.25 | $0.10 | `/docs/pricing-rate-limits` |
| Cached input /1M | $0.15 | $0.002 | `/docs/pricing-rate-limits` |
| Output price /1M | $4.25 | $0.20 | `/docs/pricing-rate-limits` |

\* Audio on 1.3 is documented as "not fully supported" with degraded quality.

**Max output tokens is genuinely unpublished, and the number that looks like an
answer is a trap.** `131072` appears in the docs only inside a third-party
`opencode.json` sample; a docs search for the literal returns *No matching results*.
The protocol pages say `max_completion_tokens` is "Model-dependent" and that
exceeding the model's configured maximum returns HTTP 400. So the registry declares
no `defaultMaxOutputTokens` for these models rather than promoting a sample value
into a capability claim.

**Price cross-check.** These are the same numbers the Command Code models payload
carries for `meta/muse-spark-1.3` (1.25 / 4.25) and `meta/muse-spark-1.3-contributor`
(0.1 / 0.2), read independently on 2026-09-03. The reseller republishes Meta's list
price, which corroborates both readings.

## C. Reasoning effort

> Accepted values: "none", "minimal", "low", "medium", "high", "xhigh". When omitted,
> the model reasons by default. "none" (disable reasoning) is not supported by Muse
> Spark and returns HTTP 400. — `/docs/reasoning`

Two consequences for the registry, and the second is the one that bites:

- The usable ladder is `minimal, low, medium, high, xhigh`. `none` is published as an
  API-wide value and separately excluded for this model family, so advertising it
  would hand the user a picker entry that 400s.
- `max` and `ultra` are **not** in the vendor's set. Several opencodex ladders end in
  `max` and it would be easy to append one by family resemblance; here that would
  invent a wire value.

Independent corroboration from the sibling gateway: an unauthenticated Zen probe of
`muse-spark-1.3-contributor-free` on 2026-09-03 accepted `minimal|low|medium|high|xhigh`
and rejected `max` and `ultra` with `unknown variant`, and rejected `none` with
"does not support none with this model". Two independent surfaces, same ladder.

## D. Image input

| Surface | Content-part type | Source |
|---|---|---|
| Responses | `input_image`, `image_url` a plain string | `/docs/image-understanding` |
| Chat Completions | `image_url` wrapping `{ url }` | `/docs/image-understanding` |

Up to 50 images per request; more returns HTTP 400. Images only in user-role messages.

## E. Muse Code subscription — the licence boundary

| Tier | Price | Source |
|---|---|---|
| Everyday Usage | $5.00/mo | `/ai/products/muse-code/`, `/help/subscriptions/what-is-a-muse-code-subscription` |
| High Usage | $15.00/mo | same |
| Power Usage | $50.00/mo | same |

> The subscription applies to the Muse Code API key that is automatically connected in
> the Muse Code CLI onboarding process. **This credential is for use with Muse Code
> only.** Any additional API keys you create under your Meta Model API account will be
> billed through pay-as-you-go. — `/docs/muse-code/subscriptions`

> Your subscription **only works through the Muse Code CLI** while signed in with your
> Meta Model API account. — same page

## F. CLI

- Install: `curl -fsSL https://dev.meta.ai/install.sh | sh` — `/docs/muse-code/`
- The installer fetches a launcher from `https://api.meta.ai/muse-launcher.sh`
  (`MUSE_LAUNCHER_URL`), installs to `${MUSE_INSTALL_DIR:-~/.local/bin}/muse`, and
  verifies a sha256. Read directly from the retrieved script, HTTP 200, 9314 bytes.
- Auth precedence: `META_API_KEY` env, then a stored key, then a stored browser
  session. "An API key always takes priority over a browser sign-in." — `/docs/muse-code/auth`
- The **docs** describe no dedicated login command — first run prompts, `/login`
  re-opens, `muse auth set` stores a key, `muse logout` signs out. The installed CLI
  does ship `muse login`, which the docs omit; that gap and what it does (and does not)
  prove are recorded in `002`.

## G. Third-party OAuth

**NOT STATED — and searched for, not merely unseen.** The docs site search returns
*No matching results for "OAuth"*. Authentication states "Every request to Meta Model
API needs an API key". No device-code, PKCE, or authorization-code flow appears under
Authentication, API reference, SDKs, coding agents, or agent frameworks. The only
browser sign-in documented belongs to the Muse Code CLI and its wire protocol is not
published.

## H. Account and payment

Signup is email + confirmation with no card at account creation, but adding a payment
method is a listed prerequisite "to start making requests", alongside creating an API
key (`/help/accounts-and-login/sign-up`, `/docs/muse-code/auth`). Eligibility: 18+,
supported country, team-owner signup.

**No account was created, no key issued, no payment method entered.**

## Provenance caveat

`/docs/pricing-rate-limits` carries an unremoved internal editorial note asking someone
to "confirm these rate-limit numbers against the launch configuration before
publishing". That caveat attaches to the **rate-limit** figures (Standard 3,000 RPM /
4M TPM; Contributor 100 RPM / 3M TPM), which is exactly why no RPM/TPM value is wired
into the registry. The per-token prices are corroborated by the Command Code payload
and are not affected.
