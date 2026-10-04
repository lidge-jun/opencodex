# B1 — Typed tool references and inline declarations

Depends on the roadmap only. Branch `codex/next-release-261004-claude-tools`, PR base dev. Carry #6533 in full and the inline-tool portion of #6534/#6547. Identity/beta/preamble and pooling remain later layers.

## Exact change map

- MODIFY `src/adapters/anthropic/passthrough.ts`: within `anthropicOAuthWireBody`, replace top-level tool-use-only mapping with copy-on-write typed block traversal. Carry #6533 diff plus the inline-name hunks of public commit `e3eefbaedf5e0ba598c5d443ce16e21d94a9f378`. Collect inline `tool_addition.tool.type=tool_definition` client definitions before mapping so preceding references resolve. Rewrite declared custom tool `tool_use.name`, `tool_reference.tool_name`, inline addition/removal `tool.type=tool_reference` names, and inline client definition names. Traverse only message content and typed tool-result content. Preserve arbitrary schemas, arguments, cache markers and unknown blocks. Reject ambiguous wire-name collisions, including typed versus client declarations.
- MODIFY `tests/adapters/anthropic/anthropic-messages-passthrough-oauth.test.ts`: preserve six existing regressions; carry nested-reference and inline-declaration source cases; add targeted ordering, typed collision and opaque-container negatives within ratchet headroom, otherwise register a sibling domain file in both layout maps.
- MODIFY `structure/data-planes/protocol-paths.md`: native OAuth paragraph documents typed reference/inline naming, exact opaque preservation and copy-on-write behavior.
- MODIFY `docs-site/src/content/docs/guides/claude-code.md`: small native tool compatibility note, without claiming pool/default behavior before later layers.

## Observable acceptance

Declared lookup in nested tool-result content becomes custom_lookup; undeclared and typed builtins stay unchanged. Inline declaration after an earlier reference still prefixes consistently. Inline removal names match declaration. Source body JSON is unchanged; opaque tool input/schema and text/cache TTL/scope remain identical. A collision is refused before dispatch. Key auth gets no OAuth shaping. Tests fail against original behavior then pass with the patch. No network request.

## Verification

`bun test tests/adapters/anthropic/anthropic-messages-passthrough-oauth.test.ts` reads the target directly; baseline six tests pass after frozen dependency installation. `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`, `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/ci-workflows/file-size-ratchet.test.ts`; docs build per docs-site instructions. Source/public patch anchors are fixed above. Human semantic review proves prose scope, not a phrase-presence test.

## Source accounting

`#6533` all behavior carried. #6534/#6547 inline naming carried here; client compatibility, pool and preferences remain unresolved until their own layers. Include `Co-authored-by: Claire Novotny <claire@novotny.org>` in commit and PR body.

## B1 focused source review dispositions

Accept independent tool review: collect both top-level and inline typed names before any rename; reject original-name ambiguity and typed wire-name collisions independent of declaration order. Register all client declarations in the prefix collision map before walking uses. Follow only the same typed content containers in both collection and mapping so nested inline definitions cannot silently escape while their neighbors are rewritten; this is conservative structural support, not a claim that upstream accepts nested inline definitions. Add cross-message ordering, inline choice/use, undeclared/typed references, and schema/input/unknown-container opacity regressions. These are bounded refinements within B1's existing collision and typed-container contract.
