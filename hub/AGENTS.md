# hub hosted control-plane instructions

This file applies to `hub/` and inherits `/AGENTS.md`.

## Trust boundary

- `hub` is an explicitly started public admission/accounting edge. It is not an
  OpenCodex provider adapter or router.
- Never import `hub/` from `src/`. Communicate with private OpenCodex only over
  its existing data-plane HTTP contract using a dedicated internal credential.
- Public routes are allowlisted. A fallback proxy must never forward `/api/*`,
  GUI bootstrap/session routes, debug routes, or an unknown path.
- Hosted mode fails closed on unsafe secrets, origins, targets, binds, database
  locks, or schema state. Development exceptions must be explicit and limited
  to loopback.

## Security invariants

- Use `Bun.password` Argon2id for passwords. Never log passwords or password
  hashes and never add a plaintext compatibility mode.
- Browser sessions are opaque, rotated, revocable, digest-only at rest, and
  transported only by `HttpOnly; SameSite` cookies. State changes require both
  same configured Origin and a session-bound CSRF token.
- API keys and recharge codes are CSPRNG values, revealed once, HMAC-digested
  with domain separation, and represented thereafter only by safe metadata.
- Credits are signed 64-bit integers in the smallest unit. Every balance change
  is an append-only ledger entry with a unique idempotency key inside the same
  transaction as its state transition.
- SQL values are always bound parameters. Dynamic identifiers or fragments must
  come from fixed source-code allowlists only.
- Error and audit records use stable codes and non-secret IDs. Do not log email,
  IP, cookie, session, API key, recharge code, internal admission credential,
  prompt, response body, or arbitrary upstream headers.

## Implementation and tests

- Keep modules small: configuration, crypto, database, auth, ledger, admission,
  HTTP server, and portal are separate responsibilities.
- No runtime dependency may be added without an alternatives and supply-chain
  review. Prefer Bun and Web APIs.
- Add focused tests under `tests/hub-*.test.ts` for every behavior change.
- Authentication or accounting changes require negative and concurrent tests,
  not only happy-path tests.
- Run `bun x tsc -p hub/tsconfig.json --noEmit`, focused hub tests, root
  typecheck/full tests, privacy scan, and high-severity dependency audit before
  release readiness.

Detailed unfixed findings and threat-model exploit reasoning remain in `.tmp/`.
