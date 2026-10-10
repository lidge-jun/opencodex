# 010 — PR5: local account-switch capability

## Wire contract

- Headers: the existing `x-opencodex-local-expected-pid`, `-nonce`, `-expires-at`,
  `-capability`, plus `x-opencodex-account-switch-sha256` (base64url SHA-256 of the exact body).
- MAC payload (HMAC-SHA256 with the attestation secret, base64url):
  `opencodex-local-account-switch-v1\n{nonce}\n{method}\n{path}\n{pid}\n{port}\n{expiresAt}\n{bodyDigest}`
- method `PUT`; path one of the three constants; no query; body at most 1024 bytes, uncompressed;
  expiry at most 10 s ahead; single use (bounded replay cache, as snapshot); a request carrying an
  `Origin` header is never admitted (the grant is for the native host, not a browser).

## Diff

1. `src/lib/local-account-switch-capability.ts` — paths, header, digest, create/verify.
2. `src/server/local-account-switch-auth.ts` — `hasLocalAccountSwitchCapability(req, local)`
   (admission, replay, request-keyed digest cache) and `readVerifiedAccountSwitchBody(req)`.
3. `src/server/management-auth.ts` — admit as principal `local-account-switch-capability`.
4. `src/server/management-api.ts` — before dispatch: for that principal, 403 unless the target
   is one of the three routes; reject `content-encoding`; read at most 1 KiB, verify the digest
   against the original request, and continue with a reconstructed request carrying those bytes.
5. Tests in `tests/server/local-management-capability.test.ts` (or a sibling file if the ratchet
   requires): admission for each route and dispatch through `handleManagementAPI`; wrong method,
   path, query; tampered body and digest; replay; expiry; 1 KiB boundary; compressed body; read and
   snapshot proofs cannot authorize a switch and a switch proof cannot authorize a read, snapshot or
   another PUT. A fixed MAC vector shared with Rust.
6. Moved to 020 (PR6) during B: the Rust transport has no caller until the panel exists, and
   Linux clippy runs with `-D warnings`, so shipping it alone would fail as dead code. Contract
   kept here for reference: `desktop/src-tauri/src/proxy.rs` `AccountSwitchKind` → constant path,
   `mint_account_switch`, `put_account_switch(kind, body)`; tests for the MAC vector, body bytes,
   and path selection. Error mapping stays the existing one: invalid kind or serialization →
   `Http(400)`, body over 1 KiB → `Http(413)`, no usable binding or proof → `Unauthorized`,
   changed runtime → `Foreign`, connect failure → `Unreachable`, other transport or JSON failure →
   `Decode`, non-2xx reply → `Http(status)`.
7. Docs: `structure/gui-and-management-api.md`, `structure/desktop-shell.md`.
8. Ingress test through the real server path (`tests/server/server-management-auth.test.ts`, via
   `serve-options.ts`) proving an admitted switch reaches the handler, and a route-registry
   assertion (`tests/server/management-route-registry.test.ts`) that the three routes stay ordinary
   mutations without a new exemption.

## Accept

Focused bun tests, cargo test for proxy, typecheck, structure:check, privacy:scan; independent
security review subagent verdict recorded in the PR.
