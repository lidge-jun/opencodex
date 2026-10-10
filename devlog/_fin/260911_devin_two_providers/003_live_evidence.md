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

## The chat path works. What was actually wrong.

A paid account was obtained on 2026-09-12 and the entitlement hypothesis died
immediately: all 229 catalogue models came back enabled, and `GetChatMessage`
failed exactly as it had on the free account. The failure was never about the
plan.

Isolating it took one decisive move. The most actively maintained reference
(`dwgx/WindsurfAPI`) is zero-dependency ESM, so its request builder can simply be
imported. Building a turn with the reference builder and sending it through our
own transport returned **HTTP 200** and a real Connect stream — which proved the
transport, the headers and the credential were all fine, and put the fault in our
request encoder. Diffing the two encoded messages field by field left exactly one
difference: `CompletionConfiguration` (#8).

    reference  #1=1 #2=8192 #3=128000 #5=double #7=40 #8=double
    ours       #1=1 #2=64000 #3=32    #5=double #6=double #7=50 #8=double #11=double

**#2 is the output cap and #3 is the context window; we had them swapped.** A
caller asking for 32 output tokens wrote 32 into the context-window field, and
Cognition answered with an opaque `invalid_argument: an internal error occurred`.
That is why every account failed identically and why no amount of probing the
transport helped. The reference's own comments record the same mis-tagging and
the same re-calibration.

A second, independent trap sat behind it: **a temperature of exactly 0 is
refused** with the same opaque error. Deterministic output is the common case for
coding clients, so it is clamped to the smallest accepted value rather than
silently replaced with the service default.

Three transport facts also had to be right together, and testing them one at a
time is why they looked useless earlier:

- the credential is the session token doubled and dash-joined in
  `Authorization: Basic`, while the protobuf body keeps a single copy;
- the request envelope is uncompressed;
- `Metadata` #31 carries 732 hex characters, whose length the service checks and
  whose value it does not.

The metadata identity is also its own shape — seven fields, the optional
`user_jwt`, and the fingerprint — not the desktop client's fuller telemetry set.

### Verified

Six combinations, two hosts by three models, all returning `PONG` with a finish
reason and usage:

| host | model | result |
|---|---|---|
| `server.codeium.com` | `swe-2-high` | PONG, stop, 476/36 |
| `server.codeium.com` | `claude-sonnet-5-medium` | PONG, stop, 576/5 |
| `server.codeium.com` | `gpt-5-6-sol-medium` | PONG, 394/6 |
| `server.self-serve.windsurf.com` | `swe-2-high` | PONG, stop, 1/36 |
| `server.self-serve.windsurf.com` | `claude-sonnet-5-medium` | PONG, stop, 576/5 |
| `server.self-serve.windsurf.com` | `gpt-5-6-sol-medium` | PONG, 394/6 |

The tag map is now pinned by a regression test that builds a request and asserts
the field layout, so the swap cannot come back silently.

### What this retracts

The earlier conclusion in this document — that entitlement was the leading
explanation and that the request shape had been ruled out — was wrong. The
request shape was the whole problem; the probing that "ruled it out" changed one
variable at a time against a broken `CompletionConfiguration` that no single
variable could rescue.
