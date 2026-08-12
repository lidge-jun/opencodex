# 030 — Phase 3: per-key attribution

The phase that makes the detail pane worth opening. It carries the admission
resolved in `020` into the request log, persists it, and serves a small per-key
rollup on `GET /api/keys`.

Dependency position: after `020` (nothing to record before it), before `040`
(which renders this). This is the last backend phase.

## Scope

IN

- MODIFY `src/server/request-log.ts` — `apiKeyId`, `admissionKind` and
  `inboundProtocol` on `RequestLogContext` and `RequestLogEntry`; copied in
  `addFinalRequestLog` **and again in `addRequestLog`**, which rebuilds the
  persisted object field by field.
- MODIFY `src/usage/log.ts` — the three fields on `PersistedUsageEntry`, normalized
  in `normalizeUsageEntry`.
- MODIFY `src/server/index.ts` — convert the `admission` resolved by `020` into
  `apiKeyId`/`admissionKind` at **every authenticated route that emits a request
  log**, and set `inboundProtocol` where a protocol name applies.
- MODIFY `src/server/management/oauth-account-routes.ts` — per-key rollup on the
  GET response; `authMatrix` on the same response.
- NEW `src/server/management/api-key-usage.ts` — the rollup reader.
- NEW `tests/api-key-attribution.test.ts`.

OUT

- No change to `summarizeUsage` (`src/usage/summary.ts:485-519`). The API tab
  needs a rollup, not a new dimension in the Usage report; adding a grouping key
  there would change a shared aggregation contract for one pane
  (`002` §2).
- No retroactive attribution. Rows written before this phase have no key id and
  do not acquire one.
- No `lastUsedAt` on the stored key entry. It is derived from attribution, never
  written on the request path (`002` §3 — a config write per admission would turn
  auth into synchronous disk IO).
- No per-key cost. Cost is display-time in `/api/logs`
  (`src/server/management/shared.ts:73-161`) and out of this pane's job.

## Design

### Two fields, not one widened enum

`surface` is a three-value enum — `"claude" | "claude-desktop" | "grok"`
(`src/server/request-log.ts:94`, `src/usage/log.ts:41-47`) — set by the Claude
handlers and a managed Grok header. Ordinary Responses and ordinary Chat
Completions both leave it undefined, so widening it would merge the two protocols
this phase exists to separate. `inboundProtocol` is its own field with its own
closed set:

```ts
inboundProtocol?: "responses" | "chat" | "messages";
```

`surface` keeps meaning *which client product*; `inboundProtocol` means *which
wire*. They are orthogonal and both are useful in the Logs tab, which is a
side benefit rather than this unit's goal.

### Two fields, because one namespace would collide

The first draft stored the literals `"environment"` and `"loopback"` in the same
`apiKeyId` field as configured ids, on the reasoning that a UUID cannot collide
with either word. That reasoning is wrong: `id` is only validated as a non-empty
string (`010` §Diffs, `apiKeyEntrySchema`), the entries are hand-editable JSON,
and nothing has ever generated ids for keys imported from an older config. A user
with a key literally named-by-id `loopback` would silently absorb every
unauthenticated loopback request.

So the admission kind is its own field and `apiKeyId` is set only for a real
configured key:

```ts
apiKeyId?: string;                                      // configured entries only
admissionKind?: "configured" | "environment" | "loopback";
```

The rollup buckets on `apiKeyId` and additionally requires
`admissionKind === "configured"`, so even a duplicated or adversarial id cannot
pull in traffic that was not admitted by that key.

**Duplicate configured ids** remain possible in a hand-edited config — nothing
enforces uniqueness (`src/types.ts:678`, and `010`'s schema does not add a
uniqueness constraint because a config-load-time rejection would be a data-loss
risk of its own). Two entries sharing an id share a rollup row. The rollup
detects this and marks those rows ambiguous rather than reporting a number that
belongs to two keys; the GUI renders the ambiguity instead of a total.

Absent `apiKeyId` is not one thing, so provenance reads both fields together:

| `admissionKind` | `apiKeyId` | Meaning |
|-----------------|-----------|---------|
| present | present | attributed to that configured key |
| `environment` \| `loopback` | absent | admitted, but by no configured key |
| absent | absent | the row predates attribution — **or** a post-phase row whose admission was not threaded |

That is why the rollup keys on `admissionKind === "configured"` rather than on
`apiKeyId` being truthy, and why `attributionSince` — the earliest row carrying
any recognized `admissionKind` — is what the GUI uses to say "nothing before this
is attributable" (`003` §6).

The third row is deliberately ambiguous, and the ambiguity is bounded rather than
wished away. Every HTTP route resolves its admission before building a context, so
a post-phase HTTP row always carries a kind. The one path that can produce a
kindless post-phase row is a Responses WS frame whose `ws.data.admission` is
absent (`020` types it optional, matching every other `WsData` member), which the
frame path handles by spreading nothing rather than inventing a value.

That is intentional: an unattributed frame is preferable to a fabricated
attribution. But it must not be silent, so the WS handshake is where the invariant
is asserted — the socket is authorized before upgrade
(`src/server/index.ts:365`), so `admission` is always set on a socket that
completed the handshake, and test 21 drives a frame end-to-end to prove the field
survived into the per-frame context. If that test ever fails, the correct response
is to fix the threading, not to widen the provenance table.

### Coverage: every authenticated logged route, not the four obvious ones

`000` promises attribution end to end, and an undercount is worse than no count —
the pane exists so a user can decide whether a key is safe to delete. Every route
that authenticates and calls `addFinalRequestLog` therefore carries `apiKeyId`:

| Route | Auth site | Log context | `inboundProtocol` |
|-------|-----------|-------------|-------------------|
| `/v1/responses` | `index.ts:578` | `:585` | `"responses"` |
| `/v1/responses` WS frames | handshake `:365` | `:834-849` | `"responses"` |
| `/v1/chat/completions` | `:654` | `:662` | `"chat"` |
| `/v1/messages` | `:632` | `:640` | `"messages"` |
| `/v1/responses/compact` | `:473` | `:480` | `"responses"` |
| `/v1/images/generations`\|`/edits` | `:504` | `:513` | — |
| search | `:549-570` | same block | — |
| live / realtime call-create | `:678` | same block | — |
| realtime sideband upgrade | `:706` | same block | — |

`inboundProtocol` stays absent where no protocol in the closed set applies;
it is a wire discriminator, not a route label, and widening it to cover images or
search would repeat the mistake `surface` already made. Attribution is what must
be complete.

`/v1/models` (`index.ts:403-408`) and `/v1/messages/count_tokens`
(`index.ts:617-624`, which returns the handler directly) produce no request log,
so there is nothing to attribute; `020`'s route table records both as checked and
skipped. This table and that one agree row for row.

### The rollup reads usage, not config

`GET /api/keys` gains a `usage` object per row. It is computed by reading the
durable usage snapshot the same way `/api/usage` does
(`src/server/management/logs-usage-routes.ts:187-205`) and counting by
`apiKeyId` — not by maintaining a counter in `config.json`. Counters in config
would need a write per request; the snapshot is already read for another route.

The rollup is bounded: last 7 days for `requests7d`, plus lifetime `totalRequests`
and `lastUsedAt` over whatever the retention window holds. `attributionSince` is
the timestamp of the earliest row carrying a recognized `admissionKind` — not the
earliest row with an `apiKeyId`, since an environment or loopback row is
attributed traffic with no configured key to name. It is a property of the data
set, so it is returned once at the top level of the response and never inside a
per-key object (`000` §Cross-phase contracts).

### `authMatrix` ships from the server

`003` §3 requires the GUI to stop hardcoding auth rules. The matrix is derived
from which wrapper each route uses (`002` §1) and shipped on the same GET, so a
future auth change updates one place. It is static data about the build, not
per-request state, so it is a constant table in `api-access.ts`'s neighborhood —
but it lives next to the wrappers it describes, not in the GUI.

## File change map

| Path | Action |
|------|--------|
| `src/server/request-log.ts` | MODIFY — 3 fields x 2 types, copied in `addFinalRequestLog` AND `addRequestLog` |
| `src/usage/log.ts` | MODIFY — 3 fields, normalized |
| `src/server/index.ts` | MODIFY — set the fields at every logged route in the coverage table above |
| `src/server/management/api-key-usage.ts` | NEW — rollup |
| `src/server/management/oauth-account-routes.ts` | MODIFY — GET payload |
| `tests/api-key-attribution.test.ts` | NEW |

## Diffs

### `src/server/request-log.ts:34-41` — context

Before:

```ts
export interface RequestLogContext {
  model: string;
  provider: string;
  /** TTFT: ms from request start to the first non-empty model output delta (WP4, devlog 040). */
  firstOutputMs?: number;
  /** Best-effort chat/session correlation for Logs grouping (#330). Opaque; omit when unknown. */
  conversationId?: string;
  surface?: "claude" | "claude-desktop" | "grok";
```

After:

```ts
export interface RequestLogContext {
  model: string;
  provider: string;
  /** TTFT: ms from request start to the first non-empty model output delta (WP4, devlog 040). */
  firstOutputMs?: number;
  /** Best-effort chat/session correlation for Logs grouping (#330). Opaque; omit when unknown. */
  conversationId?: string;
  surface?: "claude" | "claude-desktop" | "grok";
  /** The matched configured key's id. Set ONLY for `admissionKind: "configured"`
   *  — never a sentinel, so a hand-edited entry whose id happens to be
   *  "loopback" cannot absorb unrelated traffic. Absent on a pre-attribution row
   *  and on every non-configured admission. */
  apiKeyId?: string;
  /** Which kind of admission opened this request. Carries no secret. */
  admissionKind?: "configured" | "environment" | "loopback";
  /** Which inbound wire was used. Orthogonal to `surface`, which names the client
   *  product — widening that enum would merge Responses and Chat Completions. */
  inboundProtocol?: "responses" | "chat" | "messages";
```

The identical three fields are added to `RequestLogEntry` after its `surface`
declaration (`request-log.ts:94`). Both interfaces must carry all three: the
finalize step copies context → entry, and `addRequestLog` copies entry →
persisted, so a field missing from either interface is dropped silently at that
hop.

### `src/server/request-log.ts` — `addFinalRequestLog`

The entry is assembled from `logCtx` at the end of `addFinalRequestLog`
(`:650-725`). All three fields are copied with the same conditional-spread style the
surrounding code uses:

```ts
    ...(logCtx.apiKeyId ? { apiKeyId: logCtx.apiKeyId } : {}),
    ...(logCtx.inboundProtocol ? { inboundProtocol: logCtx.inboundProtocol } : {}),
    ...(logCtx.admissionKind ? { admissionKind: logCtx.admissionKind } : {}),
```

### `src/server/request-log.ts:222-266` — `addRequestLog`, the second copy

This is the step the first draft missed, and missing it would have made the whole
phase inert: `addRequestLog` does not spread the entry into `appendUsageEntry`, it
**reconstructs** the persisted object field by field (`:236-265`). A field that is
not named there never reaches `usage.jsonl`, so `/api/logs` would show attribution
while the rollup — which reads the durable snapshot — stayed empty forever.

Three lines are added inside the `appendUsageEntry({ ... })` literal, beside the
existing `surface` guard at `:241`:

```ts
      ...(entry.apiKeyId ? { apiKeyId: entry.apiKeyId } : {}),
      ...(entry.admissionKind ? { admissionKind: entry.admissionKind } : {}),
      ...(isKnownInboundProtocol(entry.inboundProtocol) ? { inboundProtocol: entry.inboundProtocol } : {}),
```

The activation test for this is deliberately end-to-end rather than a unit assert
on `addRequestLog`: drive an authenticated request, read the resulting JSONL row,
then call `GET /api/keys` and find the same key id in the rollup (test 13 below).
A unit test on either half would have passed against the broken draft.

### `src/usage/log.ts:41-47` — persisted shape

The same three optional fields on `PersistedUsageEntry`, and normalization in
`normalizeUsageEntry` (`:266-337`) following the existing pattern at `:272-276`:

```ts
    ...(typeof entry.apiKeyId === "string" && entry.apiKeyId.trim()
      ? { apiKeyId: capMetadataString(entry.apiKeyId) }
      : {}),
    ...(isKnownAdmissionKind(entry.admissionKind) ? { admissionKind: entry.admissionKind } : {}),
    ...(isKnownInboundProtocol(entry.inboundProtocol) ? { inboundProtocol: entry.inboundProtocol } : {}),
```

`isKnownInboundProtocol` and `isKnownAdmissionKind` mirror `isKnownUsageSurface`
(`src/usage/log.ts:80-94`) — closed-set
guard, so an old or corrupted row with an unexpected value drops the field
instead of poisoning the enum. This is the compatibility contract: absent and
unknown both normalize to absent, and no row fails to parse because of these
fields.

### `src/server/index.ts` — every authenticated logged route

`020` left `admission` as a local at each route. This phase converts it at every
site in the coverage table above:

```ts
        const logCtx: RequestLogContext = {
          model: "unknown",
          provider: "unknown",
          ...admissionFields(admission),
          inboundProtocol: "responses",
        };
```

where `admissionFields` is a small helper next to the resolver, and is the only
place the kind/id split is expressed:

```ts
export function admissionFields(a: DataPlaneAdmission):
  { admissionKind: DataPlaneAdmission["kind"]; apiKeyId?: string } {
  return a.kind === "configured"
    ? { admissionKind: "configured", apiKeyId: a.keyId }
    : { admissionKind: a.kind };
}
```

`/v1/messages` finalizes its logging inside `handleClaudeMessages`
(`index.ts:636-644`), so the fields must be set on the context *before* that call
— the comment at `:637-639` warns against re-wrapping the translated stream, and
that constraint is respected by setting fields at construction rather than after.

`/v1/responses/compact` (`:480`) and the image routes (`:513`) call
`addFinalRequestLog` directly after awaiting the handler, so their contexts are
constructed the same way; no other change is needed at those two sites.

Per-frame WS contexts are built in `src/server/index.ts:834-849` — not in
`ws-bridge.ts`, which owns only the `WsData` declaration that `020` widened. They
read `ws.data.admission`.
That field is **optional** on `WsData` (`src/server/ws-bridge.ts`), because every
other member of that interface is and a socket object can be constructed before
the handshake fills it. So the frame path narrows rather than assuming:

```ts
const admission = ws.data.admission;
const logCtx: RequestLogContext = {
  model: "unknown",
  provider: "unknown",
  ...(admission ? admissionFields(admission) : {}),
  inboundProtocol: "responses",
};
```

An unattributed frame is a correct outcome for a socket that somehow lacks the
field; inventing a sentinel to avoid the narrowing would reintroduce exactly the
collision this phase removed.

### `src/server/management/api-key-usage.ts` (NEW)

```ts
/** A discriminated union, not a number with a flag beside it: when two entries
 *  share an id there IS no per-key total, and an optional marker next to
 *  `requests7d: 7` invites a consumer to render the 7 anyway. */
export type ApiKeyUsage =
  | { ambiguous: true }
  | { ambiguous?: false; requests7d: number; totalRequests: number; lastUsedAt?: string };

export interface ApiKeyUsageSnapshot {
  rollup: Map<string, ApiKeyUsage>;
  /** Earliest row carrying any `admissionKind`. A property of the DATA SET, so it is
   *  singular and lives beside the map, never inside a per-key rollup. */
  attributionSince?: string;
}

/** Pure: one pass over an already-read snapshot. Unit-testable without IO. */
export function rollupApiKeyUsage(
  entries: PersistedUsageEntry[],
  configuredIds: string[],
): ApiKeyUsageSnapshot;

/** Reads the durable usage snapshot the way /api/usage does, then rolls it up.
 *  Never throws: an unreadable snapshot yields an empty map and no
 *  attributionSince, because key management must not fail when usage does. */
export async function readApiKeyUsageRollup(config: OcxConfig): Promise<ApiKeyUsageSnapshot>;
```

Rows are bucketed only when `admissionKind === "configured"` and `apiKeyId` is
present, so environment and loopback traffic can never land in a key's row even
if a hand-edited entry carries a colliding id. `configuredIds` is passed in so the
rollup can mark duplicates `ambiguous` without re-reading config.

Both functions are exported: the pure one is unit-tested against fixtures, the IO
one is what the route calls.

### `oauth-account-routes.ts:436-446` — GET

Before:

```ts
    const keys = config.apiKeys ?? [];
    const endpoints = buildApiAccessEndpoints(config, { ... });
    return jsonResponse({
      keys: keys.map(k => ({ id: k.id, name: k.name, prefix: k.key.slice(0, 17) + "...", createdAt: k.createdAt })),
      ...endpoints,
    }, 200, req, config);
```

(with `010`'s prefix change already applied)

After:

```ts
    const keys = config.apiKeys ?? [];
    const endpoints = buildApiAccessEndpoints(config, { ... });
    const { rollup, attributionSince } = await readApiKeyUsageRollup(config);
    return jsonResponse({
      keys: keys.map(k => ({
        id: k.id,
        name: k.name,
        prefix: k.key.slice(0, 17) + "...",
        createdAt: k.createdAt,
        usage: rollup.get(k.id) ?? { requests7d: 0, totalRequests: 0 },
      })),
      attributionSince,
      authMatrix: AUTH_MATRIX,
      ...endpoints,
    }, 200, req, config);
```

The rollup read must not make this route slow or able to fail: a usage-snapshot
read error degrades to empty rollups and an absent `attributionSince`, never a
non-200. Key management working is more important than usage numbers being
present, and the GUI already treats an absent field as "no data".

### `AUTH_MATRIX`

Declared beside the wrappers it describes, exported for the route:

```ts
export const AUTH_MATRIX = [
  { endpoint: "/v1/responses",        bearer: "rejected", dedicated: "required", xApiKey: "rejected" },
  { endpoint: "/v1/chat/completions", bearer: "rejected", dedicated: "required", xApiKey: "rejected" },
  { endpoint: "/v1/messages",         bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" },
  { endpoint: "/v1/models",           bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" },
] as const;
```

This is a hand-maintained table describing code, which is exactly the failure mode
`003` §3 complains about — so it lives in the same file as the wrappers, and its
accuracy is asserted by a test that drives real requests (below) rather than by
reading the table back.

## Tests — `tests/api-key-attribution.test.ts` (NEW)

| # | Scenario | Assertion |
|---|----------|-----------|
| 1 | Authed `/v1/chat/completions` with configured key A | the emitted log entry carries `apiKeyId === A.id`, `inboundProtocol === "chat"` |
| 2 | Same with key B | attributed to B — proves it is not "first key" |
| 3 | `/v1/responses` | `inboundProtocol === "responses"` |
| 4 | `/v1/messages` | `inboundProtocol === "messages"`, and `surface` still set independently |
| 5 | Loopback bind, no header | `admissionKind === "loopback"`, `apiKeyId` absent |
| 6 | `OPENCODEX_API_AUTH_TOKEN` | `admissionKind === "environment"`, `apiKeyId` absent |
| 7 | `normalizeUsageEntry` on a row with `inboundProtocol: "garbage"` | field dropped, row otherwise intact |
| 8 | `normalizeUsageEntry` on a pre-phase row (no fields) | parses unchanged |
| 9 | `rollupApiKeyUsage` over a fixture | correct `requests7d` boundary at exactly 7 days, correct `lastUsedAt` |
| 10 | `GET /api/keys` with usage present | each row has a `usage` object; unattributed keys read zero |
| 11 | `GET /api/keys` with the snapshot read failing | still 200, rollups zero, no `attributionSince` |
| 12 | **AUTH_MATRIX accuracy** | for each row, a real request with each header against a remote-bind server produces the stated admit/reject |
| 13 | **End-to-end persistence** | authed request → read the written `usage.jsonl` row → `GET /api/keys`; the same key id appears in the rollup |
| 14 | A configured key whose `id` is literally `"loopback"`, plus real loopback traffic | that key's rollup stays zero — `admissionKind` gates the bucket |
| 15 | Two configured entries sharing one id | both rows carry `ambiguous: true`; neither reports a total |
| 16 | `/v1/responses/compact`, authed | log row carries `apiKeyId` + `admissionKind`, `inboundProtocol: "responses"` |
| 17 | An image request, authed | log row carries `apiKeyId` + `admissionKind`; `inboundProtocol` absent |
| 18 | A search request, authed | log row carries `apiKeyId` + `admissionKind` |
| 19 | A live / realtime call-create, authed | log row carries `apiKeyId` + `admissionKind` |
| 20 | A realtime sideband upgrade, authed | log row carries `apiKeyId` + `admissionKind` |
| 21 | Open a Responses WS with a configured key, send one frame | the per-frame row carries that key's `apiKeyId` — proves the handshake admission survived into `ws.data` and out again |
| 22 | `rollupApiKeyUsage` over an environment row (older), a configured row (newer), and a pre-phase row (oldest) | `attributionSince` equals the **environment** row's timestamp, not the configured one — the field keys on `admissionKind`, not on `apiKeyId` |

Tests 5 and 6 assert `admissionKind`, not a sentinel in `apiKeyId`: those two
admissions have no configured id and must leave `apiKeyId` absent.

Test 13 is the one that would have caught this document's first draft, which
added the fields to both in-memory types and forgot that `addRequestLog`
reconstructs the persisted row (`src/server/request-log.ts:236-265`). Unit tests
on either half pass against that bug; only the round trip fails. Test 14 is the
activation scenario for the id-collision fix, and it fails against the sentinel
design this document originally proposed.

Test 12 is the activation scenario for `003` §3: it is the
only thing that keeps the shipped table honest, and it fails today against the
wrong GUI copy it replaces. Tests 7 and 8 are the durable-compatibility
activation: they drive the normalization branch that old rows take.

## Accept criteria

1. A request authed with a specific key is attributed to that key.
   **Activation:** tests 1–2; observable is the id on the emitted entry.
2. Responses and Chat Completions are distinguishable in the record.
   **Activation:** tests 1 and 3 in one run; observable is two different
   `inboundProtocol` values where `surface` is undefined for both.
3. Old usage rows still parse and gain nothing. **Activation:** test 8.
4. An unknown protocol value cannot enter the enum. **Activation:** test 7.
5. `GET /api/keys` degrades rather than failing when usage is unreadable.
   **Activation:** test 11.
6. The shipped auth matrix matches real server behavior. **Activation:** test 12,
   driving each cell.
7. Attribution survives to `usage.jsonl` and reaches the rollup.
   **Activation:** test 13, the full round trip.
8. Non-configured admissions never land in a key's bucket, even against a
   colliding id. **Activation:** test 14.
9. `attributionSince` is the earliest recognized-admission row, not the earliest
   configured-key row. **Activation:** test 22; observable is the environment
   row's timestamp.
10. A WS frame is attributed to the key that opened the socket. **Activation:**
   test 21; observable is the id on the per-frame row.
11. Attribution covers every authenticated logged route, not the protocol trio.
   **Activation:** tests 16–20, one per remaining route in the coverage table
   (compact, images, search, live/realtime, sideband); observable is `apiKeyId`
   and `admissionKind` on each emitted row. A criterion claiming full coverage
   while testing two routes is what the audit caught the first time.
12. Admission behavior is unchanged from `020`. **Activation:** re-run
   `tests/server-auth.test.ts` and `tests/data-plane-admission-identity.test.ts`.
13. `bun run typecheck`, `bun run privacy:scan`, and the named suites green.

## Risk

`privacy:scan` is a gate here, not a formality: this phase adds an identifier
derived from a credential to a durable log. It is the key's `id` — a UUID that
`GET /api/keys` already returns to any management client — never the key material,
and `admissionKind` carries no secret. That distinction is what makes the phase
acceptable, and the C gate states it explicitly rather than assuming it.

The second risk is silent breakage of the Logs tab: `RequestLogEntry` is served
to `/api/logs` through `requestLogDto`
(`src/server/management/logs-usage-routes.ts:126-134`, with display metrics added
in `src/server/management/shared.ts:143-161`) and consumed by
`gui/src/pages/Logs.tsx`. The new optional fields are additive and the DTO decides
whether they are exposed there at all — this unit does not require it. The C gate
runs the Logs GUI tests to prove the row shape did not break a consumer.

The third risk is the one the audit caught: a field added to the in-memory types
but not to the `addRequestLog` reconstruction looks correct in `/api/logs` and is
silently absent from every durable row. Criterion 7 exists for exactly that.
