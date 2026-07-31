# Phase 10 — Native image input (userInputMessage.images)

## Problem

CodeWhisperer's userInputMessage accepts an images array (proven by kiro-gateway:
converters_core.py 641-704 + 1354-1362 + 1520-1562). opencodex's kiro adapter
models userInputMessage as { content: string } only, so userContentText
(kiro.ts 91-94) silently drops every OcxImageContent part. Images vanish.

## Target wire shape (from gateway, native Kiro IDE format)

    userInputMessage.images = [
      { format: "jpeg", source: { bytes: "<pure base64, no data: prefix>" } },
      ...
    ]

- format = media subtype: "image/jpeg" -> "jpeg".
- source.bytes = pure base64 (strip any "data:...;base64," prefix).
- Images attach to userInputMessage directly, NOT userInputMessageContext.
- Remote https image URLs are NOT fetchable here -> skip with a text marker,
  matching gateway's "URL-based images not supported" behavior.

## opencodex source shape

OcxImageContent (types.ts 70-76): { type:"image"; imageUrl: data|https URL; detail? }.
Carried on user/developer/toolResult messages as OcxContentPart[].

## Plan (diff-level)

### MODIFY src/adapters/kiro.ts

1. Extend KiroUserInputMessage interface: add optional `images?: KiroImage[]`.
   New interface:
       interface KiroImage { format: string; source: { bytes: string }; }

2. Add helpers near userContentText:
   - parseDataUrlImage(imageUrl): { format; bytes } | undefined
       * Only handles `data:` URLs. Returns undefined for https (not fetchable).
       * Split on first ","; derive media subtype from the header; bytes = tail.
   - extractKiroImages(content): KiroImage[]
       * Maps OcxContentPart[] image parts via parseDataUrlImage; drops https.

3. In buildKiroPayload user/developer branch (around line 233): after computing
   `text`, also compute images via extractKiroImages and attach to the entry's
   userInputMessage when non-empty. mkUser must accept optional images.

4. For the FINAL currentMessage userInputMessage: ensure images from the last
   user turn survive (currentEntry is popped from history or freshly built).
   Since images are already attached to the history entry that becomes
   currentEntry, popping preserves them. For the synthetic "(tool results)" /
   "(continue)" carriers there are no images by construction.

5. Leave userContentText unchanged (text extraction stays text-only); images
   travel through the separate images field, not inlined as text.

### Interaction with vision sidecar

Native image support means we do NOT add kiro to noVisionModels. Kiro now sees
images directly. The sidecar remains the fallback for genuinely text-only
providers. (If a future Kiro model rejects images, that specific model id can be
added to noVisionModels later — not in scope now.)

## Tests (NEW tests/kiro-images.test.ts)

- data URL image -> userInputMessage.images[0] == {format:"png", source:{bytes:"..."}}
- media prefix stripped: "data:image/jpeg;base64,AAAA" -> bytes "AAAA", format "jpeg"
- https URL image -> skipped (no images field, no throw)
- mixed text+image -> content has text, images has the image
- no image -> no images field (back-compat: payload identical to before)

## Verification

- bun x tsc --noEmit
- bun test tests/kiro-images.test.ts tests/kiro-adapter.test.ts

## Commit

feat(kiro): send images natively via userInputMessage.images (gateway parity)

## Audit note (Backend, PASS)

toolResult image parts (kiro.ts:263, userContentText(tr.content)) are ALSO
dropped today — e.g. Codex view_image output. That is pre-existing behavior, not
a regression. Phase 10 scopes to user/developer messages only. toolResult image
forwarding is deferred to Phase 11 (follow-up) to keep this slice atomic.
