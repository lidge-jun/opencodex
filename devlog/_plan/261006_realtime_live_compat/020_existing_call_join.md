# Diff plan: authenticate ExistingCall joins as the call owner

## Behavior

A native sideband join (`/v1/live/<id>`, `/v1/realtime/calls/<id>`, `/v1/realtime?call_id=<id>`) is split by who created the call:

- The call was created through this opencodex process (native `POST /v1/live` or `/v1/realtime/calls` returned a Location naming it): unchanged. Pool selection and thread affinity choose the account, as the #35830 case requires.
- Otherwise the client created the call with its own ChatGPT login (V3 `existingCall`). When the caller presents an explicit ChatGPT bearer whose token claim matches its `chatgpt-account-id` and passes forward-admission validation, the join carries the caller's own credentials, exactly as Codex Direct mode does. Without such a caller credential the current behavior stays.

Standalone sessions (`/v1/live?model=`, `/v1/realtime?model=`) and the external audio-key path are untouched.

## Changes

1. `src/providers/openai-sidecar.ts`: export `resolveCallerOwnedOpenAiSidecar(candidates, incomingHeaders, config, { admission })`. It returns the first forward candidate with `authContext: { kind: "main", accountId: null }` and `directSidecarHeaders(...)` when the caller credential is explicit, forwardable (`validateForwardAdmissionCredential`) and a Codex bearer; otherwise `undefined`. Materialization keeps the existing main-account hard-lock and credits checks, whose errors extend `CodexAccountCooldownError` and are already mapped by `resolveLiveRelay`.
2. `src/server/live-native-calls.ts` (new, small): bounded process-local set of upstream call ids created through the native call-create path. `recordNativeLiveCall(location)` extracts the call id the way Codex does (`decode_call_id_from_location` in `codex-rs/codex-api/src/endpoint/realtime_call.rs`: drop the query, scan path segments from the end, take the first `rtc_<nonempty>` or 36-character hyphenated UUID), bounded to the join grammar of 128 characters; entries expire after six hours, at most 1024 are kept, oldest evicted first; `isNativeLiveCall(id)`; `clearNativeLiveCallsForTests()`. Ids only, no account or credential.
3. `src/server/live.ts`:
   - `handleLive`: after a 2xx upstream response, record the Location.
   - `LiveScopeDestination` gains `callerOwnedCallId?: string`.
   - `resolveLiveRelay`: when `callerOwnedCallId` is set and not a native call, try `resolveCallerOwnedOpenAiSidecar` first inside the existing `try`; if it returns a sidecar, use it as `forward` (no Pool selection, no outcome recording against a Pool account). Otherwise fall through to the current selection.
   - `resolveLiveSidebandUpgrade`: pass `callerOwnedCallId` for the three join styles.
4. `tests/server/server-live-existing-call.test.ts` (new sibling; `server-live.test.ts` has 16 lines of ratchet headroom), Pool mode with two accounts and round-robin:
   - a join for a call never created through opencodex reaches the upstream with the caller's `authorization` and `chatgpt-account-id` and the session/thread headers, on all three join forms;
   - a call created through opencodex (API `/v1/live/<id>` Location and backend `/v1/realtime/calls/calls/<id>` Location) keeps the Pool account on join;
   - no caller bearer keeps the current Pool selection; a claim/header account mismatch and the proxy admission secret as bearer are refused with 401 before any upstream dispatch, as today;
   - an active main-account hard lock refuses the caller-owned join (cooldown response) without falling back to a Pool account;
   - a configured key with a provider scope that excludes `openai` is refused on the caller-owned branch, as on the Pool branch;
   - the caller-owned join records no Pool outcome.
   `tests/server/live-native-calls.test.ts` (new): Location extraction for API, backend (`/calls/calls/<id>`), UUID, query, trailing-slash and trailing-suffix shapes and rejection of malformed values; TTL expiry, oldest-first eviction at capacity, and clear, with an injected clock. Both files registered in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`. The #35830 case stays as the regression guard for opencodex-created calls.
5. Docs: `structure/data-planes/inbound-compat.md` (admission paragraph: a native join now consults call-id membership, still no model/account binding; streaming-audio section: the ownership rule); review the `src/providers/` and `src/server/` owner docs from `structure/INDEX.md` and update only those whose explanation changes; `docs-site/src/content/docs/guides/codex-integration.md` voice paragraph gains the client-created call case, and translated locales are checked for contradiction.

## Risks

- Continuity for opencodex-created calls now depends on the call id being retained: a restart, six-hour expiry, or eviction past 1024 calls turns it into an unknown call, and a later rejoin then carries the caller's credentials. The relay socket does not survive a restart, joins happen right after create, and the effect is limited to Pool users whose caller account differs from the creating account. Persisting call-to-account bindings is broader scope and not needed for the #35830 contract.
- Model/provider admission scope still runs after either resolution; a native join still names no model, so model-scoped keys stay denied for joins as today.
- Explicit security review is required on the PR (credential selection).
- The caller bearer is forwarded only to the canonical sideband root or the configured `experimental_realtime_ws_base_url`, the same destinations that already receive Pool bearers.
- No local test run (user instruction); hosted CI is the verifier.
