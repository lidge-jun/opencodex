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
