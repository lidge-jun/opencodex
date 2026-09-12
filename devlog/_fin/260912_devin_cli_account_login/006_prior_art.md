# 006 — Prior art: how everyone else uses this credential

Survey of public implementations, to check that `005`'s direction is the one the
ecosystem converged on rather than a local guess.

## There is no OpenAI-shaped Devin API to point at

No repo, and no Cognition page, exposes `POST /v1/chat/completions` that accepts a
`devin-session-token`. `api.devin.ai` is a different product: cloud Devin
**sessions** (`/v1/sessions`, `/v3/organizations/{org}/sessions`) authenticated
with `cog_` service keys, which creates an agent VM rather than returning a
completion.

Every client that wanted an OpenAI surface built the translator itself, in front
of Connect-RPC. That is exactly what opencodex already is, so the question
"can we use it as an API instead of ACP" resolves to "yes, over the transport the
`devin` adapter already owns."

## The convergent pattern

1. obtain a `devin-session-token$<JWT>` — by RegisterUser, by CLI OAuth, or by
   reading it from disk;
2. send it as Metadata `api_key` to `api_server_url`, default
   `https://server.codeium.com` — **not** `api.devin.ai`;
3. chat over `exa.api_server_pb.ApiServerService/GetChatMessage`;
4. list models over `GetCascadeModelConfigs` (or `GetCliModelConfigs`), optionally
   minting a `user_jwt` first.

Implementations reviewed at source level: `rsvedant/opencode-windsurf-auth` (the
70-star original opencodex's cloud-direct client is derived from, MIT notice in
`index.ts`), its live fork `sudokar/opencode-devin-bridge`, `ktappdev/pi-windsurf`,
`CaiJingLong/devin-gateway`, `leookun/devin-2api`, `dwgx/WindsurfAPI` (2978 stars,
its `DEVIN_CONNECT=1` path), and `can1357/oh-my-pi`'s first-class Devin provider.

Two divergences worth knowing, neither blocking:

- `CaiJingLong/devin-gateway` lists models with **`GetCliModelConfigs`** rather
  than `GetCascadeModelConfigs`. opencodex's existing catalog path works against
  this account (229 models, measured in `005`), so no change; recorded in case a
  future account type answers only the CLI variant.
- `oh-my-pi` calls **`AssignModel`** before chatting. opencodex does not and
  streams fine, so it is not required for this surface.

## Nobody else reads the CLI file for chat — and that is fine

The repos that parse `credentials.toml` are usage monitors:
`wakamex/devin-cli-usage` (`windsurf_api_key` + `api_server_url` →
`SeatManagementService/GetUserStatus`), `robinebers/openusage`, and
`SammySnake-d/fast-context-mcp`. The chat clients each mint or store their own
token instead.

So `011` is a new combination rather than a copied one: read the file the usage
tools read, then use it on the transport the chat clients use. Both halves are
independently attested, and `005` measured the join end to end. The reason nobody
published this combination is likely that the other projects are not already
holding a working cloud-direct client — opencodex is.

## Key names confirmed by independent sources

Cognition documents only that the CLI "stores your API token" in
`credentials.toml` and never names the keys. Three unrelated projects observe the
same two that matter:

| key | role |
|---|---|
| `windsurf_api_key` | the durable credential, `devin-session-token$<JWT>` |
| `api_server_url` | Cognition api-server; where GetChatMessage goes |

`devin_webapp_host` and `devin_api_url` are the webapp and the session-REST
product; `011` reads neither.

Token shapes in circulation: `devin-session-token$…` (current), `sk-ws-01-…`
(older Windsurf RegisterUser), `cog_…` (official Devin session API — different
product), `auth1_…` (web auth, not accepted as an api_key). `011`'s parser takes
the value verbatim and lets the server judge it, which is the right posture given
that spread.

## Licensing note

opencodex's `cloud-direct/` already carries the MIT attribution to
`rsvedant/opencode-windsurf-auth` in `index.ts`. `011` adds no new derived code —
it reads a local file and calls modules already in this tree — so no further
attribution is owed.

