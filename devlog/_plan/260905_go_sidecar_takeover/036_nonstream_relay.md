# 036 — Ticket #27: non-streaming relay + response repair for one provider

Unit: `260905_go_sidecar_takeover`
Date: 2026-09-06
Ticket: [#27](https://github.com/waxiangzi/opencodex/issues/27) (spec #4: non-streaming relay + response repair for one provider)
Blocked-by (#24): closed — hot-path seam + streaming differential harness landed on `dev-go`.

## Scope discipline

#27 is the first **provider relay** ticket of the hot-path increment (#4): it
replaces the #24 private parent bridge as the seam's stream source for ONE
provider class on ONE transport shape. It must NOT relay streaming traffic
(that is #29), must NOT reproduce routing decisions beyond an unambiguous
single-provider subset (that is #30), and must NOT port every response repair
(that is #31). Everything outside the declared relay subset keeps the #24
bridge, so the TypeScript oracle continues to serve it byte-identically and the
differential never compares a class the seam does not claim.

The relay subset is deliberately narrow and is machine-pinned by the
differential plus the Go unit suites:

1. **Transport**: non-streaming (`stream` is not `true`) `POST /v1/responses`.
2. **Provider**: one key-mode `openai-responses` provider whose Responses wire
   needs no translation — the TS pipeline forwards the client request body
   verbatim upstream (verified empirically for the simple-completion subset:
   plain input, input arrays, declared function tools, reasoning effort, and
   both the `configured-model-list` and `default-provider` route kinds). The
   sidecar reproduces that forward byte-for-byte, including the provider
   `Authorization` when an env/literal `apiKey` resolves. OAuth/forward,
   keychain keys, custom `responsesPath`, combos, routing profiles, shadow
   intercept and model namespace (`a/b`) requests never qualify — they stay on
   the bridge.
3. **Repair**: the whole-body JSON response repair the TS pipeline applies to
   bounded-JSON Responses answers (the field backfill: message/reasoning/call
   item `id` synthesis, message `status` backfill, `output_text.annotations`
   backfill) runs in Go on the relayed 2xx response. #31 later generalises this
   into the full ordered repair chain for every rewrite; #27 owns the one
   deterministic JSON transform that the bounded-JSON path applies today.
4. **Errors**: a non-2xx upstream answer with a non-empty body is relayed
   verbatim (status, content-type, body) exactly like the TS passthrough; a
   valid upstream `Retry-After` is preserved, an invalid one is dropped.
   TS-only error surface — synthetic `Retry-After` defaults for 429s, empty-body
   error envelopes, quota/cyber-policy classification, and pre-stream retry
   loops — is NOT ported here: those are recovery semantics owned by the
   routing ticket (#30) and remain a documented seam-period divergence.

## Design decisions

### 1. The relay rides the #24 seam behind its own env gate

`OPENCODEX_GO_HOTPATH_RELAY` (declared in `src/server/hot-path-seam.ts`, read
by the sidecar) switches the seam's source for qualifying requests from the
bridge to the direct upstream relay. Default OFF: a default install — and any
install that has not proven a provider against the differential — is unchanged.
Independent rollback per spec #4 story 13: the management surface, the seam,
and the provider relay each carry their own gate.

The gate is evaluated per request inside `dataPlaneSeam` AFTER the existing
front-door claim checks (the request token is still required; the seam still
never invents a public listener). A request that does not qualify falls through
to the bridge exactly as in #24, so the fallback is per-request, not global.

### 2. The relay-safe predicate is a config + request contract

Go claims a request only when it can prove the TS pipeline would forward it
verbatim and repair only the backfill:

- Config-level refusals (bridge): combos table present, routing profiles
  present, `shadowCallIntercept.enabled`, provider `authMode` not key-mode,
  provider `apiKey` is a `keychain:` reference, custom `responsesPath`,
  provider `adapter` not `openai-responses`, disabled provider.
- Route-level: the requested model (no `/`) must resolve through the TS simple
  subset — a single enabled provider owning the model via `models` /
  `defaultModel`, else the sole configured `defaultProvider` — mirroring
  `routeModelInternal`'s `configured-model-list` /
  `configured-default-model` / `default-provider` kinds in file order.
- Request-level: body is a JSON object; `stream` is not `true`; `model` is a
  string; the body has none of the features that make TS rewrite the outbound
  bytes or engage request-local state (`previous_response_id`, compaction
  markers, namespaced/hosted tool entries, web-search/image/video plans); no
  Codex pool/sub-agent/attestation headers on the request.

The predicate is exercised by the differential matrix and by unit tests that
assert each refusal reason; the seam's honest fallback means a wrong refusal
costs parity (bridge still serves it), never correctness.

### 3. Outbound request = the #24 openaiResponsesUrl contract + verbatim body

The relay builds `POST <baseUrl-normalized>/v1/responses` with the same
path normalization as `src/adapters/openai-responses-url.ts` (strip trailing
slashes / `/responses` / `/v1`, append `/v1/responses`), forwards the seam
request's body bytes verbatim, sets `content-type: application/json`, and adds
`Authorization: Bearer <key>` when the provider `apiKey` resolves through the
env (`${NAME}` / `$NAME`) or a literal. Loopback/private base URLs honor
`allowPrivateNetwork`; the request never goes through a system proxy (mirrors
the bridge transport). Keychain resolution is refused (bridge) because the
sidecar has no keychain access.

### 4. Response = transport fidelity + the bounded-JSON backfill in Go

For a 2xx JSON answer the relay applies the field backfill to an ordered JSON
tree and re-emits only when a field changed — byte-identical untouched
payloads (raw relay) and canonical re-serialisation on change, exactly like
the TS bounded-JSON path. The ordered tree and the ECMAScript
`JSON.stringify` encoder (string escaping, key order, V8 number formatting)
live in a new `go/internal/jsonwire` package; the transform mirrors
`src/server/responses/responses-field-backfill.ts` and its observed byte
behaviour, pinned by Go unit tests against golden payloads captured from the
TS oracle (message/reasoning/function/custom-tool id synthesis with
`<prefix>_ocx_<index>`, `status` inference from the response status, and
`annotations: []` on `output_text` parts).

Non-JSON 2xx and non-2xx non-empty bodies are relayed verbatim with the
upstream content-type; valid `Retry-After` passes through.

### 5. Proof that Go (not the bridge) served a claim

The Bun differential asserts the fixture upstream sees the seam-served
request arrive from the Go process (`User-Agent: Go-http-client/…`) while the
in-process oracle's identical request arrives from Bun, and that both requests
carry the same method/path/content-type/`Authorization`/body. A gate-negative
request (e.g. `stream: true`) must arrive from the bridge (Bun UA), proving
the fallback still owns non-qualifying traffic. The Go seam unit suite proves
the same without a bridge: the seam answers a qualifying request while the
parent bridge is a dead port.

## Security boundary

- The relay activates only behind the existing seam request-token gate; it
  adds no public listener and never reads a client credential — the front
  door's body-bound claim headers are relayed to the bridge only, never to the
  provider upstream.
- The provider API key is resolved from the config/env the operator already
  trusts the sidecar with (the sidecar is a child of the proxy process);
  keychain material is never requested (bridge instead).
- Outbound destinations are validated: only the configured provider base URL,
  honoring `allowPrivateNetwork`; no proxy, no userinfo, loopback-only for the
  fixture.

## Proof (as landed)

- `go/internal/jsonwire` unit tests: V8 number formatting against a committed
  Bun-generated corpus (`testdata/v8-numbers.tsv`, 447 rows incl. exponent
  window edges and random finite doubles), ECMAScript string escaping
  (control escapes, literal U+2028/U+2029, no HTML escaping), ordered
  round-trip / spread-set semantics, and number canonicalisation through
  `Encode`.
- `go/internal/sidecar` field-backfill unit tests against committed goldens
  produced by the REAL TypeScript repair
  (`testdata/responses-repair-goldens.json`, 27 shapes: sparse message
  canonical order, response-status → message-status mapping incl.
  failed→incomplete / queued→in_progress, id namespace prefixes,
  empty-string and non-string id replacement in place, compaction exclusion,
  raw-bytes identity when nothing changed, number-literal canonicalisation on
  change, U+2028 handling, key order).
- `go/internal/sidecar` relay unit tests: relay-safe predicate (every refusal
  reason named), the seam direct relay with a dead bridge (proves no bridge
  hop), outbound verbatim body + path + resolved `Authorization`, valid
  `Retry-After` preserved / invalid dropped on a verbatim non-2xx relay,
  oversized-body bound, streaming and gate-off requests staying on the
  bridge.
- `tests/go-hotpath-relay.test.ts`: two-server differential over the
  non-streaming matrix (plain input, tools array, reasoning, default-provider
  fallback, plus a streaming refusal), where each armed-relay response equals
  the in-process oracle byte-for-byte, the fixture upstream proves direct
  serving via `User-Agent: Go-http-client/…` for relay-admitted requests and
  Bun for refused/gate-off ones, and the relay gate off keeps every request
  on the bridge.

## Delivery notes (filled in at close)

- Landed as a feature commit plus a "Merge ticket #27 …" merge on `dev-go`;
  no PR (repository convention). TS `typecheck`, the focused suites
  (`tests/go-hotpath-seam.test.ts`, `tests/go-hotpath-relay.test.ts`),
  `go test ./...` and the full TS suite are green; `privacy:scan` is green.
- Seam-period divergences, all documented and owned by later tickets:
  pre-stream retry loops, synthetic 429 `Retry-After`, empty-body error
  envelopes, quota/cyber-policy classification, streaming relay (#29),
  routing/combos/namespace handling (#30), full repair-chain parity (#31).
