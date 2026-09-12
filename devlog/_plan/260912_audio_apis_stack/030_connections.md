# Connections audio controls and PR publication

Depends on wp2 completed audio routes. The first two layers remain independently usable through external client examples.

P revalidation: wp2 D concluded functional audio tests and source reviews PASS at
011f2dff5c, with unrelated journal failures recorded separately. Follow that
direction without expanding baseline repairs. C4 because transient credentials
cross the browser/data-plane boundary. Main owns implementation; inherited
architect and independent reviewers remain read-only. No additional cost/time
budget was imposed. No paid calls, personal audio, service changes or merge.
Local product suites/typecheck/build/install are prohibited. Existing remote CI
runs the checks; browser QA reads its built artifact with synthetic routes only.

## File changes

| Operation | Path | Contract change |
| --- | --- | --- |
| MODIFY | src/server/management/api-access.ts | extend ApiAccessEndpoints with transcription, dictationStream, live and realtimeCalls URLs plus truthful capability metadata |
| EXISTING | src/server/management/oauth-account-routes.ts | /api/keys already serializes ...endpoints; no new route or management authority |
| MODIFY | tests/server/api-access-endpoints.test.ts | URL host/protocol and capability projection tests |
| MODIFY | gui/src/pages/api-keys-utils.ts | extend endpoint type/default/derive chain for new endpoints |
| MODIFY | gui/src/pages/ApiKeys.tsx | consume serialized endpoint metadata through KeysResponse, CachedKeysShape, cache validation and fetchKeys |
| MODIFY | gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx | place two unframed audio sections in existing Connections/API layout |
| NEW | gui/src/components/apikeys-workspace/AudioApiPanel.tsx | accessible Dictation and Live Voice controls, endpoint/model display, sample copying, transient key/file controls and result/error states |
| NEW | gui/src/audio-api-client.ts | bounded cancelable upload and socket client protocol helpers; no saved secrets |
| MODIFY | gui/src/api.ts | narrow audio upload fetch entry bypasses management auth injection/recovery, validates exact inference path |
| NEW | gui/tests/audio-api-client.test.ts | request generation, cancellation and protocol readiness tests |
| NEW | gui/tests/audio-api-panel.test.tsx | real component upload, error, cancellation, missing metadata and deactivation flows |
| MODIFY | gui/src/i18n/en.ts and every locale module | complete localized label/status/action keys |
| MODIFY | gui/src/styles-apikeys-workspace.css | restrained aligned responsive audio sections using existing tokens |
| MODIFY | structure/gui-and-management-api.md | metadata and control ownership/current contract |
| MODIFY | docs-site/src/content/docs/reference/proxy-formats.md and localized counterparts | final client examples and explicit protocol support |

## Before / after contracts

Before: ApiAccessEndpoints contains Responses/chat/messages/models only. After: backend generates audio endpoints from the same resolved base, converts HTTP->WS and HTTPS->WSS with URL APIs, and reports configured availability separately from runtime-proven connectivity. GUI consumes these fields, with a conservative unavailable/unknown fallback for older servers.

Metadata fields complete chain: creation buildApiAccessEndpoints -> JSON management response -> API page validation/mapping -> ApiEndpointInfo/AudioApiPanel. Defaults cannot claim configured availability. No new provider is registered and no audio model enters a text completion test.

The optional `audio` projection has transcriptionEndpoint, dictationStreamEndpoint,
liveEndpoint, realtimeCallsEndpoint, transcriptionModel, liveModel,
transcriptionConfigured, dictationConfigured and liveConfigured. URL/model strings
and booleans are validated on both network and cached payloads; endpoint origins
and paths must match the published base after WS-to-HTTP normalization. Missing
or invalid audio metadata leaves the audio controls unavailable, while existing
key management keeps working. Configuration flags use canonical enabled provider
configuration only, never credential resolution, account reads or a network probe.
File transcription accepts canonical ChatGPT or configured OpenAI API routing;
dictation/live GPT-Live flags require canonical ChatGPT routing (an API-key-only
configuration does not prove access to the Codex live model).

Dictation section contains model and endpoint copy actions, file input, transient API key input, transcribe/cancel, text result/copy and clear error states. Stream example names extension protocol and gives start/audio/close events. Live Voice section contains actual GPT-Live model and both WS/WebRTC connection endpoints, transient client key, a connect/disconnect test with status and observed event output. Browser WebSocket auth must use a short-lived local session mechanism or supported client protocol carrier; never expose ChatGPT credentials or persist raw keys. Do not create a fake success check or billable background probe. All test actions require a deliberate user click.

UI is unframed and follows existing workspace colors/type/spacing. Icons reuse gui icons, all visible text is localized. At desktop and mobile widths long endpoint text wraps or scrolls within its own element without overlapping controls. Buttons have stable dimensions and stateful controls are keyboard reachable.

Pass the existing active flag through ApiKeysWorkspace. Integrations hides panels without unmounting; conditionally unmount just audio controls when inactive, preserving the rest of the workspace drafts. Requests, sockets and timers stop on deactivation, origin change and unmount. Existing key rows contain only prefixes: controls use an explicitly entered transient key, never pretend a key ID can authenticate. Key edits cancel pending work. Browser voice connection uses the OpenCodex-only WebSocket protocol credential carrier accepted solely by the audio routes; exact supported carrier and precedence are documented/tested in wp2. No persistent key or query authentication. Raw upstream messages are not rendered: show localized error categories and allowlisted event types only. Socket open is not success: wait for session.started/session.updated with a nonempty session.id. Probe sends no audio and closes after a bounded interval or explicit disconnect.

## Acceptance and publication

1. API metadata correctly derives HTTPS/WSS, wildcard, IPv6 and companion-listener addresses and shows missing upstream as unavailable.
2. Mocked browser flow uploads a fixture, receives text, copies it, cancels a pending call and displays a server error. No real audio/provider requests during agent QA.
3. Mocked voice flow connects, observes a protocol event, disconnects and releases callbacks/timers; API keys never enter storage, screenshots or URL queries.
4. Desktop and mobile browser screenshots are read back and corrected. Screenshot attached to UI PR with synthetic data only.
5. Remote CI executes dashboard tests/lint/build and repository typecheck/suite; no local execution. Inspect exact-head logs and download its dashboard-preview artifact. The final PRs fill Summary, Verification and Checklist plus ordinary stack map. Existing unrelated CI failures stay separately documented; never attest whole-suite green.

Conditional acceptance includes empty/malformed metadata (disabled controls, no
request), file >25,000,000 bytes (local rejection before fetch), 401/429/503
(localized categories, no raw body), aborted upload (no stale text), WS open
without ready event (timeout), protocol error (failed, not connected), key/origin
change and inactive/unmount (all resources closed, no late callback). Copy samples
contain placeholders only, never the transient input. Metadata tests cover TLS,
wildcard, IPv6 and loopback companion URLs. No new enforcement layer is claimed;
browser guards are early UX validation, and server admission remains authoritative.

## P/A review disposition

Accepted architect CONN-META-01, WIRE-02, URL-03, UI-04 and LIFE-06. Folded
CONN-PROBE-05 and the independent A review's three residuals:

- On socket open send exactly `{"type":"session.update","session":{"instructions":"","audio":{"output":{"voice":"cove"}},"delegation":{"type":"client"}}}`.
  Acknowledgments with closed/error/failed session status are terminal, never
  ready. An error followed by normal close remains failed.
- The API module exposes a narrow raw audio-upload entry. It validates the exact
  HTTP(S) `/v1/audio/transcriptions` destination and bypasses installed management
  authentication and 401 recovery. Connected-mode tests install that wrapper and
  assert the typed data key survives, with no session/CSRF/machine credentials.
- Endpoint validation rejects userinfo, query, fragment and incorrect schemes as
  well as wrong origins/paths. Network and cache paths use the same validator.
  Only the wp2 `opencodex-audio` / `opencodex-key.<base64url>` carrier is used;
  observed output means allowlisted event types, not raw messages.

Commands are defined by root/gui package.json. Source paths and existing stylesheet/fetch owner are revalidated at this cycle P before implementation; any renamed path is amended with exact ownership evidence. No disconnected metadata fields or fake audio model tests are acceptable.

The three PRs use codex/audio-transcription -> dev, codex/audio-streaming -> codex/audio-transcription, codex/audio-connections -> codex/audio-streaming. Leave all open. Record test results and head/base SHAs without claiming human approval, merge or real provider availability.
