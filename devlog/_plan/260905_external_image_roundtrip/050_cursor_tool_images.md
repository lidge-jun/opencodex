# Active Cursor external-tool screenshot attachments

Depends on040 tool provenance/adjacency contract; wp5. C3 plus explicit size-boundary
review. Same resource bounds as000. No new remote fetching, credentials, protobuf
schema, historical-image recall, or native Composer/MCP behavior.

## MODIFY src/adapters/cursor/images.ts

Extend prepareCursorRawMessages with a default-off trailing-tool-image option. Only
when opted in and the final message is toolResult, find the contiguous trailing result
run and use existing prepareCursorContentParts on each in order. Apply MAX_CURSOR_IMAGES
to the aggregate run, before decoding; preserve earlier history and existing abort,
data-only normalization, compression and omission behavior. Return collected prepared
images in existing PreparedCursorRawMessages. Existing default/user/developer paths
and cursorVisionPrepareStartIndex callers stay unchanged.

Extend existing ResolvedCursorImage with optional `sourceLabel?: string` metadata.
For each prepared image in an opted-in trailing result, copy the prepared image and
attach a bounded label identifying the trailing-result ordinal and prepared-image
ordinal, plus JSON-escaped tool name/call id truncated to128 characters each. The
ordinals disambiguate even truncated labels; no image bytes or result text enter labels.
Maximum12 labels, so action provenance stays bounded independently of history length.
User/developer and native MCP paths produce no sourceLabel. No new cross-module type.

## MODIFY src/adapters/cursor/live-transport.ts

```diff
- const preparedRaw = await prepareCursorRawMessages(request.rawMessages, signal);
+ const externalToolImages = isCursorExternalWireModel(request.modelId)
+   && request.rawMessages?.at(-1)?.role === "toolResult";
+ const preparedRaw = await prepareCursorRawMessages(request.rawMessages, signal, { trailingToolImages: externalToolImages });
- const selectedImages = await resolveActiveCursorImages(...);
+ const selectedImages = externalToolImages ? preparedRaw.images : await resolveActiveCursorImages(...);
```

Reuse isCursorExternalWireModel from its actual discovery owner. Do not use
cursorNeedsExternalToolContinuation, which includes native Composer2.5. Existing
protobuf buildPreparedCursorRunRequest already sends external continuation via
userMessageAction and selectedContext images.
Field chain: raw tool image -> prepared normalized part + ResolvedCursorImage -> existing
CursorRunRequest.selectedImages -> UserMessageAction.selectedContext -> blob/KV bytes.

## MODIFY src/adapters/cursor/protobuf-request.ts and types.ts

The A reviewer found that root pruning can remove source text while selectedImages
survive. Resolve this with active-action provenance, not post-prune reconstruction.
After computing existing actionText, for external tool continuations with source-labeled
selectedImages append a clearly marked client-supplied screenshot-source list in
attachment order. Each line includes attachment index and the bounded sourceLabel.
Use the augmented text only in UserMessageAction, never system instructions or native
MCP. It survives root pruning and checkpoint fallback because action text is outside
the prunable root. Existing echo-retry continuation text remains the prefix; append
provenance to it too. Other actions remain byte-equivalent. Update selectedImages
documentation in types.ts; no new CursorRunRequest field is required.
Truncate identifiers before JSON escaping, and use the same augmented actionText for
wire serialization and existing input-token estimation. Test escaped controls, long
identifiers, and an invalid earlier image omitted before a later valid image.
sourceLabel serialization: ResolvedCursorImage metadata -> active user action text;
buildSelectedImages ignores metadata and emits existing bytes/schema; no persisted
deserializer or separate consumer. Search all ResolvedCursorImage consumers before B.

## MODIFY existing tests

- tests/providers/cursor/cursor-images.test.ts: opted-in data images across parallel
  trailing run (including final text-only result), aggregate count cap, invalid marker,
  abort, detail, immutable source. Preserve text-only/default and stale-new-user cases.
- tests/providers/cursor/cursor-live-transport.test.ts: captureOpen actual encoded request
  proves selectedContext bytes for external full replay/checkpoint continuation; Composer
  negative control. Under pruning pressure use two distinct screenshot results, prove
  root pruning actually occurred, then assert ordered source labels remain in the active
  action alongside both attachment bytes. Cover checkpoint fallback and echo retry.
  Existing fixture's valid PNG.
- tests/providers/cursor/cursor-tool-result-image.test.ts: correct stale blanket noVision
  comment only; native MCP cases stay unchanged.
- public proxy-formats.md + transport SoT: active external tool data images use the
  existing12-image aggregate limit; historical images and remote-URL policy unchanged.

One worker owns images/test and sourceLabel contract; a second owns live transport,
protobuf action/types and live-transport tests only after the contract is agreed.
All preparation remains bounded. Main does standalone encode proof, static
type/bundle checks and CI; fresh independent review challenges the new activation path.
Publish fifth layer, preserving source/metadata association under history pruning.

Review-size decision: publish this one050cycle as two dependency-ordered PR layers:
preparation API/sourceLabel plus its focused tests, then actual transport/protobuf
activation plus live-wire tests/public contract. Each layer has its own tests and CI;
the combined diff exceeds500lines largely due boundary/pruning regression coverage.
No acceptance is deferred beyond the full050cycle; both layers remain held for060.
