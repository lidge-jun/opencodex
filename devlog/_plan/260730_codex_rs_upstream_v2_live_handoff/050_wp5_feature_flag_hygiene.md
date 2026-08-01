# 050 — WP5: feature-flag hygiene (scope reduced by evidence)

One full PABCD cycle. Independent of WP1-WP4.

## Evidence correction, read this first

An earlier pass assumed OpenCodex mirrors upstream's feature list and would therefore
break on the `code_mode_host` boolean→table change and on the removed `enable_fanout`
and `item_ids` flags. **That assumption is wrong.** Verified with:

```
rg -n "code_mode_host|enable_fanout|item_ids" src gui/src   # no matches
```

`src/codex/features.ts` reads exactly one feature key, `multi_agent_v2`, and delegates
every other toggle to the native `codex features` command
(`src/cli/v2.ts:43` builds `["features", action, "multi_agent_v2"]`). OpenCodex owns no
feature registry to drift out of sync.

So the `code_mode_host` shape change, the two removals, and the eight new
under-development flags require **no OpenCodex change at all**. This phase is
therefore NOOP-eligible, and its real deliverable is a guard against the class of bug
rather than a fix for an instance of it.

Do not delete this phase on that basis. The phase exists because the assumption above
was plausible enough to reach a plan document, and a regression test is what stops the
next person from reintroducing a mirrored feature list.

## Scope

| Item | Disposition |
|---|---|
| `code_mode_host` boolean→table | NOOP — OpenCodex never reads it |
| `enable_fanout` removed | NOOP — never referenced |
| `item_ids` removed | NOOP — never referenced |
| 8 new under-development flags | NOOP — not exposed by OpenCodex |
| `multi_agent_v2` stage promotion | NOOP — stage is upstream-internal; the key name is unchanged |
| A test pinning "we mirror exactly one feature key" | **DO THIS** |

## Change map

| Path | Action |
|---|---|
| the features test file | MODIFY — add the invariant test below |
| `src/codex/features.ts` | MODIFY — header comment stating the delegation boundary |

## Diff 1 — the invariant test

NEW test case in the features test file. The intent is to fail loudly if someone adds a
second hardcoded upstream feature key to OpenCodex without deciding to own a registry.

```ts
test("opencodex mirrors exactly one upstream feature key", async () => {
  const source = await Bun.file(
    new URL("../src/codex/features.ts", import.meta.url),
  ).text();

  // Every `features.<key>` and `[features.<key>]` reference in the module.
  const referenced = new Set(
    [...source.matchAll(/features\.([a-z0-9_]+)/g)].map(match => match[1]),
  );

  // multi_agent_v2 is deliberately mirrored because opencodex migrates its
  // concurrency value across the v1/v2 boundary. Every other upstream feature flag
  // is delegated to `codex features` and must NOT be hardcoded here: upstream
  // changes flag shapes and stages freely (e.g. code_mode_host became a table,
  // enable_fanout and item_ids were removed), and a mirrored list silently rots.
  expect([...referenced].sort()).toEqual(["multi_agent_v2"]);
});
```

Two implementation cautions for B:

1. The regex will also match the string `features.multi_agent_v2` inside doc comments,
   which is intended: comments naming other flags are fine, but a comment is not where
   this test should fail. If comment noise makes the assertion brittle, strip comments
   before matching rather than loosening the assertion.
2. Confirm the relative path to `src/codex/features.ts` from the test file's location at
   P. The path above assumes `tests/` sits beside `src/`; verify with
   the unit's own layout; `tests/` sits beside `src/`, verified.

## Diff 2 — the delegation boundary comment

MODIFY the header comment in `src/codex/features.ts` (currently begins at line 2 with
`features.ts — codex feature-flag view for $CODEX_HOME/config.toml.`).

Append:

```
 * Scope boundary: this module mirrors ONLY `multi_agent_v2`, because opencodex has to
 * migrate its concurrency value across the v1/v2 boundary. Every other upstream
 * feature flag is delegated to the native `codex features` command (see
 * src/cli/v2.ts) and must not be hardcoded here.
 *
 * Upstream reshapes flags freely: in the 1f0566d3f..5a1097ed2 range alone,
 * `code_mode_host` changed from a boolean to a table, `enable_fanout` and `item_ids`
 * were removed, and eight under-development flags were added. Delegation is what
 * keeps opencodex out of that churn.
```

## Accept criteria

1. The invariant test passes against the current tree.
2. The test fails when a second `features.<key>` reference is added to the module
   (prove this, do not assume it).
3. `bun run typecheck` green.
4. No production behavior changes.

### Activation scenario

The test itself is the conditional path, and it is the exact kind that ships dead: a
regex that matches nothing will pass forever while asserting nothing.

| Path | Trigger | Observable |
|---|---|---|
| assertion fires | temporarily add `features.code_mode_host` to the module | the test FAILS with both keys in the diff |
| assertion holds | revert that edit | the test passes with `["multi_agent_v2"]` |

Run the failing direction during C and record the failure output as evidence. A green
run alone does not prove this test works.

## Expected terminal outcome

`NOOP` for the upstream flag changes, with the per-item justification table above as
evidence, plus `DONE` for the invariant test. State both in the D summary rather than
rounding the phase to one label.

---

# P-phase re-verification (2026-07-31, execution cycle)

Three amendments, two from the `005` staleness audit and one found by executing the
doc's own regex against the post-WP2 tree.

## Amendment A — Diff 1's regex is broken against the real module; scope it to string literals

Ran the doc's matcher against the current `src/codex/features.ts`:
`grep -oE "features\.[a-z0-9_]+"` yields `features.match`, `features.multi_agent_v2`,
`features.slice`, `features.ts` — local variables named `features`, not mirrored keys.
The doc's caution 1 ("strip comments if brittle") does not cover this: the noise is in
CODE, not comments. The test as written would fail on a clean tree.

Final form, executed during P and producing exactly `["multi_agent_v2"]`:

```ts
test("opencodex mirrors exactly one upstream feature key", async () => {
  const source = await Bun.file(new URL("../src/codex/features.ts", import.meta.url)).text();
  // Only string literals can hold a TOML key reference; bare regex over the module
  // also matches local variables named `features` (features.match, features.slice).
  const literals = source.match(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g) ?? [];
  const referenced = new Set(
    literals.flatMap(lit => [...lit.matchAll(/features\.([a-z0-9_]+)/g)].map(m => m[1])),
  );
  expect([...referenced].sort()).toEqual(["multi_agent_v2"]);
});
```

## Amendment B — upstream status wording corrected

`005` finding: `code_mode_host` is not removed — it is `Stage::Stable` and enabled by
default upstream (`features/src/lib.rs:904`); `enable_fanout` (`:1100`) and `item_ids`
(`:1256`) are `Stage::Removed` but still ACCEPTED as compatibility keys. The honest
statement for the D summary and the header comment: upstream retains two as
accepted-but-inert keys and one as a live feature; OpenCodex never mirrored any of
them. The justification table's dispositions are unchanged (all NOOP).

## Amendment C — add the behavioral half of the invariant

`005` finding: a source-regex test alone cannot catch a mirrored flag stored as a bare
TOML string consumed by a new code path, and it trips on comment noise. Add the
behavioral assertions alongside it (same test block):

1. A config carrying `code_mode_host`, `enable_fanout`, and `item_ids` does not change
   `isMultiAgentV2Enabled` — the module's read surface is provably indifferent to them.
2. `codexFeaturesInvocation("enable").args` is exactly
   `["features", "enable", "multi_agent_v2"]` — the delegation target is pinned.

The negative-direction activation run (temporarily adding `features.code_mode_host` to
the module and watching the test fail) stays mandatory in C, now for both halves.

---

# A-phase fold-back, execution cycle (verdict GO-WITH-FIXES, 1 Medium blocker)

Independent terra review (Dewey). Blocker accepted; near-pass with zero residual.

## Blocker (accepted) — the string-literal extractor has prospective holes

The Amendment-A extractor misses a second mirrored key written inside a regex literal,
an escaped string, nested template backticks, or passed as a bare quoted key. The
reviewer's evidence included working counterexamples. Fix that closes every named hole
with one discriminating observation: **upstream feature keys are snake_case; the false
positives (`features.match`, `features.slice`, `features.ts`) are JS member accesses,
which are camelCase.** Require an underscore and scan the whole source:

```ts
test("opencodex mirrors exactly one upstream feature key", async () => {
  const source = await Bun.file(new URL("../src/codex/features.ts", import.meta.url)).text();
  // Upstream feature keys are snake_case, so the underscore requirement is the
  // discriminator: JS member accesses on locals named `features` (features.match,
  // features.slice, features.ts) are camelCase and never match, while a mirrored
  // key matches wherever it is written — string, template, escape, or regex literal.
  const referenced = new Set(
    [...source.matchAll(/features\.([a-z0-9]+(?:_[a-z0-9]+)+)/g)].map(m => m[1]),
  );
  expect([...referenced].sort()).toEqual(["multi_agent_v2"]);
});
```

Executed during this fold-back against the post-WP2 module: yields exactly
`["multi_agent_v2"]`.

Acknowledged residual, stated in the test comment: a bare quoted key with no dotted
prefix (`tomlBoolInBody(features, "code_mode_host")`) is not caught by this assertion;
the behavioral half (Amendment C) is the net for that case, because a mirrored reader
that never changes `isMultiAgentV2Enabled`'s indifference to the key would still be
caught the moment it influences the flag read.

## Reviewer-verified facts folded into B

- `codexFeaturesInvocation("enable")` probed fresh: `["features","enable","multi_agent_v2"]`.
- The behavioral fixture should use the CURRENT upstream table shape
  `[features.code_mode_host]` plus the two inert boolean keys, comparing an explicit
  expected `isMultiAgentV2Enabled` result.
- Upstream status quotes confirmed: `code_mode_host` Stage::Stable default_enabled
  (`lib.rs:904-908`); `enable_fanout`/`item_ids` Stage::Removed, where Removed is
  documented "useless but kept for backward compatibility" (`:49-52`).
- The broad `rg` hits for `codeModeHost`/`itemIds` are unrelated runtime identifiers
  (process-name matching in `app-server-processes.ts`, response-body sanitizers in
  `openai-responses.ts`), not feature-config reads — the NOOP claim stands, and the
  D summary must say so to pre-answer the obvious review question.

---

# Audit fold-back (A-phase, blocker 7, Low)

The invariant-test comment used a bare `features.ts`, which contradicts this unit's own
naming rule. Corrected: every reference to that module in this document means
`src/codex/features.ts`. Apply the same in the test comment when writing it.
