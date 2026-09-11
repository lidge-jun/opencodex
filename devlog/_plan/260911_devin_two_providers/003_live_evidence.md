# 003 — wp2: live Cognition evidence

A free Cognition account was created through the browser on 2026-09-12 and the
shipped desktop client was downloaded. Everything below is measured, not inferred.

## What the account looks like

Devin Desktop 3.9.19 (`Devin-darwin-arm64-3.9.19.dmg`, 337 MB). Windsurf has been
rebranded: `windsurf.com` now redirects to `devin.ai/desktop`, and the bundled
extension still identifies itself as `publisher: codeium`, `name: windsurf`,
`displayName: Devin`. `product.json` reports `windsurfVersion: 3.9.19` and
`codeiumVersion: 1.48.2`.

## Constants confirmed against the shipped client

Read from `Devin.app/Contents/Resources/app/extensions/windsurf/dist/extension.js`:

- Auth0 client id `3GUryQ7ldAeKEuD2obYnppsnmj58eP5u` — present verbatim. The
  carried adapter's value is correct.
- Hosts: `server.codeium.com`, `server-staging.codeium.com`,
  `server-beta.codeium.com`, `register.windsurf.com`, `eu.windsurf.com/_route/api_server`,
  `windsurf.fedstart.com/_route/api_server`, and the tenant template
  `your-company.windsurf.com`. The allowlist in `src/oauth/devin/api-base.ts` was
  widened to the two staging/beta hosts on this evidence.
- Method names `RegisterUser`, `GetChatMessage` and `GetCascadeModelConfigs` all
  appear as string literals.

## What the live calls proved

1. **The sign-in token is not a JWT.** A real sign-in returned a 47-character
   `ott$<base64url>` one-time token, and RegisterUser exchanged it successfully.
   The JWT-shape gate added during wp1 would have rejected every real login, so
   `parseDevinAuthPaste` now checks for one opaque credential-shaped word instead
   of a token format. The token is single-use: the second exchange of the same
   value fails, which is why the probe needed a fresh sign-in.

2. **The tenant-routing fix is load-bearing, not theoretical.** RegisterUser
   returned `api_server_url: https://server.self-serve.windsurf.com` for an
   ordinary free account — not `server.codeium.com`, which the registry hardcodes
   and the carried adapter always used. Without wp1's change every free-tier
   account would have sent its RPCs to a host it is not provisioned on.

3. **The api_key and the catalog work.** `GetCascadeModelConfigs` against that
   host returned 227 model uids. Exactly one is enabled on the free tier:
   `swe-1-6-slow`. The site advertises "unlimited SWE-2"; the API does not agree,
   which is worth knowing before anyone documents a model list.

4. **`GetChatMessage` fails with `invalid_argument`.** Message is the opaque
   "an internal error occurred (trace ID: …)". Client version strings `3.9.19`,
   `2.0.0` and `1.48.2` in Metadata fields 2 and 7 all fail identically, so the
   version pin is not the cause — the comment in `metadata.ts` claiming a version
   mismatch produces exactly this error is no longer a sufficient explanation.
   The version default was still moved to the shipped `3.9.19` with an
   `OPENCODEX_DEVIN_CLIENT_VERSION` override, because `2.0.0` predates the rebrand
   and nothing argues for keeping it.

   This is the open item. The request encoding is being compared field by field
   against the shipped bundle and against the two actively maintained references.

## Ecosystem survey

Twelve independent Windsurf/Cognition proxies were catalogued. The two that
matter here:

- `dwgx/WindsurfAPI` (~2975 stars, updated this week) uses the same
  `server.codeium.com` `GetChatMessage` Connect-RPC path we do.
- `rsvedant/opencode-windsurf-auth` (~70 stars) is a direct-cloud Connect-RPC
  streaming client for an opencode plugin. Our carried files reference
  `opencode auth login`, `syncedViaOpencodeAuth` and an
  `opencode-windsurf-auth` CLI in `src/oauth/devin/types.ts`, so #4078 very
  likely derives from it. Its license and the derivation are being checked; if
  it is derived, attribution is required before this merges.

`quangdang46/openproxy` talks to a different product (gRPC-web
`LanguageServerService`), so it is a secondary reference only.

## wp2 outcome: the cloud chat path stays unverified

Every request-shape hypothesis was tried against the live account and none of
them changed the trailer. In probe order: client version `3.9.19`, `2.0.0`,
`1.48.2`; the Connect request frame sent uncompressed with
`Connect-Content-Encoding` dropped; `Metadata` #31 filled with 732 hex
characters; `GetChatMessageRequest` #2, #15 and #20 added and #22 dropped on the
first turn; `ChatMessagePrompt` #1 `message_id` added; `Authorization: Basic`
in both base64 and raw doubled-key forms; and both hosts. Same
`invalid_argument: an internal error occurred` every time, with a fresh trace id.

The model gate is provably fine. `swe-2-high` and `claude-sonnet-5-medium` are
refused locally as disabled, and a bogus uid is refused as unlisted, so the
failure is specific to `swe-1-6-slow` — the one model a free account has, and a
"slow" lane at that.

**Entitlement now outranks request shape as the explanation.** The site
advertises "Slow Devin Cloud access with limited quotas" for free accounts, and a
slow lane plausibly is not served by this RPC at all. #4078's author reported a
live PONG on 2026-09-09 with the *original* field set, which is the deciding
fact: shipping unverified wire changes would risk regressing an account that
works today in exchange for no measured gain here. The whole experimental delta
was reverted; only the wp1 hardening and the MIT notice remain.

Confirming this needs a paid account or a captured working request. Neither is
available in this session, so the cloud provider is not merge-ready and the
adapter's own model gate is what stops a user hitting this blindly.
