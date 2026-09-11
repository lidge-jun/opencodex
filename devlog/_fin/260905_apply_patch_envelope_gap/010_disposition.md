# 010 — Disposition: repair MODE A, refuse MODE B

Depends on `000_survey.md`. Written before implementation, revised after adversarial review.

## MODE B — refuse, and say so plainly

The proposal was: rewrite the decorated envelope inside the exec JavaScript before
forwarding it. An adversarial review argued the case against, and the case against wins.

The blocking argument is that inside a JavaScript body the 19-byte sequence
`*** Begin Patch ***` has no single meaning. It is a delimiter, or a hunk line, or a
string literal, or a regex, or documentation, or a test fixture asserting the broken
form. `tests/apply-patch-envelope.test.ts` contains it as content, and so does the
nudge in `src/adapters/tool-catalog-nudge.ts`. A rewriter cannot recover intent from
bytes, so it would corrupt some correct programs to fix some incorrect ones.

The sharpest concrete case: `/*** Begin Patch ***/` is a legal JavaScript block
comment. Replacing the substring inside it yields `/*** Begin Patch/`, which never
closes. A lexical rewrite there does not mangle a string, it silently changes control
flow.

A parser-based rewrite narrows but does not close the gap: it must parse model output
that is often already malformed, it misses the common
`"*** Begin Patch ***\n" + body` concatenation shape, and it would put a JavaScript
parser on the core request path where none exists today.

There is also a safety asymmetry that settles it. Today a decorated nested patch is
rejected before any file is touched. Rewriting converts a rejected write into a
performed write — for a host-executed filesystem tool, that turns a fail-closed
boundary into a fail-open one, and it does so for the very payloads the model got
wrong.

**Disposition: NOOP on the code path.** The 116 grok occurrences stay failures. This
is a deliberate, recorded refusal, not an oversight. The measured cost is about 1% of
one provider's exec calls; the cost of the fix is every correct program that mentions
a patch envelope.

## MODE A — repair, through the seam that already exists

MODE A is the opposite case, and one measurement is why.

**A complete Codex patch envelope is never valid JavaScript.** Verified directly by
passing four envelope shapes (Add, Update, Delete; canonical and decorated) to
`new Function(body)` under Bun 1.4.0. Every one throws
`SyntaxError: Unexpected token '**'`.

That is what makes MODE A different from MODE B. The ambiguity that blocks MODE B is
*absent* here: there is no working program that a MODE A repair could break, because
no such body is a program at all. Today every one of these is a guaranteed isolate
throw and a wasted turn.

It also satisfies the doctrine in the header of
`src/responses/apply-patch-envelope.ts` — repair only where there is exactly one
faithful reading. A body that is a complete, operation-bearing patch envelope and
cannot be JavaScript has exactly one faithful reading: the model meant to call
`apply_patch`.

### Where it goes

Not in `repairFreeformToolInput`. That function's contract is that exec bodies come
back byte-identical, and `tests/apply-patch-envelope.test.ts` locks it. It stays
locked and unchanged.

The repair belongs at the boundary that already owns the compile-or-passthrough
decision, `freeformInput` in `src/bridge.ts`:

```ts
): string => codeModeHelperName
  ? compileCodeModeHelperInput(args, codeModeHelperName)
  : repairFreeformToolInput(args, toolName, namespace);
```

A provider that emits tool *name* `apply_patch` under a declared `exec` catalog is
**already** compiled into `await tools.apply_patch(...)` there, by
`normalizeDeclaredToolName`. MODE A is the same inference from the payload instead of
the name. The new gate is deliberately narrow and reuses the existing strict
predicate rather than inventing a looser one:

- no `codeModeHelperName` (the name-based path did not already fire),
- tool name is exactly `exec`, no namespace,
- the unwrapped body matches the anchored `TOP_LEVEL_PATCH_ENVELOPE` regex **and**
  carries an `Add`/`Update`/`Delete` operation line.

Anything short of a complete operation-bearing envelope falls through untouched.

### The four sites

The decision is duplicated across the streaming and native paths, so a fix in one
place leaks the bug in the others:

| File | line | path |
|---|---|---|
| `src/bridge.ts` | ~280 | streaming |
| `src/bridge.ts` | ~1669 | buffered |
| `src/responses/custom-tool-compat.ts` | ~289 | native restore |
| `src/server/responses-custom-tool-repair.ts` | ~347 | native SSE |

A single shared helper keeps them from drifting.

## Prompt wording — separate, and honest about what it is

The injected nudge displays `*** Begin Patch ***` as a copyable literal while telling
the model not to write it. That is a genuine wording defect worth fixing on its own
terms.

It is *not* established as the cause. The decorated form predates the sentence, and a
direct A/B probe came back null on both arms (`000_survey.md`). Any change here ships
as a readability improvement with an unproven effect on the defect rate. Claiming more
than that would be unsupported by the evidence gathered.

