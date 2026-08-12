# WP2 — the client-dialect modality filter

Research: `004_export_modality_poisoning.md`. Read it first; this doc is the diff.

Independent of every other phase. It fixes a failure the user is hitting right
now, so it goes first despite not being a switch.

## IN / OUT

IN: `src/clients/config-export.ts` (MODIFY),
`tests/client-export-modality-enum.test.ts` (NEW).

OUT: `src/server/management/model-rows.ts`, `src/cli/export-command.ts`,
`src/codex/catalog/*`, `normalizeExportModels`. All four deliberately keep
carrying `audio` — the internal vocabulary is correct, only two destinations are
narrower.

## The helper

MODIFY `src/clients/config-export.ts`, immediately after `outputBudgetFor`
(currently line 432) so the two value-normalizing helpers sit together:

```ts
/**
 * Modalities a given client's schema will actually accept.
 *
 * Our internal vocabulary is `text | image | audio` (model-routes.ts
 * ALLOWED_INPUT_MODALITIES). Pi and Gajae both accept only `text | image`, and
 * both reject the WHOLE config file over one out-of-enum value — Gajae reports
 * `/providers/opencodex/models/N/input/2: Invalid option` and falls back to its
 * built-in list, Pi returns an empty model config. So a single `audio` model
 * takes every routed model down with it.
 *
 * This is the same defect the Codex catalog had with `video`, where the app
 * showed zero apps (tests/catalog-input-modality-enum.test.ts). The fix is the
 * same shape — filter to what the destination accepts — with one deliberate
 * difference, below.
 *
 * UNKNOWN and INCOMPATIBLE are not the same input, and the Codex fix could
 * conflate them safely only because its enum is wider. A model with no declared
 * modalities is unknown, and `text` is the honest floor: every routed model
 * takes prompts. A model that declares `["audio"]` and nothing else is
 * INCOMPATIBLE with a text|image client, and rewriting it to `["text"]` would
 * advertise a capability the model does not have. That input is reachable:
 * `ocx models add --modalities audio` accepts it (src/cli/models.ts:139-146),
 * `/api/custom-models` accepts it (model-routes.ts:13), and provider discovery
 * can return an audio-only list (src/codex/catalog/provider-fetch.ts:341).
 *
 * So unknown falls back to text, and incompatible omits the model. Omitting one
 * model costs the user that row in a picker; fabricating `text` costs them a
 * model that fails at call time with no explanation.
  *
  * Deliberately NOT applied in ExportModel construction: the management and CLI
  * boundaries carry catalog modalities verbatim on purpose, and stripping `audio`
  * globally would destroy valid metadata before the destination is known.
  */
const CLIENT_INPUT_MODALITIES: Record<"pi" | "gajae", ReadonlySet<string>> = {
  pi: new Set(["text", "image"]),
  gajae: new Set(["text", "image"]),
};

/**
 * `null` means "this model cannot be represented for this client" — the caller
 * drops the row. Deliberately not an empty array, which a caller could spread
 * into a config without noticing.
 */
function inputModalitiesForClient(
  client: "pi" | "gajae",
  modalities: readonly string[] | undefined,
): string[] | null {
  const declared = modalities ?? [];
  // Nothing declared is unknown, not incompatible.
  if (declared.length === 0) return ["text"];
  const accepted = CLIENT_INPUT_MODALITIES[client];
  const kept: string[] = [];
  for (const value of declared) {
    if (accepted.has(value) && !kept.includes(value)) kept.push(value);
  }
  return kept.length > 0 ? kept : null;
}
```

Order-preserving and deduping, so `[text, image, audio]` becomes `[text, image]`.
The existing byte-exact golden is unaffected: its fixture declares no modalities,
which still emits `["text"]` through the unknown branch.

## Call site 1 — Pi

`buildPiClientConfig`, currently line 653. The `map` becomes a `for` because the
helper now filters as well as transforms, and a `null` sentinel inside a `map`
would need a second pass:

```diff
-  const models: PiModelEntry[] = normalizeExportModels(ctx.models).map(model => {
-    const entry: PiModelEntry = {
-      id: model.namespaced,
-      name: exportModelLabel(model),
-      // Text is the one modality every routed model supports; anything richer must come
-      // from the catalog rather than an assumption.
-      input: model.inputModalities && model.inputModalities.length > 0 ? [...model.inputModalities] : ["text"],
-    };
+  const models: PiModelEntry[] = [];
+  for (const model of normalizeExportModels(ctx.models)) {
+    // Pi returns an EMPTY model config on a schema failure rather than dropping
+    // the offending entry, so one out-of-enum value costs every routed model.
+    const input = inputModalitiesForClient("pi", model.inputModalities);
+    // An audio-only model has no honest representation here; claiming `text`
+    // would fail at call time instead, so the row is dropped.
+    if (input === null) continue;
+    const entry: PiModelEntry = { id: model.namespaced, name: exportModelLabel(model), input };
     const context = authoritativeContextWindow(model.contextWindow);
     if (context !== undefined) {
       entry.contextWindow = context;
       entry.maxTokens = outputBudgetFor(context);
     }
-    return entry;
-  });
+    models.push(entry);
+  }
```

Also MODIFY the stale docstring above `buildPiClientConfig` (line 649), which
still says Pi's schema is UNVERIFIED. It is verified now. Cite the *stable* doc
rather than a line range that has already drifted between audit rounds
(`packages/coding-agent/docs/models.md` states the accepted values), and name the
behavior rather than the line: Pi returns an empty model config when validation
fails. A line-pinned citation into a moving upstream file is a comment that rots.

## Call site 2 — Gajae

`buildGajaeClientConfig`, currently line 761, takes the identical shape:

```diff
-  const models: GajaeModelEntry[] = normalizeExportModels(ctx.models).map(model => {
-    const entry: GajaeModelEntry = {
-      id: model.namespaced,
-      name: exportModelLabel(model),
-      input: model.inputModalities && model.inputModalities.length > 0
-        ? [...model.inputModalities]
-        : ["text"],
-    };
+  const models: GajaeModelEntry[] = [];
+  for (const model of normalizeExportModels(ctx.models)) {
+    const input = inputModalitiesForClient("gajae", model.inputModalities);
+    if (input === null) continue;
+    const entry: GajaeModelEntry = { id: model.namespaced, name: exportModelLabel(model), input };
 ```

with the same `return entry;` → `models.push(entry);` change at the loop tail.

Gajae's enum is at `models-config-schema.ts:141` in the installed
`@gajae-code/coding-agent` — line 119, which `004` cited, only opens the model
schema object. Cite the installed version alongside the line.

## Test — `tests/client-export-modality-enum.test.ts` (NEW)

Named to sit beside `catalog-input-modality-enum.test.ts`, whose incident this
repeats. Cases:

1. `audio` is dropped from a Gajae entry — the exact live failure, using
   `zenmux/meta-muse-spark-1.1` with `[text, image, audio]`, asserting
   `[text, image]`.
2. The same for Pi, so the latent half is pinned too.
3. **An audio-only model is OMITTED from both exports, not rewritten to
   `["text"]`.** Assert its id is absent from `models` entirely. The fixture
   builds it the way a user reaches it — `ocx models add --modalities audio`
   accepts exactly this (`src/cli/models.ts:139-146`).
4. A model with NO declared modalities still emits `["text"]`. Unknown is not
   incompatible, and this branch is what keeps the byte-exact golden stable.
5. `[text, image]` survives untouched in both.
6. Order and dedupe: `[image, text, image]` yields `[image, text]`.
7. A whole-catalog assertion over a catalog carrying BOTH a mixed
   `[text, image, audio]` model and an audio-ONLY model: every emitted Pi and
   Gajae `input` value is inside `text|image`, and no emitted model claims a
   modality its catalog entry did not have. This is the case that would have
   caught the live bug — every per-entry test passed while the file was broken.

## Verification

A unit test does not close this — 91 tests were green beside a config gjc
refuses to load.

1. `bun run typecheck`, `bun run test`
2. Re-apply the gajae integration through the running proxy
3. **Parse** the emitted YAML and assert every
   `providers.opencodex.models[*].input` value is in `text|image`. A `grep` for
   `audio` is the wrong check: the string also appears in model ids, display
   names, and other providers' preserved blocks, so it can fail while our output
   is correct. Same structural check against Pi's JSON.
4. Launch gjc and confirm the model list loads with no schema error

Step 4 is the criterion. Steps 1-3 are necessary and insufficient.

## Accept criteria

- C1 — gjc loads the emitted config with no schema error, observed in the real
  file, and Pi's identical exposure is closed in the same change.
- No emitted Pi/Gajae `input` value outside the client's enum, asserted over a
  whole catalog rather than one entry.
- No model is advertised to a client with a modality it does not have: an
  incompatible model is omitted, never rewritten to `text`.
- The byte-exact export goldens still pass, changing only where `audio` was
  previously emitted.
