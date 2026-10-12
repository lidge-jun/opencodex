# Protocol preservation implementation design

Depends on: reviewed roadmap. This cycle changes protocol mapping and observation, not connection reuse.

## File-change map

| Operation | Path | Exact change |
| --- | --- | --- |
| MODIFY | `src/adapters/openai-responses.ts` | Forward the genuine Lite header only inside the existing canonical forward gate; derive native routing metadata from `finalBody` after tier/model normalization, never blindly trust an inbound routing hint. Preserve genuine originator and selected auth override. |
| NEW | `src/codex/forward-transport-headers.ts` | Single pure owner of Lite header/key constants and final model/tier hint application; adapter and transport import it directly. No server/adapter/config imports. |
| NEW | `src/server/safe-response-headers.ts` | Move the pure safe-response-header projection here; both ws-bridge and WS metadata import it. Keep ws-bridge's existing export as a compatibility re-export. |
| NEW | `src/server/responses/codex-ws-request.ts` | Pure canonical request preparation described below; no config, auth-store, timer or network imports. |
| NEW | `src/server/responses/codex-ws-metadata.ts` | Pure, bounded native metadata-to-safe-header projection plus response-scoped observation ownership described below. |
| MODIFY | `src/server/responses/ws-upstream.ts` | Use prepared frame/headers; collect native prelude metadata before committing the synthetic Response; preserve late native metadata through the bounded per-response observer; preserve existing noncanonical behavior. |
| MODIFY | `src/server/responses/core.ts` | Capture a quota observer from the selected account before each native dispatch, including retries; pass it through providerFetch. Do not select credentials in the transport. |
| MODIFY | `src/server/responses/fetch-helpers.ts` | Add optional `onCodexWsQuota(headers)` to ProviderFetchOptions and pass it to the canonical WS exchange before opening/sending. |
| MODIFY | `src/server/ws-bridge.ts` | Reuse the safe native header projection without introducing a transport-to-adapter import cycle; preserve `safeResponseHeaders` export. |
| MODIFY | existing transport and metadata test files | Add independently specified positive/negative fixtures and actual dispatch-path assertions. |
| MODIFY | `structure/04_transports-and-sidecars.md` and English provider/server reference as needed | Describe HTTP ingress, canonical mapping, metadata fidelity, and unchanged third-party policy. |

## Request preparation contract

The transport entrypoint keeps its existing signature and adds only optional scoped context where required; old direct callers remain one-shot compatible. Before dialing, preparation parses the existing outbound JSON once and returns `{ frameText, headers }`, or the existing HTTP fallback for an unparseable body.

Canonical URL equality is the authority (`https://chatgpt.com/backend-api/codex/responses`), not model-name resemblance or arbitrary `authMode`. Noncanonical opt-in WS receives its current serialization and no synthetic OpenAI header/metadata.

Before/after at the existing seam:

```ts
// before
delete body.stream;
frameText = JSON.stringify({ ...body, type: "response.create" });
// after (pure preparation owns mapping and preserves the caller's body)
const prepared = prepareCodexWsRequest(url, init);
if (!prepared) return sseFallback(url, init);
const { frameText, headers } = prepared;
```

`prepareCodexWsRequest(url: string, init: RequestInit)` owns these exact operations:

1. Validate the parsed top-level JSON record. Copy it; omit only the HTTP `stream` field and overwrite `type` with `response.create`.
2. Remove HTTP body-framing headers from WS handshake, as today. Preserve genuine originator/selected auth and existing beta composition; never invent a Codex CLI identity.
3. On canonical requests, translate an explicitly true/false Lite HTTP header to the corresponding string value in a copied `client_metadata` record. An explicit header is authoritative over a conflicting WS metadata value; absent header preserves an existing metadata value. Malformed metadata remains a boundary failure/fallback, not a coerced truthy value. Preserve all unrelated metadata. Do not synthesize `reasoning.context` or tool-layout changes.
4. For canonical requests, derive `x-codex-routing-hint` from the final JSON `model` and optional final `service_tier`. Reject control/delimiter injection in hint components; an unusable component must not let an inbound stale hint choose another model/tier. The request itself remains subject to the existing model validator/upstream error contract.
5. Measure the final frame including synthesized metadata against the existing byte ceiling. The oversized path invokes the same HTTP fallback with its HTTP Lite header and protocol pin intact; no WS send occurs.

The HTTP fallback retains a correctly derived canonical routing hint. The single pure `applyCodexRoutingHint(headers: Headers, body: unknown): void` owner is `src/codex/forward-transport-headers.ts`: it first deletes any existing hint, then emits only for a record with a nonempty model and optional tier consisting of printable ASCII without `;`, `=`, or whitespace (maximum 256 model bytes and 64 tier bytes). Absence of tier produces only `model=...`; malformed tier omits the hint entirely. The canonical adapter calls it after finalBody normalization, before returning its HTTP request. `prepareCodexWsRequest` uses the same helper for standalone transport callers and returns `{ frameText, headers, httpInit }`; `httpInit` is a copy with the final canonical hint and original HTTP body/framing/Lite header. All WS fallback paths use that copy. Neither helper synthesizes originator/User-Agent.

Import direction is adapter -> pure `codex/forward-transport-headers`, WS request helper -> same pure owner, WS metadata -> pure `server/safe-response-headers`, and ws-bridge -> pure safe-header owner. Neither new pure module imports adapter/ws-bridge/core/config, so the existing ws-bridge -> adapter edge cannot form a new cycle.

## Response metadata contract

The new pure metadata module accepts a parsed provider event and returns only validated safe header updates. It has no imports of config/auth APIs. Parsing is at the untrusted event boundary; subsequent consumers receive a typed snapshot.

- `codex.rate_limits`: map finite nonnegative percentages and integer windows/reset timestamps to native `x-codex-*` families. Preserve the primary/secondary distinction. Map bounded additional families with sanitized names; unknown/malformed families do not overwrite the ordinary Codex window. Map only documented credit/promo fields when their expected type is present.
- `codex.response.metadata`: copy only the established safe response header set plus native safety-buffering metadata that the reference client consumes. Drop authorization, cookies, hop-by-hop/content-length fields and unknown header names. Never spread arbitrary upstream headers into the HTTP response.
- Keep metadata frames within the existing raw/enveloped byte limits. Cap accumulated prelude/header bytes and family count; malformed or excessive metadata follows the bounded stream-error policy.
- Resolve the canonical synthetic Response when the first Responses/error frame arrives, after earlier metadata is reflected in its headers. A connection that opens but supplies no response remains covered by the caller's header deadline; do not add an unbounded open-but-unresolved state.
- A provider `error` frame is not a completed response. Preserve its existing structured error/status semantics and never replay inference merely because an error preceded the first output.
- Every ordinary quota update notifies the attempt's observer synchronously when received. That observer is captured before opening/sending; there is no late attachment, replay ledger or freshness-stamp reconstruction. Only newly observed ordinary window fields are passed, not the accumulated HTTP header snapshot. Clear the callback on terminal/cancel/error. Metadata-only and additional-family events never refresh ordinary account usage.
- Do not invent a late HTTP header update after headers have been committed. Forward supported metadata events for consumers that understand them and update the proxy's selected-account state separately; the HTTP header snapshot represents the prelude only.

Proposed observation interface (creation -> use chain):

```ts
type CodexWsQuotaObserver = (headers: Headers) => void;
// ProviderFetchOptions.onCodexWsQuota -> optional fifth WS transport argument
// -> CodexWsMetadata constructor -> synchronous ordinary-quota event callback.
```

Creation: core captures selected accountId/writerGeneration/mainQuotaWriter before dispatch. Serialization: callback is process-local only; safe snapshots become HTTP headers/SSE. Deserialization: native event parser validates once. Consumers: existing quota header writer called at receive time, and HTTP clients consume the prelude header projection. Native direct mode without a stored account has no proxy quota observer. Noncanonical/HTTP fallback has no WS observer marker. No new quota timestamp API or stored-quota merge policy is introduced.

### Exact post-send settlement

Keep independent booleans `sent` and `responseCommitted`. The stream/controller exists before calling `send`, so synchronous event delivery cannot race initialization. A successful `send` establishes `sent=true`; a synchronous exception follows existing proven-no-send HTTP fallback. Canonical response commitment waits until the first ordinary Responses/error event, or a failure requiring commitment. Noncanonical behavior remains immediate commitment on open.

After `sent=true`, prelude overflow, socket error/close, or initial-response timeout MUST resolve a marked synthetic HTTP-200 SSE Response and error its body, even if no Response was committed yet. Never reject with a reset-shaped fetch error or manufacture a 5xx status in this state: the outer `fetchWithTransientRetry` must receive a non-retryable stream failure and issue zero HTTP resends. Before send, abort rejects with the original abort reason and upgrade/send failure retains the existing one-shot HTTP fallback. If an abort occurs after send, commit the Response if needed and error its body with that abort reason. The caller's abort remains authoritative in the downstream existing terminal mapper.

Introduce `CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS = 30_000` for direct callers without a shorter header deadline; start it after send and clear it when the Response commits or the exchange ends. The existing 10s upgrade timer stays separate. Timeout is an exchange failure, never a retransmit. Existing open-only abort tests must trigger abort before awaiting the pending fetch and then inspect the errored body; add an outer retry-wrapper fixture proving one WS send and zero HTTP resends for close, timeout and metadata overflow.

### Exact metadata projection

Constants: `CODEX_WS_METADATA_MAX_BYTES = 32 * 1024`, `CODEX_WS_METADATA_MAX_FAMILIES = 16`, `CODEX_WS_METADATA_MAX_HEADERS = 128`, `CODEX_WS_METADATA_MAX_VALUE_BYTES = 4096`. Count final UTF-8 header name/value bytes and raw prelude metadata bytes; N+1 fails the stream, never silently truncates an authoritative snapshot. Individual invalid values are omitted without coercing null/empty to zero. Header values cannot contain CR/LF/NUL.

| Event field | Header | Consumer/disposition |
| --- | --- | --- |
| `rate_limits.primary/secondary.used_percent` | `x-<family>-primary/secondary-used-percent` | native header parser and existing selected-account quota parser; finite number >=0, preserve values >100 for existing policy handling |
| corresponding `window_minutes` | `x-<family>-primary/secondary-window-minutes` | finite nonnegative safe integer, no unit guessing |
| corresponding `reset_at` | `x-<family>-primary/secondary-reset-at` | nonnegative safe integer seconds |
| `metered_limit_name`, else `limit_name`, else `codex` | family segment, normalized lowercase `_` -> `-` | `[a-z0-9-]`, max 64 bytes; malformed identity drops that family, never falls back to `codex` |
| `credits.has_credits`, `credits.unlimited` | `x-codex-credits-has-credits`, `x-codex-credits-unlimited` | booleans only; native HTTP parser |
| `credits.balance` | `x-codex-credits-balance` | bounded string only, not converted to zero |
| `plan_type`, `allowed`, `limit_reached`, code-review fields, top-level `promo`, nested `additional_rate_limits` | none | no equivalent in the inspected native WS-event parser; preserve original bounded event only, no inferred HTTP status or speculative nested-family projection |
| `codex.response.metadata.headers` | safe-header whitelist | etag, model, turn-state, reasoning and safe native safety-buffering headers; unknown/auth/cookie/hop-by-hop fields omitted |

The pure safe-header owner retains current exact names and quota family pattern and explicitly adds the three credit headers, promo and native safety-buffering header names. Promo is accepted only as a documented `x-codex-promo-message` metadata header, not synthesized from a top-level event property. Event family header projection is limited to `codex` or `codex-<safe suffix>` so it agrees with the existing native safe-header family; other metered ids remain in the bounded raw event but are not silently collapsed to codex. Ordinary codex headers feed the selected-account parser; supported extra codex-family headers feed native HTTP clients but do not become the proxy's ordinary quota bar. Server metadata is projected to HTTP headers before commitment; the original `codex.*` event is not itself claimed to update the stock HTTP client. `response.metadata` remains its own original event; never rename a control frame to it.

### Exact account-observer binding

Core's `codexWsQuotaObserver(authCtx, provider)` checks the existing canonical pool/main-pool predicate and captures immutable accountId/writerGeneration/mainQuotaWriter; the returned function calls the existing `applyAccountQuotaFromUpstreamHeaders`. It is created in six `providerFetch` constructions: alternate-account model/quota retry uses `retryAuthCtx`; initial native dispatch, opaque/rebuilt replay, shared stored/main-401 replay, generic OAuth replay and key-provider 429 replay use their current `authCtx`. The last two produce no observer when noncanonical/ineligible. Each fresh providerFetch receives the callback before its WS transport runs; no closure reads mutable authCtx later. Other providerFetch callers remain unchanged and one-shot/no-observer.

The WS Response is marked in a WeakSet only when its canonical exchange had an observer installed. Core skips its old post-fetch quota-header write for this marker because events already updated state; HTTP fallback and unmarked responses retain the original header write. Metadata callbacks are cleared on terminal/cancel/error and never migrate across retries. Intermediate failed attempts may update THEIR serving account immediately; they cannot donate response-specific metadata to a later response.

Fixtures MUST use real pool/main-pool selection and cover ordinary primary+secondary followed by secondary-only before response consumption, etag/credit/extra-family interleaving with a newer account update, failed attempt then alternate account, and no update after terminal. This exercises arrival order directly, without synthetic receive-time stamps or late replay.

## Reachable acceptance scenarios

1. HTTP Lite true reaches the WS key; native WS metadata survives absent HTTP header; explicit false beats true; unrelated metadata remains byte-equivalent.
2. Body model/tier after route override determines the hint; stale inbound hint cannot win; invalid delimiters do not produce a forged hint.
3. Noncanonical opt-in Responses WS gets neither synthetic native hint nor native event interpretation.
4. Quota + metadata prelude followed by `response.created` is visible in returned HTTP headers and the selected-account cache; late quota reaches the same captured owner.
5. First-frame error, abort before open, abort after open/before prelude, abort after headers, malformed/oversized metadata and response frame overflow settle exactly once with no extra send.
6. HTTP fallback caused by runtime/version/upgrade/frame ceiling retains its original method/body/headers and remains unmarked as WS.
7. Full `handleResponses` fixture traverses real adapter -> fetch wrapper -> fake WS -> eager relay; metadata observation is not a helper-only test.

Focused baseline command and known existing skip are recorded in `000_plan.md`. Extend those existing files; add explicit layout registrations only if a new test file becomes necessary. Typecheck/privacy/secret scan and coordinated full verification precede review-ready/merge.

B test placement refinement: reuse `tests/responses/responses-account-label.test.ts` and its existing isolated `withPoolHome` fixture for the pool/main-pool metadata-order scenarios. This exercises actual auth selection and cache writers instead of mocking the selected-account gate. The original transport file remains responsible for byte limits, frame order and no-resend behavior.

### B review amendment: simplify observation placement

Two failed partial-window repairs exposed the wrong abstraction: reconstructing freshness after the selected-account consumer attaches late creates an unnecessary second merge policy. Replan to attach the immutable callback before dispatch, when the selected account is already known. Remove the uncommitted `quota-observation.ts` and all proposed `quota.ts` timestamp changes. Existing quota merge semantics remain untouched. Keep the independently verified atomic header-window replacement and pre-refusal HTTP hint normalization fixes.

## Structural and review notes

The existing WS source is 462 lines. Extract pure mapping responsibilities before adding them; lifecycle extraction in the next cycle must keep new modules under 400 lines. Do not refactor unrelated adapter/catalog behavior. Existing `ws-bridge` safe-header export remains compatible even if its pure owner is extracted. No novel enforcement claim: checks enforce wire/resource invariants inside this process; they do not establish provider billing behavior.

## Prior integration verification amendment

The original protocol checkpoint is `a04d1295be91776341ca2ffbebb37d6b640fffc8`; its successful CI run `33955395317` covers the earlier integration base `6b85485f32f783bafc61c79185d0cb937848859d`. Preserve that commit and its evidence as historical proof, not as validation of a later integration tree.

Integrate the published `dev` checkpoint `cfe95eea0f776a5a5d5bad5f41408cd98ba98ff7` once using a normal merge in the existing branch. The read-only merge preview has no conflicts or changed-file intersection with the protocol patch; this is only integration preparation, not a CI result. No runtime protocol changes, lifecycle work, frontend transport changes, installation changes or dependency refresh are planned in this amendment.

The build step adds only this plan amendment and the upstream integration. Compare every original protocol runtime/test file with `a04d1295`, record the integrated head and tree, and obtain an independent static integration review. Any substantive conflict or changed protocol behavior returns to planning rather than accepting a mechanical conflict resolution. Run the focused protocol checks, typecheck, privacy check and isolated HTTP-to-WS QA at the new committed head; retain the original receipts separately. Push the new head once with `--no-verify` and run fresh coordinated CI.

Landing requires green current-head CI, no valid unresolved review findings, and an unchanged verified integration tree. Use the authorized admin merge-commit method with an exact-head guard, compare the actual merge tree, fetch `dev` and prove the merge commit is its ancestor. Complete the serialized post-merge `dev` CI before returning the verification slot. Connection lifecycle/reuse remains the separate, unstarted next work-phase.

## Current integration and delivery

The prior integration head `8166ae508b9c64d1df811460144c96f16df32976` retained the original protocol runtime/test bytes and passed focused checks, but CI run `33960595165` was cancelled when one macOS job exceeded its bound. Preserve that result; neither a standalone non-reproduction nor an invalid diagnostic establishes its cause or closes it. No production fix, test skip, assertion weakening or timeout increase is justified by that incident.

The pre-push base guard stopped the `9086c447` candidate when published `dev` advanced from `45f3bed84be10a7e045a20aae1db46ab822bf7d0` to `09335d7d451335a74ad1c02e88ee37ef89f5a007`. Its remote145-test/typecheck/wire-QA pass remains historical evidence. The additional seven paths extract CLI status probes and update their tests/documentation; they do not overlap the protocol files. Revalidate the final integration using the latest published checkpoint before the next push; if that checkpoint changes, compare the new delta and refresh source-bound verification rather than reusing an older tree's result. Keep all original protocol runtime/test files unchanged unless a separately demonstrated protocol defect requires a new repair plan. This is required integration work, not a claim to repair the earlier CI stall.

Delivery is now self-directed without peer-task messaging. Observe active CI runs directly, perform an explicit main integration/security audit, retain the earlier independent protocol reviews, and check current automatic PR findings. Remote focused verification uses disposable source and correctly located private dependencies with a dependency-resolution preflight; setup errors stop the run immediately. Do not modify the existing remote checkout, installation or service. The exact-head full-CI, guarded admin merge, actual-tree comparison, fetched ancestry and post-merge verification gates above remain mandatory. Lifecycle work still follows protocol landing.
