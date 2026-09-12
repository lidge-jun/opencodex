# Connections audio controls and PR publication

Depends on wp2 completed audio routes. The first two layers remain independently usable through external client examples.

## File changes

| Operation | Path | Contract change |
| --- | --- | --- |
| MODIFY | src/server/management/api-access.ts | extend ApiAccessEndpoints with transcription, dictationStream, live and realtimeCalls URLs plus truthful capability metadata |
| MODIFY | src/server/management-api.ts | include audio metadata using existing management authentication |
| MODIFY | tests/server/api-access-endpoints.test.ts | URL host/protocol and capability projection tests |
| MODIFY | gui/src/pages/api-keys-utils.ts | extend endpoint type/default/derive chain for new endpoints |
| MODIFY | gui/src/pages/ApiKeys.tsx | consume serialized endpoint metadata through KeysResponse, CachedKeysShape, cache validation and fetchKeys |
| MODIFY | gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx | place two unframed audio sections in existing Connections/API layout |
| NEW | gui/src/components/apikeys-workspace/AudioApiPanel.tsx | accessible Dictation and Live Voice controls, endpoint/model display, sample copying, transient key/file controls and result/error states |
| NEW | gui/src/audio-api-client.ts | bounded cancelable upload and socket client protocol helpers; no saved secrets |
| NEW | gui/tests/audio-api-client.test.ts | request generation, cancellation and transcript assembly tests |
| MODIFY | gui/src/i18n/en.ts and every locale module | complete localized label/status/action keys |
| MODIFY | gui/src/styles-apikeys-workspace.css | restrained aligned responsive audio sections using existing tokens |
| MODIFY | structure/gui-and-management-api.md | metadata and control ownership/current contract |
| MODIFY | docs-site/src/content/docs/reference/proxy-formats.md and localized counterparts | final client examples and explicit protocol support |

## Before / after contracts

Before: ApiAccessEndpoints contains Responses/chat/messages/models only. After: backend generates audio endpoints from the same resolved base, converts HTTP->WS and HTTPS->WSS with URL APIs, and reports configured availability separately from runtime-proven connectivity. GUI consumes these fields, with a conservative unavailable/unknown fallback for older servers.

Metadata fields complete chain: creation buildApiAccessEndpoints -> JSON management response -> API page validation/mapping -> ApiEndpointInfo/AudioApiPanel. Defaults cannot claim configured availability. No new provider is registered and no audio model enters a text completion test.

Dictation section contains model and endpoint copy actions, file input, transient API key input, transcribe/cancel, text result/copy and clear error states. Stream example names extension protocol and gives start/audio/close events. Live Voice section contains actual GPT-Live model and both WS/WebRTC connection endpoints, transient client key, a connect/disconnect test with status and observed event output. Browser WebSocket auth must use a short-lived local session mechanism or supported client protocol carrier; never expose ChatGPT credentials or persist raw keys. Do not create a fake success check or billable background probe. All test actions require a deliberate user click.

UI is unframed and follows existing workspace colors/type/spacing. Icons reuse gui icons, all visible text is localized. At desktop and mobile widths long endpoint text wraps or scrolls within its own element without overlapping controls. Buttons have stable dimensions and stateful controls are keyboard reachable.

Pass the existing active flag through ApiKeysWorkspace. Integrations hides panels without unmounting; requests, sockets and timers must stop on deactivation as well as unmount. Existing key rows contain only prefixes: controls use a newly generated key or an explicitly entered transient key, never pretend a key ID can authenticate. Browser voice connection uses an OpenCodex-only WebSocket protocol credential carrier accepted solely by the audio routes; exact supported carrier and precedence are documented/tested in wp2. No persistent key or query authentication.

## Acceptance and publication

1. API metadata correctly derives HTTPS/WSS, wildcard, IPv6 and companion-listener addresses and shows missing upstream as unavailable.
2. Mocked browser flow uploads a fixture, receives text, copies it, cancels a pending call and displays a server error. No real audio/provider requests during agent QA.
3. Mocked voice flow connects, observes a protocol event, disconnects and releases callbacks/timers; API keys never enter storage, screenshots or URL queries.
4. Desktop and mobile browser screenshots are read back and corrected. Screenshot attached to UI PR with synthetic data only.
5. Run GUI focused tests, lint:i18n, lint, build and repository typecheck/full suite before review ready; per-layer CI uses exact PR head. The final PRs fill Summary, Verification and Checklist plus ordinary stack map.

Commands are defined by root/gui package.json. Source paths and existing stylesheet/fetch owner are revalidated at this cycle P before implementation; any renamed path is amended with exact ownership evidence. No disconnected metadata fields or fake audio model tests are acceptable.

The three PRs use codex/audio-transcription -> dev, codex/audio-streaming -> codex/audio-transcription, codex/audio-connections -> codex/audio-streaming. Leave all open. Record test results and head/base SHAs without claiming human approval, merge or real provider availability.
