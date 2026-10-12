# Meta Muse 64-char MCP tool-name aliasing (#4410)

## Problem

Meta Muse (https://api.meta.ai/v1, openai-responses adapter) rejects any request
whose function tool name exceeds 64 characters: HTTP 400
'name' must be at most 64 characters, got 66. Real ZCode sessions carry
fully-namespaced MCP names (20 of 93 tools over the limit), so the whole turn
dies before any tool call. Repro: 66-char placeholder name -> 400, 64-char -> 200.
Only the name length matters; schemas, arguments, and message bodies are fine.

## Prior art in this tree

- src/adapters/kiro-wire.ts kiroToolName - deterministic, collision-safe
  normalization to ^[a-zA-Z0-9_-]{1,64}$ with a nameMap that restores original
  names on the way back. Same shape of problem, different transport.
- src/adapters/openai-responses.ts (~line 2465) - existing Muse-scoped outbound
  transform stripMuseSparkUnsupportedWebSearchFields(outBody, parsed.modelId, url),
  gated on the api.meta.ai Responses URL. The aliasing hook belongs at the same
  seam so no other provider path changes behavior.
- src/responses/tool-name-aliases.ts plus src/responses/namespace-tool-compat.ts
  and custom-tool-compat.ts - the existing alias/restore machinery for namespace,
  custom-tool, and tool-search wire names. Inbound restore should reuse this
  layer rather than inventing a second mapping channel.

## Design

1. Outbound (meta-muse / api.meta.ai Responses only): before the request body
   leaves, rewrite every function tool name longer than 64 chars to a
   deterministic collision-safe wire name: keep a readable prefix, append a
   short stable hash suffix, clamp to 64, sanitize to the safe charset, and
   dedupe within the request (same input -> same output across turns).
2. Record the alias map on the turn/request context.
3. Inbound: restore original names in streamed and non-streamed function_call /
   tool_call outputs, in tool_choice echo, and in any history items that carry
   the aliased name back upstream, using the existing alias-restore machinery.
4. Arguments, user text, and schema property names are never rewritten. Other
   providers see zero behavioral change (scope strictly to the meta-muse
   baseUrl / provider id).

## Regression coverage

- Unit: alias function - 64 passes through verbatim, 65/66/93-char names map
  deterministically, collision-safe, charset-safe.
- Adapter-level: meta-muse outbound request with the issue's 93-tool catalog
  fixture sends only <=64-char names; a second provider keeps names verbatim.
- Inbound: tool_call with aliased name restores the original MCP name;
  tool_choice round-trips.

## Delivery

- Branch codex/260912-muse-64-tool-alias from dev (aa0dd50864), PR to dev with
  full template, close #4410 manually after merge (PRs target dev; GitHub
  auto-close only fires on main).
- Implementation and verification delegated to xai/grok-4.6 spawned subagents;
  local suite NOT run; pushes use --no-verify; exact-head remote CI is the
  passing evidence.

## Audit amendments (grok-4.6 explorer, near-pass — blocking findings folded in)

1. Do NOT copy stripMuseSparkUnsupportedWebSearchFields predicates (contributor-model
   + URL set incl. Zen). Gate the new sibling transform on destination host api.meta.ai
   so the default muse-spark-1.3 model is covered; place it at the same call site
   (after namespace flattening ~openai-responses.ts:2453, before stringify).
2. Existing alias types cannot carry Map<wireName, originalName>. Add a new sidecar
   on AdapterRequest (e.g. convertedMuseToolNameAliases) and a new restore helper in
   src/responses/ (e.g. muse-tool-name-alias.ts); wire restore at core.ts sites:
   stream payload rewrites 6098-6107 (Muse rewrite BEFORE namespace restore),
   block rewrites 6164 / undeclared guard 6150, non-stream 6362-6380, continuation
   cache 5102-5104, inspection 5081, and every failover/rebuild refresh of
   routed aliases (4808, 4905, 5357, 5474, 5595, 5822, 7270, 7415).
3. Outbound rewrite covers tools[] PLUS history function_call/custom_tool_call names,
   tool_choice ({type:function|custom, name} and allowed_tools.tools[].name),
   additional_tools, and chat-shaped tool.function.name (use wireToolInnerName).
4. Restore order is load-bearing: Muse hashed->original BEFORE namespace restore and
   BEFORE the undeclared-tool guard (continuation turns declare only client originals).
5. Do not import kiro-wire.ts into src/responses/; copy the algorithm into a new
   helper. Hash the ORIGINAL name (55-char prefix + _ + 8 hex sha256 = 64), charset
   [^a-zA-Z0-9_-] -> _, two-phase claim (pass-through <=64 names claimed first),
   salt loop wireName#N on collision, declaration-order processing.
6. Structure docs to update in the same change: structure/transports/responses.md
   (alias contract), plus other owners of touched areas (runtime.md,
   transports/inventory.md, data-planes/inbound-compat.md, providers/chat-compat.md,
   adapters/registry.md as applicable).
7. Tests: unit helper tests/responses/responses-muse-tool-name-alias.test.ts;
   adapter outbound (93-tool catalog fixture + second provider unchanged)
   tests/providers/muse-tool-name-alias.test.ts; inbound restore/SSE in
   tests/responses/ near openai-responses-passthrough/namespace-tool-compat.
   New files need entries in BOTH scripts/test-layout/layout.json explicit and
   tests/fixtures/test-layout-expected.json. Never put muse-* under tests/responses/.
