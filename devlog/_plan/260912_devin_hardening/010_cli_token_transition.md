# wp2 — Devin CLI token transition hardening

Branch: codex/260912-devin-cli-token-transition (base dev)

## What the path does today

ocx login devin-cli reads credentials.toml from the CLI data dir, pulls windsurf_api_key and
api_server_url with two line regexes, validates the host, and stores an OAuth account whose
expiry is Number.MAX_SAFE_INTEGER and whose refresh throws invalid_grant. Inference then runs
through the cloud-direct Connect client, not through core's OAuth replay path.

## Defects to fix

1. The session token prefix is never normalized. Every Cognition RPC expects
   devin-session-token$<JWT>. A credential arriving without it (OPENCODEX_DEVIN_TEST_TOKEN, a
   pasted bare JWT, a provider apiKey typed by hand) is sent verbatim and returns an opaque
   permission_denied, which reads as a revoked account rather than a malformed credential.
   oh-my-pi normalizes at the metadata boundary (packages/catalog/src/wire/devin.ts). We do
   not. Fix: one normalizer applied where Metadata.apiKey is built, plus a unit test.

2. An empty APPDATA or XDG_DATA_HOME resolves to a cwd-relative path.
   src/oauth/devin-cli.ts uses env.APPDATA ?? join(homedir(), ...), and "" is a set value, so
   join("", "devin", "credentials.toml") yields devin/credentials.toml relative to whatever
   directory the proxy runs in. A file planted there imports as the operator's CLI session.
   Fix: treat an empty or whitespace-only value as unset.

3. The credential file is read whole with no bound and every I/O failure collapses to
   "not signed in". EACCES, EISDIR, and a missing file are indistinguishable, so the one error
   message the caller owns cannot name the actual recovery step. Fix: cap the read, and
   separate missing from unreadable without putting file bytes into any thrown value.

4. Logout clears the shared user-JWT and catalog cache only for provider "devin".
   src/server/management/oauth-account-routes.ts gates the clear on that exact id, so logging
   out of devin-cli leaves a cached api_key-bearing JWT in process memory for its whole TTL,
   and account deletion never clears it at all. devin and devin-cli share the same cache.
   Fix: cover both provider ids on both paths.

5. A Connect EOS trailer message is echoed verbatim into the client error and /api/logs.
   The HTTP-status paths deliberately refuse to echo bodies because a Connect error can quote
   the request that carries the key; the trailer path then does the opposite. redactSecretString
   recognises neither devin-session-token$... nor a bare JWT. Fix: add both patterns to the
   redactor so anything that does reach a log is masked.

## Non-goals

The app.devin.ai PKCE CLI OAuth flow. The import path is the intended substitute and a second
login protocol is its own unit. Also excluded: probing the key at import time, which changes
login latency and deserves its own decision.

## Verification

bun test tests/providers/devin-cli-login.test.ts tests/providers/devin-cli-authmode-migration.test.ts tests/providers/devin-hardening.test.ts
plus bun run privacy:scan.
