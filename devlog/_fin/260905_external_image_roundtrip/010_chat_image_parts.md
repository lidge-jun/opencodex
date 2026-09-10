# Chat image-part foundation

Depends on wp0. One full PABCD cycle, one lower PR.

## MODIFY src/chat/inbound.ts

Keep imageUrlFromPart's current object/string URL support. In userContentToBlocks,
extend the input_image push with detail from the nested image_url object, or the part
for the already-supported string shorthand. Preserve only auto/low/high detail.

```diff
- blocks.push({ type: "input_image", image_url: imageUrl });
+ const detail = isRec(raw.image_url) ? raw.image_url.detail : raw.detail;
+ blocks.push({ type: "input_image", image_url: imageUrl,
+   ...(detail === "auto" || detail === "low" || detail === "high" ? { detail } : {}) });
```

For role:tool, reuse the existing content converter, retaining the original text-only
string behavior when no valid image is present. Responses function_call_output accepts
input_text/input_image, not input_video; don't newly forward video tool blocks.

```diff
- const output = typeof msg.content === "string" ? msg.content : contentToText(msg.content);
+ const blocks = userContentToBlocks(msg.content);
+ const output = blocks.some(part => part.type === "input_image")
+   ? blocks.filter(part => part.type === "input_text" || part.type === "input_image")
+   : contentToText(msg.content);
```

Keep output_text tool parts supported: extend the reusable converter's text recognition
to output_text (already accepted by contentToText) so mixed arrays lose no old text.
Field chain: nested Chat detail -> input_image.detail -> parser image.detail -> existing
Chat image_url.detail; raw Responses preserves detail. No new type/enum/config.

## MODIFY tests/responses/chat-completions-endpoint.test.ts

Add converter-level cases beside the existing conversion tests:
- user image: remote/data URL, nested detail, no detail, string shorthand;
- tool image: function_call plus mixed text/image output retains exact order;
- image-only tool output stays a nonempty array;
- text-only string/array and invalid image keep existing text behavior;
- mixed output_text/image preserves text; video does not enter function output.
Use explicit expected objects, not converter-derived expectations. No removed assertions.

## Acceptance and delivery

Repeat the baseline standalone invocation: tool output must now contain input_image and
both final wire bodies must contain the synthetic URL; user detail must survive. Run
`node node_modules/typescript/bin/tsc --noEmit` (not a suite), add tests but execute
them only in CI. Review source and tests, commit, `git push --no-verify origin
codex/external-image-parts`, and open templated PR to dev. The user explicitly forbids
local suites; the installed pre-push hook runs package.json prepush including the full
suite, so that hook must be bypassed for this authorized push. No persistent hook
configuration change. Existing large files
are extended narrowly to avoid an unrelated split. No new exports or upload handler.
