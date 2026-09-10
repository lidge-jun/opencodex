# Accepted image representations without silent loss

Depends on 020; wp3. C3 parsing, with C4 care for the explicit translated-file error.
Same resource/credential bounds as000; writes only paths below, no live credentials,
network fetching, remote upload, auth changes or local suites. Stop on unresolvable
native-vs-routed ambiguity, not by weakening native preservation.

## MODIFY src/responses/parser.ts

In outputToToolResultContent, input_image must follow the already-owned precedence:

```diff
- else if (raw.type === "input_image" && typeof raw.image_url === "string") { ... }
+ else if (raw.type === "input_image") {
+   const imageUrl = nonEmptyString(raw.image_url);
+   const fileId = nonEmptyString(raw.file_id);
+   if (imageUrl) { /* existing image push and normalized detail; hasImage=true */ }
+   else if (fileId) parts.push({ type: "text", text: `[image: ${fileId}]` });
+ }
```

Do not lower computer screenshots in this shared parser. Independent audit found
that parser-only lowering shifts vision-caption alignment and breaks native/raw
consistency. No new computer execution or observation-message semantics are added.

## MODIFY src/server/responses/core.ts

Immediately after existing isPassthrough determination (before vision planning), inspect
raw input items. A non-passthrough adapter receiving computer_call_output returns fixed
400 invalid_request_error: `computer_call_output requires a Responses passthrough
route; send screenshots as user input_image content on translated routes.`
No payload, source URL or call ID in the error. Passthrough stays unchanged, including
native/keyed Responses and routed compaction using a passthrough adapter. This avoids
shared-parser rejection of valid native traffic and preserves vision-caption alignment.
No helper/export/import is needed; use the existing raw body and formatted error owner.

## MODIFY src/claude/inbound.ts

In imageBlockToInputImage, after validating source object and before base64/URL cases:

```diff
+ if (source.type === "file") throw new AnthropicRequestError(
+   "File-backed images require native Anthropic passthrough; use base64 or URL images on translated routes.");
```

The existing HTTP boundary catches AnthropicRequestError as400. Native Anthropic
passthrough never calls this converter. No file id, URL or payload echoed in errors.

## MODIFY existing tests

- tests/responses/responses-parser.test.ts: function/custom file-only output marker;
  URL wins over file_id; malformed/empty refs never become images; original raw item and
  caller object unchanged. No new computer tool declaration or toolCall emitted.
- tests/claude-integration/claude-inbound.test.ts: user/tool source:file throws the
  existing error; base64/URL still preserve. Native negative control stays in existing
  claude-native-passthrough.test.ts; add endpoint error coverage at its existing seam
  only if the reviewer finds class-to400 mapping not covered.
- tests/responses/responses-compaction-routing.test.ts: beside the existing unpaired
  output boundary, non-passthrough computer output returns400 with zero upstream fetch;
  native/keyed Responses preserves exact raw screenshot and reaches its controlled
  upstream; ordinary image message still works. Request includes another ordinary image
  to prove there is no partial vision work or caption misassociation before rejection.
- docs-site/src/content/docs/reference/proxy-formats.md: file handles remain provider
  scoped; native reference forwarding vs translated marker/error; hosted computer
  outputs require Responses passthrough, screenshots can use ordinary input_image.

Verifier: one standalone direct parser/converter probe before/after (no test runner),
node TypeScript, static test bundling, privacy scan, exact-head CI. Independent security
review confirms no native rejection, payload logging, new fetch, or execution authority.
Reuse existing modules; defer broad splits in large files to avoid unrelated churn.
Publish third stacked PR against codex/external-image-wire-contract; no merge yet.

## C-review corrections

Accepted consumer mismatch: output parser's nonempty-URL predicate must match raw vision
caption indexing. MODIFY src/vision/index.ts syncRawBodyImageDescriptions to skip empty
URLs for both message/tool fields, preserve existing file marker when available, and
never consume a later image's caption. Remove the now-unneeded private boolean argument.
MODIFY tests/vision/vision-cache.test.ts with function/custom arrays containing empty
URLs before two real images; actual describeImagesInPlace must preserve caption order.
Standalone .tmp/vision-caption-alignment-probe.ts demonstrated the misalignment (exit1).

Accepted coverage gap: core guard test must activate vision in its ordinary-image
control. Explicit routed vision fixture, controlled description dependency, and no live
account resolution; control describes once, computer-output request describes zero.
These repairs preserve the original030scope and do not implement040or050.
