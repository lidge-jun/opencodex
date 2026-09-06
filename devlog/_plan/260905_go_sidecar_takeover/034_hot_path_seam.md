# 034 — Ticket #24: hot-path seam + streaming differential harness

Unit: `260905_go_sidecar_takeover`
Date: 2026-09-06
Status: implemented on `fix/ticket-24-hotpath-seam` (dev-go + 2)
Ticket: [#24](https://github.com/waxiangzi/opencodex/issues/24) (spec #4: hot-path seam + streaming differential harness)
Blocked-by (#13/#16): closed — differential-oracle infrastructure and shared Go config parsing landed on `dev-go`.

## Scope discipline

#24 is the **substrate** ticket of the hot-path increment (#4), exactly as #13
was the substrate of the management read surface. It must NOT relay any real
provider traffic: the single-provider non-streaming relay (#27) and the SSE
streaming relay with frame parity (#29) are blocked *by* this ticket and own
that work. #24 therefore ships two things and nothing more:

1. A declared **hot-path seam** in the sidecar that a later ticket replaces
   provider-side without touching the front door again.
2. A **streaming differential harness** that compares ordered SSE frame
   sequences across two live servers and normalises only declared volatile
   fields.

## Design decisions

### 1. The seam is the same ownership pattern as the management surface, on the data plane

- `src/server/hot-path-seam.ts` holds the DATA (one declared seam route:
  `POST /v1/responses`), the independent activation gate
  (`OPENCODEX_GO_HOTPATH_SEAM`), and a core-owned forwarder slot shaped like
  `go-sidecar-slot.ts`. The route registry for the data plane is deliberately a
  separate module from `management/route-registry.ts`: #4 user story 10 gates
  the hot path separately from the management surface, and the management
  registry's types (`mutates`, session exemptions) do not apply to `/v1/*`.
- `go-sidecar.ts` registers the hot-path forwarder at activation only when the
  seam env is set — same ready-line handoff, same child-exit deregistration.
  A sidecar attached without the seam env forwards nothing and `/v1/responses`
  stays 100% in-process: the management surface can keep being migrated while
  the data plane is untouched, and vice versa (independent rollback, #4 story 13).
- Default install: no sidecar, no seam env → zero behaviour change, and the
  seam modules sit behind the same optional-subsystem rule as the Lab.

### 2. The sidecar's hot-path seam serves `/v1/responses` from the TS oracle until a provider relay lands

The seam handler in the sidecar (`go/internal/sidecar`) owns the *public
surface*: it authenticates the parent forward (request token), bounds the body,
and streams the response back. Its upstream today is a **private parent bridge**
(`/__ocx_go_sidecar/responses`) that runs the real in-process
`handleResponses` pipeline — byte-identical to a direct request because it IS
the same pipeline. #27/#29 replace the bridge as the seam's source per provider
without touching the front-door gate, the ownership data, or the harness.

Streaming contract: status code, `content-type` and the body are relayed
byte-for-byte in stream order. The Go side must never buffer or re-frame the
stream: the harness's whole point is that a dropped, reordered or duplicated
SSE frame fails the differential.

### 3. The bridge is authenticated with a body-bound parent claim, not client credentials

The front door resolves data-plane admission before the seam gate (same
`resolveResponsesApiAuth` as the direct branch). The client credential never
crosses the process boundary; instead the front door mints a short-lived HMAC
claim over `admission | method | path | expiry | sha256(body)` using the same
per-activation write-relay secret already inherited by the sidecar, and the
bridge verifies it with a bounded replay store. The threat model is the
established sidecar one: a local process that can read the sidecar's environment
is already as privileged as the proxy process itself.

### 4. Direct branch stays the oracle

Server A (no sidecar) and Server B (sidecar + seam env) both talk to the same
deterministic fixture upstream. The harness captures the client-visible SSE
frame sequence from each and asserts ordered identity after applying the
declared volatile set — for the first fixture, an explicit empty set (raw byte
identity), with per-request JSON paths added only if a live run proves them
legitimately request-scoped.

## Security boundary

- The bridge endpoint verifies the bridge token AND the parent claim; it never
  accepts an admin token or a client API key as a substitute (mirrors the
  `provider-quotas` and write-relay bridge endpoints).
- The sidecar seam route answers 404 unless the parent request token is
  present: the sidecar never invents a public data-plane listener of its own.
- No client credential, cookie, or browser header is forwarded past the front
  door in either direction.

## Proof

- Go unit tests: seam route auth, body bound, bridge URL validation, streaming
  passthrough of a synthetic fixture stream.
- `tests/go-hotpath-seam.test.ts`: differential oracle across two real servers
  (skip-if-no-Go, same guard as `go-sidecar-parity.test.ts`), comparing ordered
  SSE frames; a mutated fixture frame must fail.
- Existing suites stay green; `privacy:scan` stays green.

## Delivery notes (filled in at close)

Delivered on `fix/ticket-24-hotpath-seam` (two commits on top of `dev-go`):

- `src/server/hot-path-seam.ts` — seam data (route + env gate + bridge path),
  the body-bound parent claim (mint at the front door, verify at the bridge,
  bounded one-use nonce table), and the private bridge object. The Go sidecar
  never sees a client credential; it relays the claim verbatim.
- `go/internal/sidecar/hotpath.go` (+ tests) — the sidecar owns
  `POST /v1/responses`: parent-token 404 gate, 256MB body bound, bridge URL
  loopback validation, and byte-for-byte chunked stream relay with per-chunk
  flush (frame order preserved by construction).
- `src/server/index.ts` — bridge endpoint (404 when the seam env is off), the
  front-door seam gate inside the existing `/v1/responses` turn (default off;
  no in-process fallback after the body read, so a dead seam is a retryable
  502, never a double-executed model call), and activation wiring.
- `src/server/go-sidecar.ts` — data-plane seam attachment state and the
  seam forward hop, armed whenever the sidecar is attached and gated per
  request by the env, so flipping the env at runtime is honoured.
- `tests/go-hotpath-seam.test.ts` — the streaming differential: two live
  servers (in-process oracle vs seam) against one deterministic fixture
  upstream must agree on the ordered SSE frame sequence. Declared volatile
  set: the per-request trace header, `Date`, and the server CORS origin echo;
  the body volatile set is EMPTY (raw frame identity).
- `tests/hot-path-seam.test.ts` — claim/bridge unit coverage incl. replay,
  expiry, body-bound proof, oversized body, admission round-trip.

Acceptance criteria:

- [x] Hot-path seam exists in the sidecar (Go-owned `POST /v1/responses`
      surface with a replaceable bridge source for #27/#29).
- [x] Streaming differential compares ordered frame sequences (frame
      extractor + two-server oracle; reorder/drop classes proven non-vacuous).
- [x] Only declared volatile fields normalised (empty body volatile set;
      declared header volatile set; the harness asserts the declaration).

Verification: `go build/vet/test ./...`, `bun run typecheck`,
`privacy:scan`, and the four focused suites above are green. The repository
wide suite was attempted but stalled in this container on unrelated
OAuth/provider-management flakes (all six affected files pass standalone on
both this branch and `dev-go`); no seam-related file failed.
