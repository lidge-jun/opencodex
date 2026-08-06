# 020 — Phase 2: admission returns the matched key

The smallest phase and the only one that touches the auth path. It changes no
admission decision — every request that is admitted today is admitted after this
phase, and every request rejected today is still rejected. The single change is
that the function which already knows *which* key matched stops discarding that
fact.

Dependency position: after `010` (the entry type it returns is named there),
before `030` (which has nothing to record without it).

## Scope

IN

- MODIFY `src/server/auth-cors.ts` — add `resolveDataPlaneAdmissionSecret()`;
  reimplement `isDataPlaneAdmissionSecret`, `hasValidApiAuth`,
  `requireResponsesApiAuth` on top of it with unchanged signatures.
- MODIFY `src/server/ws-bridge.ts` — declare `admission` on `WsData`.
- MODIFY `src/server/index.ts` — resolve the admission at each data-plane route
  and store it in the Responses WS upgrade payload.
- NEW `tests/data-plane-admission-identity.test.ts`.

OUT

- No header set changes. `requireResponsesApiAuth` still reads only
  `x-opencodex-api-key`; the Codex Direct bearer separation is untouched
  (`002` §1).
- No rejection of any currently-admitted token. Revocation and expiry are out of
  unit.
- No log or usage field yet — phase 3 owns the record shape. This phase resolves
  and threads; nothing is persisted.
- No change to management auth (`/api/*` is a different plane).

## Design

### One resolver, three unchanged wrappers

`isDataPlaneAdmissionSecret` loops `config.apiKeys` and tests `k.key`
(`src/server/auth-cors.ts:213-221`). `k.id` is bound in that loop and dropped.
The resolver returns it; the boolean wrapper becomes a one-line adapter, so every
existing caller and every existing test keeps working unmodified.

Admission is not always a configured key, and the three other cases must be
explicit rather than `undefined` — an absent value has to mean "not resolved
here", not "we forgot":

```ts
export type DataPlaneAdmission =
  | { kind: "configured"; keyId: string }
  | { kind: "environment" }
  | { kind: "loopback" };
```

`loopback` covers the bind-is-loopback bypass (`auth-cors.ts:249`,
`:250-251`), where no token is read at all. `environment` is the
`OPENCODEX_API_AUTH_TOKEN` match (`:217-219`), which has no id because it is not
a stored entry.

### Why the WS handshake needs its own handling

HTTP routes authorize and log within one function call. The Responses WebSocket
authorizes once at upgrade — the branch at `src/server/index.ts:361-368`, whose
own comment says "auth is handshake-time only, so capture inbound headers and
thread them into the pipeline" — and then builds a fresh log context per frame
(`:834-849`). A per-frame re-resolution would mean re-reading headers that no
longer exist. The resolved admission is stored in the upgrade payload beside the
forwarded headers (`:377-381`) and read back per frame.

`WsData` is declared in `src/server/ws-bridge.ts:20-32`, not in `index.ts`, so
that file is in this phase's change map. Missing it would leave the upgrade
payload untyped.

### What phase 2 does NOT do, so that it stands alone

A phase that cannot typecheck by itself is not a phase. The first draft of this
document put `admission` into the routes' `RequestLogContext` literals while
deferring the field's declaration to `030` — which would not compile, because
those literals are annotated `RequestLogContext`
(`src/server/index.ts:480`, `:513`, `:640`, `:662`) and the interface
(`src/server/request-log.ts:34-85`) has no such member.

So phase 2 keeps `admission` as a **local binding** at each route and writes it
into no log context at all. `030` consumes that local and converts it into the
telemetry fields it declares in the same phase. The only structural change phase 2
makes outside `auth-cors.ts` is the WS upgrade payload, whose type it also owns.

That keeps the phase independently verifiable: `bun run typecheck` plus the two
admission suites pass with `030` not written yet.

## File change map

| Path | Action |
|------|--------|
| `src/server/auth-cors.ts` | MODIFY — resolver + adapters |
| `src/server/ws-bridge.ts` | MODIFY — `admission` on `WsData` |
| `src/server/index.ts` | MODIFY — resolve per route (locals) + WS upgrade payload |
| `tests/data-plane-admission-identity.test.ts` | NEW |

## Diffs

### `src/server/auth-cors.ts:212-221`

Before:

```ts
/** Whether `token` is a data-plane admission secret. */
export function isDataPlaneAdmissionSecret(token: string, config: OcxConfig): boolean {
  const actual = token.trim();
  if (!actual) return false;
  if (secretEquals(actual, configuredApiAuthToken(config))) return true;
  for (const k of config.apiKeys ?? []) {
    if (secretEquals(actual, k.key)) return true;
  }
  return false;
}
```

After:

```ts
export type DataPlaneAdmission =
  | { kind: "configured"; keyId: string }
  | { kind: "environment" }
  | { kind: "loopback" };

/** Which admission secret `token` is, or null when it is none of them.
 *  Same comparisons, same order, same timing guarantees as the boolean form —
 *  the only difference is that the matched entry's id survives the loop. */
export function resolveDataPlaneAdmissionSecret(token: string, config: OcxConfig): DataPlaneAdmission | null {
  const actual = token.trim();
  if (!actual) return null;
  if (secretEquals(actual, configuredApiAuthToken(config))) return { kind: "environment" };
  for (const k of config.apiKeys ?? []) {
    if (secretEquals(actual, k.key)) return { kind: "configured", keyId: k.id };
  }
  return null;
}

/** Whether `token` is a data-plane admission secret. */
export function isDataPlaneAdmissionSecret(token: string, config: OcxConfig): boolean {
  return resolveDataPlaneAdmissionSecret(token, config) !== null;
}
```

The loop must keep running to completion on a match-by-`secretEquals` basis in
the same order; `secretEquals` already length-guards before `timingSafeEqual`
(`:204-210`), and returning early on match is what today's code does. This phase
does not change that property in either direction.

### `src/server/auth-cors.ts:249-274` — resolving forms of the wrappers

`hasValidApiAuth` and `requireResponsesApiAuth` keep their exact signatures and
behavior. Each gains a sibling that returns the admission, and the boolean form
delegates:

```ts
/** Header precedence identical to hasValidApiAuth. */
export function resolveApiAuth(req: Request, config: OcxConfig): DataPlaneAdmission | null {
  if (!isApiAuthRequired(config)) return { kind: "loopback" };
  const actual = req.headers.get("x-opencodex-api-key")?.trim()
    || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim()
    || req.headers.get("x-api-key")?.trim();
  if (!actual) return null;
  return resolveDataPlaneAdmissionSecret(actual, config);
}

export function hasValidApiAuth(req: Request, config: OcxConfig): boolean {
  return resolveApiAuth(req, config) !== null;
}

/** Dedicated-header-only form. See requireResponsesApiAuth for why. */
export function resolveResponsesApiAuth(req: Request, config: OcxConfig): DataPlaneAdmission | null {
  if (!isApiAuthRequired(config)) return { kind: "loopback" };
  const actual = req.headers.get("x-opencodex-api-key")?.trim();
  if (!actual) return null;
  return resolveDataPlaneAdmissionSecret(actual, config);
}
```

`requireApiAuth` and `requireResponsesApiAuth` keep returning `Response | null`
and are re-expressed over the resolvers, so the routes can obtain both the error
response and the admission without reading headers twice.

### `src/server/index.ts` — the authenticated routes

The pattern is identical at each site. `/v1/responses` (`:578-585`):

Before:

```ts
        const apiAuthError = requireResponsesApiAuth(req, config);
        if (apiAuthError) return withCors(apiAuthError, req, config);
        ...
        const logCtx = { model: "unknown", provider: "unknown" };
```

After:

```ts
        const admission = resolveResponsesApiAuth(req, config);
        if (!admission) return withCors(responsesApiAuthError(), req, config);
        ...
        // `admission` stays a local in this phase. 030 consumes it and declares
        // the telemetry fields it writes; putting it on RequestLogContext here
        // would not typecheck until that phase exists.
        const logCtx: RequestLogContext = { model: "unknown", provider: "unknown" };
```

`responsesApiAuthError()` is the same 401 the current wrapper builds
(`auth-cors.ts:273`), extracted so the route can branch on the resolver result
without losing the exact response body. Every site `030` will attribute:

**The wrapper each row uses today is the wrapper it must keep.** Swapping one for
another silently changes which headers are admitted, which is the one thing this
phase promises not to do. Anchors verified individually against the tree:

| Route | Auth site | Wrapper today | Emits a log? |
|-------|-----------|---------------|--------------|
| `/v1/responses` | `index.ts:578` | `requireResponsesApiAuth` | yes |
| `/v1/responses` WS upgrade | `index.ts:365` | `requireResponsesApiAuth` | yes (per frame) |
| `/v1/chat/completions` | `index.ts:654` | `requireResponsesApiAuth` | yes |
| `/v1/messages` | `index.ts:632` | `hasValidApiAuth` | yes |
| `/v1/messages/count_tokens` | `index.ts:617` | `hasValidApiAuth` | **no** |
| `/v1/responses/compact` | `index.ts:473` | `requireResponsesApiAuth` | yes |
| `/v1/images/generations`\|`/edits` | `index.ts:504` | `requireApiAuth` | yes |
| search | `index.ts:549-570` | `requireApiAuth` | yes |
| live / realtime call-create | `index.ts:678` | `requireApiAuth` | yes |
| realtime sideband upgrade | `index.ts:706` | `requireApiAuth` | yes |
| `/v1/models` | `index.ts:403` | `requireApiAuth` | no |

Two rows resolve nothing and are listed only to record that they were checked:
`/v1/models` has no `logCtx` (`index.ts:403-408`), and `count_tokens` returns
`handleClaudeCountTokens` directly without logging (`index.ts:623-624`). Note
that `count_tokens` is matched **before** `/v1/messages` because it is the longer
path (`index.ts:611-612`), which is why its auth site has the lower line number.

Every remaining row emits a log and is attributed in `030`; that document's
coverage table matches this one row for row, which is the check against
attributing only the obvious three protocols.

### `src/server/index.ts:377-381` — the WS upgrade

Before:

```ts
        if (server.upgrade(req, {
          data: {
            headers: selectForwardHeaders(req.headers),
          },
        })) return undefined as unknown as Response;
```

After:

```ts
        if (server.upgrade(req, {
          data: {
            headers: selectForwardHeaders(req.headers),
            // Resolved once at handshake: the per-frame contexts below have no
            // request headers to re-resolve from.
            admission,
          },
        })) return undefined as unknown as Response;
```

with `admission` resolved from the same handshake auth check that already guards
this path (`index.ts:365`, inside the `upgrade === "websocket"` branch that starts
at `:361`), and `WsData` widened in `src/server/ws-bridge.ts:20-32`:

```ts
export interface WsData {
  headers?: Headers; // ...
  /** Resolved once at handshake. Per-frame contexts cannot re-resolve: the
   *  request headers are gone by then. */
  admission?: DataPlaneAdmission;
  // ...
}
```

The per-frame context construction (`index.ts:834-849`) reads
`ws.data.admission`; `030` is what turns it into telemetry fields.

## Tests — `tests/data-plane-admission-identity.test.ts` (NEW)

| # | Scenario | Assertion |
|---|----------|-----------|
| 1 | Configured key, remote bind | `{ kind: "configured", keyId }` with the id of the matching entry |
| 2 | Two configured keys, second one presented | the id is the **second** entry's, not the first |
| 3 | `OPENCODEX_API_AUTH_TOKEN` | `{ kind: "environment" }` |
| 4 | Unknown token | `null` |
| 5 | Empty / whitespace token | `null` |
| 6 | Loopback bind, no header | `{ kind: "loopback" }` |
| 7 | `isDataPlaneAdmissionSecret` over all of the above | identical booleans to the pre-change implementation |
| 8 | `resolveResponsesApiAuth` with a bearer-only request on a remote bind | `null` — the dedicated-header rule is unchanged |
| 9 | `resolveApiAuth` with the same bearer request | resolves — proves the two wrappers still differ |
| 10 | `isProxyAdmissionSecret` over a configured key, a generated `ocx_data_` key, and a legacy `ocx_<40 hex>` | unchanged from today (`auth-cors.ts:231-247`) — the refactor must not break the never-forward-upstream guard |
| 11 | Management/admin secret presented to a data-plane route | still rejected; plane separation intact (`src/server/management-auth.ts:115-119`) |

Test 2 is the activation scenario that the id is really the matched entry and not
"the first key". Test 7 is the no-behavior-change proof; tests 8 and 9 are the
proof that the header-domain separation survived the refactor.

Also re-run in full: `tests/server-auth.test.ts` and
`tests/server-management-auth.test.ts`. Those two files are the existing contract
for this boundary, and this phase's claim is that neither of them changes.

## Accept criteria

1. Every existing admission test passes unmodified. **Activation:** run both
   suites; observable is zero edits to their assertions.
2. A configured key resolves to its own id. **Activation:** test 2; observable is
   the second entry's id.
3. Loopback and environment admissions are labelled, not `undefined`.
   **Activation:** tests 3 and 6.
4. The Responses/Chat dedicated-header rule is intact. **Activation:** tests 8
   and 9 in the same run.
5. WS frames can name the admission that opened the socket. **Activation:** a
   handshake test asserting `ws.data.admission.kind === "configured"` with the
   expected id.
6. `bun run typecheck` clean; no `any` introduced at the auth boundary.
7. **The phase stands alone.** `bun run typecheck` and both admission suites pass
   with `030` unwritten. **Activation:** run the gate on a tree containing only
   this phase's diff; observable is a clean exit with no reference to
   `apiKeyId`, `inboundProtocol`, or `admissionKind` anywhere in the tree.

## Risk

This is the security-boundary phase, so its review bar is `MAINTAINERS.md`
security review. Two specific things a reviewer should attack: whether the
resolver preserves the comparison order and the length-guard before
`timingSafeEqual` (`auth-cors.ts:204-210`), and whether any route now reads
headers twice — a second read is not a vulnerability but it is the kind of drift
that makes the two paths diverge later.
