# 002 — Backend feasibility

What the server can already support, what it cannot, and what each gap costs.
Read with `001` §2. No diffs here; phases `010`–`030` own those.

## 1. Where an `ocx_` key is actually checked

One function decides: `isDataPlaneAdmissionSecret(token, config)`
(`src/server/auth-cors.ts:213-221`). It compares the environment token first,
then walks `config.apiKeys` with a length-guarded `timingSafeEqual`
(`:204-211`), and returns `boolean`.

Two wrappers sit on it:

| Wrapper | Headers accepted | Used by |
|---------|------------------|---------|
| `hasValidApiAuth` / `requireApiAuth` | `x-opencodex-api-key`, `Authorization: Bearer`, `x-api-key` | `/v1/models` (`index.ts:403`), `/v1/messages` (`:617`), count_tokens (`:632`) |
| `requireResponsesApiAuth` | `x-opencodex-api-key` only | `/v1/responses` (`:359`), the Responses WS handshake (`:573`), `/v1/chat/completions` (`:654`) |

The narrow wrapper exists on purpose: `Authorization` on a Responses request may
belong to Codex Direct passthrough, and the two bearer domains must not be
confusable (`auth-cors.ts:262-268`). That is a deliberate security decision and
this unit does not touch it — it only stops the GUI from describing the wrong one
(`001` W1).

**The matched key id already exists in memory and is thrown away.** The loop
binds `k` and tests `k.key`; `k.id` is right there (`auth-cors.ts:214-216`).
Returning it changes no admission decision and no wire contract — the wrappers
can keep their boolean signatures and call a new resolver underneath. That is why
phase 2 is cheap and phase 3 is possible at all.

Three admissions have no configured-key id and need explicit identities rather
than a silent `undefined`:

| Path | Evidence | Identity |
|------|----------|----------|
| Loopback bypass — no token is read | `auth-cors.ts:184-193`, `:250-251` | `loopback` |
| `OPENCODEX_API_AUTH_TOKEN` match | `:174-176`, `:217-219` | `environment` |
| Auth not required (loopback bind) | `:249` | `loopback` |

WebSocket admission is the one structural complication: the handshake authorizes
once (`index.ts:573-579`) and stores selected headers in `WsData`
(`:378-381`), then every frame builds a fresh keyless log context (`:834-849`).
Attribution has to be resolved at handshake and carried in `WsData`, not
re-derived per frame.

## 2. Telemetry, and the one field that is missing

Two records matter.

`RequestLogEntry` is the in-memory `/api/logs` row
(`src/server/request-log.ts:87-126`), built by `addFinalRequestLog` from
`RequestLogContext` (`:34-85`, `:650-725`) and persisted through
`addRequestLog` → `appendUsageEntry` (`:222-266`) into `usage.jsonl`
(`src/usage/log.ts:266-337`) as `PersistedUsageEntry` (`:41-78`).

Both carry model, provider, status, duration, TTFT, tokens, attempts, service
tier and failure diagnostics. Neither carries any inbound identity.

`surface` looks like it might serve, but it is a three-value enum —
`"claude" | "claude-desktop" | "grok"` (`request-log.ts:94`,
`src/usage/log.ts:41-47`) — set only by the Claude handlers
(`src/server/claude-messages.ts:516-567`) and a managed Grok header
(`src/server/chat-completions.ts:65-70`). Ordinary Responses and ordinary Chat
Completions both leave it `undefined`, so widening `surface` would conflate the
two protocols this unit needs to tell apart. Protocol needs its own field.

The full thread for `apiKeyId`, in order:

1. resolve it — `auth-cors.ts:213-221` (phase 2)
2. carry it into the route/WS context — `index.ts:573-608`, `:834-849`
3. declare it on both record types — `request-log.ts:34-126`
4. copy it when finalizing — `request-log.ts:650-725`, `:222-266`
5. persist and normalize it — `src/usage/log.ts:41-78`, `:266-324`
6. aggregate it — `src/usage/summary.ts:485-519`, only if per-key totals are
   needed beyond the rollup phase 3 builds

Steps 5 and 6 are where compatibility bites: `usage.jsonl` rows written before
this change have no `apiKeyId`, and normalization must treat absent as absent
rather than defaulting it into a bucket. The GUI states "no data before <date>"
instead of showing a misleading zero (`000` §Scope OUT).

`/api/logs` maps the ring through `requestLogDto` and adds display-time cost
metrics (`src/server/management/logs-usage-routes.ts:126-134`,
`src/server/management/shared.ts:143-161`) — it does not serve
`RequestLogEntry` verbatim, so a new field is exposed there only if the DTO
names it; `/api/usage` serves a
durable snapshot through `summarizeUsage` (`:187-205`). The API tab does not need
the full summary path — a small per-key rollup on `GET /api/keys` is enough for
the detail pane, which keeps phase 3 out of `summarizeUsage`'s aggregation
contract.

## 3. Lifecycle: what is missing and what each one really costs

All key management is the three handlers at
`src/server/management/oauth-account-routes.ts:433-470`. Elsewhere `config.apiKeys`
is only read — admission (`auth-cors.ts:195-220`) and "first key" for generated
client environments (`src/server/system-env.ts:50-51`, `src/cli/claude.ts:97-98`).
That second read is a constraint: anything that can make the first entry unusable
(revocation, expiry) silently changes what those generators emit.

| Capability | Owning change | Verdict |
|-----------|---------------|---------|
| Rename | `PATCH /api/keys` in `handleOauthAccountRoutes`; `name` already exists | **IN, phase 1.** No schema growth, no auth interaction |
| DELETE truthfulness | Check length before/after in the same handler (`:464-469`) | **IN, phase 1.** Pure bug |
| Distinguishable key | Change generation (`:449-458`); nothing reads the prefix as a discriminator | **IN, phase 1.** New keys only; existing keys keep their bytes |
| `lastUsedAt` | Would write config on every admission (`saveConfigPreservingClaudeCode`, `src/config.ts:1517-1555`) | **IN as derived, phase 3.** Derive from attribution; never write config on the request path |
| Revoke ≠ delete | `revokedAt` field + rejection in the resolver (`auth-cors.ts:213-221`) | **OUT.** Changes what a key is allowed to do |
| Expiry | `expiresAt` + resolver rejection | **OUT.** Same reason; also interacts with the "first key" readers |
| Scopes / allowlist | New fields + enforcement at every route boundary (`index.ts:403-665`) | **OUT.** Authorization semantics, a unit of its own |

`configSchema` does not declare `apiKeys` at all and only survives via
`.passthrough()` (`src/config.ts:669-704`). Phase 1 adds the explicit entry schema
before any later phase adds fields to it — validating a shape after three phases
have written to it is the wrong order.

All mutations keep going through `saveConfigPreservingClaudeCode`
(`src/config.ts:1517-1555`), as POST and DELETE already do (`:459`, `:468`).

## 4. Key generation

POST concatenates every configured provider API key, a `crypto.randomUUID()`
salt and `Date.now()`, hashes with SHA-256, truncates to 40 hex, prefixes
`ocx_data_` (`oauth-account-routes.ts:452-457`).

No provider-key disclosure follows from the output: SHA-256 preimage recovery is
infeasible, and the random UUID salt blocks offline testing of guessed provider
keys even though the timestamp is predictable. The defect is unnecessary coupling
— provider credentials are copied into a hash input that does not need them, so
the secret's safety argument now depends on UUID entropy and string
concatenation instead of on a direct random draw.

The repository already does this correctly one file over: management and session
secrets use `randomBytes(32).toString("base64url")` from `node:crypto`
(`src/server/management-auth.ts:79-82`, `:156-179`). Phase 1 uses the same
primitive. This is a construction cleanup on a public-repo behavior, not a
disclosure of an exploitable defect; no embargoed material belongs in this unit.

## 5. Endpoint derivation, and why it is out of scope

`buildApiAccessEndpoints` receives `req.url`, raw `Host` and raw `Origin`
(`oauth-account-routes.ts:436-445`) and assembles the five URLs plus
`claudeCodeEnabled` (`src/server/management/api-access.ts:4-13`, `:126-140`).

For a non-wildcard configured hostname it ignores request context entirely and
returns `http://<configured-host>:<port>/v1`
(`api-access.ts:72-76`). For wildcard binds the precedence is Origin → `req.url`
→ `Host` → loopback (`:78-107`); the first two preserve HTTPS when it is already
present (`:54-61`, `:81-86`), but the `Host` fallback hardcodes `http://`
(`:92-104`).

Nothing consumes `Forwarded`, `X-Forwarded-Proto`, `X-Forwarded-Host`, or a
configured public origin (`:15-21`). Behind a TLS-terminating proxy the tab can
therefore advertise an `http://` or internal URL. `isAllowedRequestOrigin` has the
same limitation (`auth-cors.ts:91-109`).

This is real, and it is **out of scope** for two reasons: trusting a forwarded
header is a trust-boundary decision requiring security review per `MAINTAINERS.md`,
and `fix/760-management-origin-tls` is already open upstream against the same
code. Phase 2 and 4 must not restructure `api-access.ts`, so that branch merges
cleanly. Tests cover host/IPv6/wildcard only — no HTTPS proxy, forwarded header,
port remap or path prefix (`tests/api-access-endpoints.test.ts:8-76`).

## 6. Feasibility summary

| Capability | Backend change | Risk | Size | Phase |
|-----------|----------------|------|------|-------|
| Distinguishable key + rename + honest DELETE + schema | Three handlers, one Zod schema | Low | S | 1 |
| Admission returns the matched id | Resolver under unchanged wrappers | Medium — auth boundary, WS threading | M | 2 |
| Per-key + per-protocol attribution | Two record types, finalize path, normalization, rollup | Medium — durable-record compatibility | M | 3 |
| Secure key generation | `randomBytes` replaces the hash derivation | Low | S | 1 |
| Reverse-proxy-safe endpoints | Trusted public origin or validated forwarded headers | High — spoofing/TLS boundary | M | **OUT** |
| Direct `/api/keys` route tests | New test file; none exist today | Low | S | 1 |
