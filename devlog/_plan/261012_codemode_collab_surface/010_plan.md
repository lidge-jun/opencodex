# 010 — Code-mode V1 collaboration evidence (#6844)

## Problem

`collabSurface()` (`src/server/responses/collaboration.ts`) recognises a collaboration surface only
from a directly declared `spawn_agent`. In Codex code-mode-only turns the collaboration tools are
not top-level wire tools, so the surface is `null` and `multiAgentGuidanceText()` returns before the
V1 Max/Ultra gate.

## What a request can actually prove (codex-rs openai/codex @ ec8251c54, 2026-10-08; cross-checked
against the 2026-09-22 snapshot)

1. **Non-deferred V1 (rendered).** `code-mode-protocol/src/description.rs`
   `build_exec_tool_description` renders every ENABLED nested tool into the custom `exec` description
   when `code_mode_only` is true: a heading line, the tool's own description, then an
   `exec tool declaration:` ts fence holding `declare const tools: { <name>(args: …): Promise<…>; };`.
   `tools/src/code_mode.rs` `code_mode_name_for_tool_name` flattens a namespaced tool to
   `<namespace>__<name>`; V1 registers under the fixed namespace `multi_agent_v1`
   (`multi_agents_spec.rs:14`), so V1 reads `multi_agent_v1__spawn_agent`, `__send_input`,
   `__resume_agent`, `__close_agent`, `__wait_agent`.
2. **Deferred V1 (not rendered).** `core/src/tools/spec_plan.rs:1476` registers the V1 tools as
   `ToolExposure::Deferred` whenever `model_info.supports_search_tool` is true, and
   `build_exec_tool_description` ignores deferred definitions (ec8251c54) or adds only the generic
   "Some deferred nested tools may be omitted" sentence (2026-09-22). Every OpenCodex catalog row
   carries `supports_search_tool: true` (`src/codex/catalog/parsing.ts:901`; upstream 9/9 and roster
   3/3 rows), so this is the shape OpenCodex users get, and the one the issue reports. Live
   corroboration from this very session (Codex code mode through OpenCodex): the isolate's
   `ALL_TOOLS` lists `multi_agent_v1__spawn_agent` and its four companions while the request-visible
   `exec` description lists none of them.
3. **No other per-request V1 signal.** codex-rs emits its own `<multi_agent_mode>` developer item only
   for V2 (`core/src/session/multi_agents.rs` `effective_multi_agent_mode` returns `None` unless V2);
   `ModelCatalogState` needs the under-development, default-off `model_catalog_in_context` feature; no
   header names the surface; and the session pins its version in history
   (`core/src/session/mod.rs` `resolve_multi_agent_version`), so the saved OpenCodex mode or catalog
   stamp cannot prove an existing conversation's surface.

Scope of this conclusion: the request builders and defaults inspected above (both snapshots; the
September build additionally gates deferral on provider namespace support). The ALL_TOOLS
observation is the coordinator's live corroboration, separate from the source evidence.

Consequence: OpenCodex can prove V1 only in case 1. Case 2 stays `null` (fail closed). What, if
anything, to do for case 2 without a host signal is a maintainer design decision, as the issue
comment already states; this change does not make it.

## Change

1. New `src/server/responses/code-mode-collab-surface.ts`, `codeModeV1Evidence(tools)` →
   `"v1" | "ambiguous" | null`:
   - Genuine envelope only: an un-namespaced freeform `exec` in a catalog where
     `declaresCodeModeExec()` holds, whose description starts with the codex-rs template line
     `Run JavaScript code to orchestrate/compose tool calls`. Anything else (structured or namespaced
     `exec`, flat-bridge shape, overridden template) contributes nothing.
   - Section parser: scan lines, tracking CommonMark code fences (backticks or tildes, opening
     length, at most three spaces of indentation; only the same character, at least as long, closes).
     A top-level tool heading of the exact rendered form (a backticked identifier, optionally followed
     by the backticked raw name) becomes pending; the next top-level `exec tool declaration:` ts fence
     belongs to the innermost pending heading whose name it declares, and ends that section. Section
     boundaries therefore come from complete declarations, so prose headings in a tool description
     (the V1 spawn guidance's four `### When to delegate…` lines, a configured usage hint's `## Usage`)
     neither cut a genuine section nor claim its declaration. Pending headings form a stack: a
     complete declaration (named typed parameter, non-empty `Promise<…>` return) is owned by the outermost pending heading with its
     name, which is removed with anything opened after it; an unowned example declaration leaves the
     stack alone, and the declaration fence closes by the same CommonMark rule as any other fence. Identity is classified from the raw
     name, because normalization can map a foreign `multi-agent-v1` namespace onto `multi_agent_v1`.
   - Classification: V1 evidence requires `multi_agent_v1__spawn_agent`. Any other
     collaboration-shaped nested name (bare `spawn_agent`, `<ns>__spawn_agent` outside
     `multi_agent_v1`, any V2 companion name in any namespace) beside it makes the listing
     `"ambiguous"`. `mcp__…` names are MCP tools and are ignored. V1 companions in another
     namespace (e.g. an unprefixed MCP server `server__send_input`) make no V1 claim.
2. `collabSurface()`: unchanged when the nested result is `null`. `"ambiguous"` → `null`. `"v1"` →
   `"v1"` only if no direct collaboration tool was seen or the direct result is already `"v1"`;
   otherwise `null`. Nested evidence never yields `"v2"`. For `effortCapAppliesTo`, native steering and
   `core-normalize.ts`, `"v1"` and `null` are equivalent, so a turn that today resolves to `null` changes
   only by gaining V1 guidance. One deliberate exception: a direct V2 surface beside a rendered V1
   listing is contradictory and becomes `null`, which drops its V2 designation and V2 effort cap.
   codex-rs never emits that pair (code-mode-only hides Direct tools); the test pins the outcome.

## Tests (new `tests/codex-integration/code-mode-collab-surface.test.ts`, registered in
`scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`)

Requests go through `parseRequest` (body `tools` and `additional_tools`, `functions` namespace):
- rendered V1: `v1`; Max and Ultra emit the proactive text; Medium silent; disabled switch silent.
- deferred V1 (the issue's envelope + deferred sentence, no sections): `null`, no guidance at Max.
- code mode without collaboration: `null`.
- rendered V2 (`collaboration__*`, bare): `null`, no V1 text; V2 effort-cap gate unchanged.
- ambiguous: V1 + V2 companion; V1 + foreign `server__spawn_agent`; direct flat `spawn_agent` + nested
  V1; direct V2 + nested V1 → `null`; direct V1 + nested V1 → `v1`.
- false positives: caller-defined `exec` (structured, namespaced, flat bridge, non-template); heading
  without declaration; full V1 section quoted inside another tool's fenced example; unprefixed MCP
  `server__spawn_agent` + `server__send_input` → `null`.

## Limitation

A tool description is copied verbatim into `exec`, so a description that reproduces a complete
top-level V1 section byte for byte is indistinguishable from the host's own rendering. The parser
cannot authenticate the host; such a copy can at most add the V1 proactive hint (user, authority and
tool rules stay in force) or, beside a direct V2 surface, make the turn contradictory (`null`). An
overridden `exec` template (supported upstream through model messages, unused by every shipped
catalog row) fails closed.

## Docs

`structure/subagents.md`: surface-detection paragraph (rendered vs deferred, fail-closed rules,
limitation). `docs-site` English `guides/sub-agent-surface.md`: one sentence that code mode is
covered only when the `exec` tool lists the V1 tools, and deferred V1 receives no proactive text.
Locales do not discuss detection, so they are not contradicted.

## Verification

`bun run typecheck`; focused `bun test` of the new file, `multi-agent-compat`, `effort-policy`,
`tests/test-layout.test.ts`, `tests/test-layout-tooling.test.ts`; `bun run test:changed`;
`bun run structure:check`; `bun run privacy:scan`; full `bun run test` before review readiness (or the
AGENTS.md resource exception, recorded in the PR). No live service is touched.

## Review record

- Plan audit (GPT-6.1-Sol high): round 1 FAIL, five findings folded (deferred V1, envelope strictness,
  unprefixed MCP lookalikes, V2 policy scope, test registration); round 2 NEAR-PASS, four
  non-blocking findings folded.
- Code review round 1 (GPT-6.1-Sol high) FAIL: layout.json reached the 2000-line ratchet (entry moved
  onto an existing line); boolean fence tracking (now CommonMark-shaped); namespace-heading
  boundaries cut usage-hint headings (now declaration-bounded); raw heading names were discarded
  (now classify identity). Each parser guard has a test that fails when the guard is removed.
- Code review round 2 (GPT-6.1-Sol high) FAIL: an unowned example declaration cleared every
  pending heading (now a stack; only the owner and later entries are removed); declaration close used
  an exact three-backtick match (now the shared fence rule); a truncated first line counted as a
  declaration (now the complete rendered form). Each fix has a regression that fails on the prior
  commit.
- Code review round 3 (GPT-6.1-Sol high) FAIL: raw-name suffixes were trusted without checking that
  they normalize to the heading, and the innermost same-name heading owned a declaration (now the
  outermost, and a suffix must differ from the heading and normalize to it); `(...)` and empty
  `Promise<>` declarations were accepted (now a named typed parameter and a non-empty return are
  required). Each fix has a regression that fails without it.
- Code review round 4 (GPT-6.1-Sol high) FAIL: an orphan heading in an earlier namespace description
  could borrow a later genuine V2 companion declaration and hide the contradiction. Rather than
  another ownership patch (four rounds of the same class), the contradiction check is now liberal:
  it reads every heading (name and raw suffix) and every `declare const tools: { X(` line, quoted
  or not, while V1 evidence stays strict. Copied text can only move a turn toward null. The
  outermost-owner rule no longer changes any outcome and has no dedicated test.
