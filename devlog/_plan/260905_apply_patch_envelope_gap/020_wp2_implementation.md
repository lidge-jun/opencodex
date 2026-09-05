# 020 — wp2: implement the MODE A repair

Depends on `010_disposition.md`. One work-phase, one PABCD cycle.

## Change 1 — NEW export in `src/responses/apply-patch-envelope.ts`

Add a predicate beside the existing regexes. It reuses
`TOP_LEVEL_PATCH_ENVELOPE` and `PATCH_OPERATION_LINE` rather than introducing a
second, looser notion of "looks like a patch".

```ts
/**
 * True when a body is a COMPLETE top-level patch envelope carrying a real file
 * operation.
 *
 * A code-mode `exec` body is JavaScript, and this shape is never valid JavaScript:
 * `*** Begin Patch` fails to parse at the leading `**`. So a body that satisfies this
 * predicate cannot be a program the caller meant to run, which is what makes
 * reinterpreting it as an apply_patch call the single faithful reading rather than a
 * guess.
 */
export function isCompletePatchEnvelope(text: string): boolean {
  const match = TOP_LEVEL_PATCH_ENVELOPE.exec(text);
  if (!match) return false;
  return PATCH_OPERATION_LINE.test(match[3] ?? "");
}
```

`repairFreeformToolInput` and `normalizeApplyPatchDelimiters` are **not** modified.
Their exec byte-exactness contract and its lock in
`tests/apply-patch-envelope.test.ts` stand unchanged.

## Change 2 — NEW export in `src/responses/code-mode-helper-compat.ts`

One resolver, so the four call sites cannot drift apart.

```ts
/**
 * Resolve the effective code-mode helper for a freeform call.
 *
 * `codeModeHelperName` covers the NAME-based case: a provider emitted `apply_patch`
 * under a declared `exec` catalog and `normalizeDeclaredToolName` rewrote it. This adds
 * the PAYLOAD-based case: the name is already `exec`, so nothing rewrote it, but the
 * body is a complete patch envelope and therefore cannot be JavaScript.
 */
export function resolveCodeModeHelperName(
  codeModeHelperName: string | undefined,
  toolName: string,
  argumentsText: unknown,
  namespace?: string,
): string | undefined {
  if (codeModeHelperName) return codeModeHelperName;
  if (toolName !== "exec" || namespace !== undefined) return undefined;
  if (typeof argumentsText !== "string") return undefined;
  const body = unwrapFreeformToolInput(argumentsText);
  return isCompletePatchEnvelope(body) ? "apply_patch" : undefined;
}
```

`compileCodeModeHelperInput(body, "apply_patch")` already normalizes decorated
delimiters and serializes the patch with `JSON.stringify` — as data, never as source —
so a MODE A body that is *also* decorated is fixed on the way through.

## Change 3 — the four call sites

Each replaces its `codeModeHelperName` test with the resolver.

| File | line | before | after |
|---|---|---|---|
| `src/bridge.ts` | ~280 | `codeModeHelperName ? compile(args, codeModeHelperName) : repair(...)` | resolve first, then the same branch |
| `src/bridge.ts` | ~1669 | same ternary, buffered | same |
| `src/responses/custom-tool-compat.ts` | ~289 | `aliased && sourceInput !== ""` | `aliased ? item.name : resolve(...)` |
| `src/server/responses-custom-tool-repair.ts` | ~347 | `itemName?.aliased` | same resolver |

## Tests — `tests/apply-patch-envelope.test.ts` and `tests/bridge.test.ts`

New cases:

1. `isCompletePatchEnvelope` accepts canonical and decorated complete envelopes with
   Add, Update, and Delete operations.
2. It rejects: an envelope with no operation line, an incomplete envelope, a prefixed
   or suffixed envelope, ordinary JavaScript, and JavaScript that merely *contains* an
   envelope inside a string or template. That last one is the MODE B boundary and the
   most important negative.
3. Bridge-level: a `custom_tool_call` named `exec` whose input is a raw envelope comes
   back as `exec` JavaScript containing `await tools.apply_patch(`.
4. Bridge-level negative: a normal JavaScript body is still forwarded byte-identical.

Every existing test in `tests/apply-patch-envelope.test.ts` must stay green,
**including** the two exec byte-exactness locks. They exercise
`repairFreeformToolInput`, which this change does not touch.

## Rewriting one locked test name

`does not turn a raw exec body into an executable helper call` (line 61) keeps its
assertions and passes unchanged, but its *name* would then overstate the system's
behavior: the bridge now does exactly that, deliberately. Leaving a misleading name is
how the next reader gets misled, so it is renamed to name the function it actually
guards — `repairFreeformToolInput` — with a comment pointing at the bridge-level
behavior and this unit. No assertion changes.

## Verification

Focused only. The repository-wide suite is not run:

```
bun test tests/apply-patch-envelope.test.ts tests/bridge.test.ts \
  tests/custom-tool-compat.test.ts tests/responses-custom-tool-repair.test.ts \
  tests/legacy-shell-compat.test.ts tests/tool-catalog-nudge.test.ts
bun run typecheck
```

