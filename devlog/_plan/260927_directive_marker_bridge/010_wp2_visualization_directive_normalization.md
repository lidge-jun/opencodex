# wp2: normalize visualization references in model-visible text

## Scope

IN: `src/responses/visualization-directives.ts` (new), `src/responses/parser.ts` (one call at the
return), `tests/responses/visualization-directives.test.ts` (new), `scripts/test-layout/layout.json`,
`tests/fixtures/test-layout-expected.json`, `structure/transports/responses.md`,
`docs-site/src/content/docs/guides/codex-integration.md` (new subsection after "Routed local tools").
OUT: adapters, raw-body passthrough, response-side repair, persistence, citation filter.

## Files

### NEW `src/responses/visualization-directives.ts`

Exports:

- `normalizeVisualizationText(text: string): string` — returns `text` unchanged (same reference)
  unless it contains the exact prefix `"\uE200visualize\uE202"` (no spaces). It produces the same
  matches as the app's regex `/\uE200visualize\uE202([^\uE201]+)\uE201/g`, but with a linear scanner:
  find the next prefix with `indexOf`; the payload runs to the next END (`indexOf` from the prefix end);
  an empty payload resumes the prefix search one character later; no END after a prefix means no later
  match exists, so scanning stops. Each match becomes `toAsciiDirective(payload)` or stays as is.
  Unterminated spans are copied through. App-regex parity supersedes D4's opaque-payload rule: a
  `visualize` span inside another keyword's payload is converted, as the app would convert it.

  Intentional differences from `f2`: code tokens are normalized too (the skill's example is fenced),
  and the template exception below. Using the same regex means a `visualize` span that appears after
  a malformed START of another keyword is converted exactly as the app would convert it.
- `normalizeVisualizationContext(context: OcxContext): OcxContext` — copy-on-change over
  `systemPrompt`, string `content`, and `type:"text"` parts of every message role; returns the same
  object when nothing changed.

`toAsciiDirective(payload)` follows [001](001_app_and_external_evidence.md) rule for rule: every valid
`type:"live"` payload becomes `::codex-live-vis{…}` with no `mode`; `wide:true` is validated and
ignored; `mode="wide"` only for inline. Template exception: a JSON payload whose `path` is exactly
`<absolute-path>/<title>.html` skips path validation and always uses the `path` attribute (the app's
`sj` would pick `file` for it); schema, type, title and mode rules still apply. Both skill templates
have exact-output assertions.

### MODIFY `src/responses/parser.ts`

```diff
+import { normalizeVisualizationContext } from "./visualization-directives";
@@ return {
-    context,
+    context: normalizeVisualizationContext(context),
```

### NEW `tests/responses/visualization-directives.test.ts`

Cases: absolute JSON path; title; wide; live with path and with null path; bare absolute path; bare
basename (`file=`); both skill templates; spans inside a fenced block; rejected payloads kept (invalid
JSON, relative JSON path, `..`, quote, bad basename, missing path); other keywords and unterminated
spans untouched; Windows drive and UNC paths; live null path with a title; malformed optional fields
(`title` number, `type` other, `mode` other, `wide` string); a decoded compaction summary carrying the
reference; 20,000 repeated unterminated prefixes normalized in under 200 ms; exact output for a
`visualize` span nested in a `cite` payload and for a malformed `visualize` prefix followed by a valid
one; idempotence; every
role and content shape through `parseRequest`, with image parts, tool-call arguments and reasoning
parts deep-equal to an unnormalized parse; a frozen input body (deep `Object.freeze`) parses without
throwing and `_rawBody` is the same object; an expanded continuation body (prior assistant output
with the private-use reference plus a new user turn) normalizes both turns; the Anthropic adapter
body contains the ASCII directive and no private-use character.

### MODIFY layout manifests and `structure/transports/responses.md`

Register the test under `responses`; add one paragraph to the transport doc naming the module and the
raw-body exclusion.

### MODIFY `docs-site/src/content/docs/guides/codex-integration.md`

New `### Inline visualizations with routed models` after `### Routed local tools`: the private-use
reference is rewritten to `::codex-inline-vis{…}` for context-built routes, raw-body passthrough routes
are unchanged, and replies already stored in the bare `visualize{…}` form stay as they are. Locale
copies gain nothing, so they do not contradict the English page.

## Verification (PLAN-VERIFIER-REAL-01)

| Command | Reads the target |
|---|---|
| `bun test tests/responses/visualization-directives.test.ts` | direct argument |
| `bun test tests/responses/citation-markers.test.ts tests/adapters/bridge.test.ts` | callers of the response path |
| `bun test tests/responses/responses-parser.test.ts tests/responses/responses-parser-agent-message.test.ts tests/responses/responses-parser-malformed-content.test.ts tests/responses/parser-content-audio.test.ts tests/responses/responses-state.test.ts` (run locally) | parser and replay consumers |
| `bun test tests/lab/core-lab-boundary.test.ts tests/ci-workflows/file-size-ratchet.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts` | Lab boundary, ratchet, layout manifests (source-reading guards `test:changed` cannot see) |
| `bun run test:changed` | import graph from `parser.ts`; local run is limited by the `~/.codex` checkout guard, the full suite is left to CI |
| `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan` | whole tree |

Activation scenarios: a rejected payload (C runs the "kept" cases and sees the private-use span unchanged);
a live null path (C sees `::codex-live-vis{}`).

## Architect reflection

Fermat returned MISALIGNED on the first plan revision with five gaps. Dispositions:

1. Exact prefix — folded. Opaque unknown spans — superseded in the second reflection by app-regex
   parity (the app converts a nested span, so the model should see the same thing); nested and
   malformed-prefix fixtures pin the exact output.
2. Live selection, ignored `wide`, template exception scope — folded above.
3. Opaque-field, frozen-input and replay assertions — folded above. Cursor checkpoint rejection test —
   rebutted: the Cursor builder compares a digest of the context it is given, and this change only
   alters that context's text, so an old checkpoint mismatches and is discarded, which is the existing
   safe path; recorded as residual instead of a new Cursor fixture.
4. Existing suites and source-reading guards named explicitly — folded above.
5. Universal claims removed; alternatives' reasons and limitations recorded in 000 and 001 — folded.


Second reflection (wp2 P): MISALIGNED on regex cost (quadratic on repeated unterminated prefixes,
measured 16/63/251 ms for 2k/4k/8k) and on the opaque-span claim. Both folded above: linear scanner with
the regex's semantics, parity recorded explicitly, adversarial and nested fixtures added.
