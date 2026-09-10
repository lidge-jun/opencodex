# 001 — What the surfaces actually require

Findings from three parallel read-only investigations (subagents Carson, Gibbs,
Rawls), recorded here so each later phase starts from evidence rather than from
the transcript.

## The Accounts tab is fed by OAUTH_PROVIDERS, not by the preset catalog

`GET /api/oauth/providers` returns `listOAuthProviders()`, which is
`Object.keys(OAUTH_PROVIDERS)` minus `chatgpt`
(`src/server/management/oauth-account-routes.ts:137-140`,
`src/oauth/index.ts:335-371`). The GUI turns that list into the Accounts rows in
`gui/src/pages/providers-page-utils.ts:8-25`. A provider does **not** need to be
in `config.json` to appear. So membership in `OAUTH_PROVIDERS` is the whole
admission rule.

## What an OAuth entry must provide

`OAuthProviderDef` (`src/oauth/index.ts:184-196`) requires `login`, `refresh`,
`providerConfig`, `defaultModel`. `providerConfig` is not hand-written: `oauthConfig(id)`
calls `deriveOAuthProviderConfig`, which finds the registry row **only when
`authKind === "oauth"`** and throws otherwise (`src/providers/derive.ts:350-353`).
That is why the registry reclassification and the OAuth registration are one
atomic change, not two independent edits.

`OAuthCredentials` requires `access: string`, `refresh: string`, `expires: number`;
`normalizeCredential` drops the whole credential if any of the three is missing or
mistyped (`src/oauth/store.ts:447-502`).

## The durable-key precedent already exists

`devin` faces the same "no refresh endpoint" problem and solves it without
inventing one: it stores the durable key as both `access` and `refresh`, sets
`expires: Number.MAX_SAFE_INTEGER`, declares `defaultRefreshPolicy: "disabled"`,
and its `refresh` throws `invalid_grant` so a forced refresh marks the account
`needsReauth` instead of pretending success (`src/oauth/devin.ts:50-72, 155-166`,
`src/oauth/index.ts:310-315`). `orcarouter-oauth` does the same. An empty
`refresh: ""` is explicitly the wrong shape — it makes `detectOAuthWarning` report
`stale_credentials` from the moment of login.

This unit reuses that shape, with one difference that has to stay visible: for
`devin` the stored string is a real API key; for `devin-cli` it is a non-secret
presence marker, because there is no token for opencodex to hold.

## The fail-closed check that makes this a migration

`src/server/auth-cors.ts:731-737` rejects a saved provider row whose
`authMode === "local"` when its registry entry is not local:

> `provider ${name} cannot use authMode "local" — its registry entry requires ${entry.authKind} auth`

`derive.ts:217-231` seeds `authMode` from `authKind`, so every config saved while
`devin-cli` was local carries `authMode: "local"`. Flipping the registry to
`oauth` without a migration turns those configs into a startup rejection. This is
the single highest-risk item in the unit and `020` owns it.

## Everything else `"local"` currently controls for this provider

From `gui/src/provider-workspace/`: `catalog.ts:137-143` treats local as
configuration-ready; `catalog.ts:170-174` puts it in the Free tier;
`auth.ts:21-22` returns `null` so no auth surface is drawn; `kind.ts:12-21`
classifies it as kind `local` for the rail filter. Under `oauth` all four change
behaviour, which is the intent — an OAuth row gets an auth surface and a login
button — but `030` has to look at the rail, not only the modal.

From `src/providers/`: `fastwire.ts:109` returns `"none"` for local, so no
Authorization header is attached. This matters: the `devin-cli` adapter never
travels the fetch path at all (`buildRequest` is a placeholder), so the header
policy is inert for it either way. `quota.ts:2899` and `key-failover.ts` skip
local rows; under `oauth` they take the OAuth branches, which is correct because
there is now an account to reason about.

## What the Devin CLI itself stores

The CLI keeps its own credential on disk as `credentials.toml`. opencodex never
reads it; the adapter only spawns `devin acp` and the child authenticates itself
(`src/adapters/devin-cli/adapter.ts:1-8`). The CLI is **not installed** on this
machine, so the exact path and any non-interactive status subcommand are
unconfirmed. `010` therefore treats both the path and the status probe as
injected dependencies with a proven not-found branch, and `030` states plainly
that the live signed-in path is unproven here.

