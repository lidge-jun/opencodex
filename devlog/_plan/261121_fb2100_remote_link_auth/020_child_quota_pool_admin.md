# 020 #8999: the Child's admin token reads the Home's quota pool

Problem: GOAT reads a Home's `ocx.quota-pool/1` through a Remote Link Child at
`/api/machine/hub-relay/api/quota-pool` with the Child's local admin token. The link-Child branch of
`src/client/machine-listener.ts` admits only a `gui-session` principal there and answers
`401 opencodex machine GUI session required`, so every Child reports "OpenCodex pool unavailable: HTTP 401".

Decision (coordinator): the admin-token principal is admitted for exactly `GET`/`HEAD /api/quota-pool` on that
branch. Everything else under the prefix keeps requiring the Child's dashboard session, and the relay's
refresh-key refusal still applies to the admitted read.

Diff:

- `src/client/link-management-relay.ts`: `linkChildAdminReadAllowed(method, pathname)` — true only for
  `GET`/`HEAD` and the exact pathname `/api/quota-pool`.
- `src/client/machine-listener.ts` (link-Child branch): the principal check becomes
  `gui-session`, or `admin-token` when `linkChildAdminReadAllowed(req.method, url.pathname.slice(prefix.length))`.
  The pathname is the parsed URL's (the same value the relay forwards), so a percent-encoded slash, a trailing slash,
  a doubled slash or a case variant is a different pathname and stays refused. The query is untouched here and is
  checked by `linkManagementReadAllowed` (refresh, reload, force, quota answer 403 `link_child_read_only`).
  The bootstrap (`/opencodex-session`), the origin check before this branch and the hub-client branch are unchanged.
- `structure/quota-pool.md`, `structure/remote-link.md`: name the credential a local consumer uses on a Child.

Tests (`tests/clients/client-link-relay.test.ts`, real Child listener and a real link-authenticated Home socket):
the admin token reads `GET` and `HEAD /api/quota-pool` (Bearer and `x-opencodex-api-key`); it is refused with
401 on `/api/usage`, `/api/providers`, `/api/quota-pool/`, `/api/quota-pool%2F`, `//api/quota-pool`,
`/api/Quota-Pool` and `POST /api/quota-pool`; `?refresh=1` answers 403; no token answers 401; the Home sees only the
admitted reads.

Verification: that file, `tests/server/quota-pool-relay.test.ts`, `bun run typecheck`, `bun run structure:check`.
Security review by gpt-6.1-terra before merge; reasoning beyond the published diff stays in `.tmp/`.

