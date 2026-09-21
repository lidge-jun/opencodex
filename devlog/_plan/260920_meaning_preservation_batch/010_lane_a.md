# Lane A — meaning preservation on the request path

Status: OPEN. Branch `codex/260920-lane-a-meaning-preservation`, cut from `origin/dev`
`0613aaec17`. One branch, five ordered commits, one pull request against `dev`.

## What each commit restores

### #5211 — tool choice policy on the Chat Completions path

Two constraints reached the parser and were dropped on the way out, both under a normal 200.

A `tool_choice` of type `allowed_tools` is a record, is not `type: "function"`, and carries no
`function` member, so it fell past every branch of `toolChoiceToResponses` and `body.tool_choice`
was never assigned. Chat nests the subset under `allowed_tools` and names each entry under a
member keyed by its own type; the Responses shape `mapToolChoice` reads carries `mode` and
`tools` on the choice itself with a flat `name`. Both levels are now flattened. An entry that
cannot be named is refused rather than skipped, because skipping one widens the subset.

`parallel_tool_calls` had three provider states and two branches, in two places. The unset state
is the default for every provider that never configured the knob, and it dropped the caller's own
explicit `false` — on the translated path and, from a second copy of the same branch, on the
native Chat passthrough. The decision now lives in `src/adapters/openai-chat/parallel-tool-calls.ts`,
which both builders read. An explicit `true` still omits the key, matching the configured opt-out.

The passthrough half was found by adversarial review, not by the original report.

### #5210 — tool declaration fields on the outbound adapters

`strict` was kept deliberately by the Messages inbound and forwarded by the OpenAI Chat adapter,
and dropped by Anthropic — the target that defines it. It is now emitted when it is explicitly
`true`. An unstated `strict` stays absent, because the inbound records it as `false` and a
`false` on the wire cannot be told apart from silence.

`allowed_callers` had no carrier at all. It now rides `OcxTool.allowedCallers` from the Messages
inbound, through the Responses tool schema — where an undeclared key is stripped, which is why it
never reached `buildTools` — to the Anthropic wire. The OpenAI Chat and Gemini builders have no
counterpart and refuse with a 400 rather than rebuild the declaration without the fence. The
unrestricted `["direct"]` default is not a restriction.

Gemini's `functionCallingConfig.mode: "VALIDATED"` was plumbed to the wire compiler but only
reachable by matching a model name. A caller-declared strict tool now selects it in place of the
absent-choice default; `NONE`, `ANY` and a forced-name choice are never overwritten.

### #5213 — developer message position, then role

Delivered as two commits because they are two acceptance conditions.

Position carries #5237 by Yum-wu with a `Co-authored-by` trailer. The upstream branch had the
right idea and a broken patch (a stray `];` and an assertion that put the deferred reminder
before the tool result), so the change was reimplemented and the attribution kept. One
destination already had chronological placement, keyed to a model id and a registry entry; that
is a property of prompt-prefix caching rather than of that destination, so it is now universal
and the model/registry test is gone.

Role is separate. `developer` is part of the Chat Completions role set and is now forwarded as
sent. A destination that genuinely rejects it sets `foldDeveloperRoleToSystem`, which converts
the role in place and never moves the message, so the placement contract holds on both paths.

### #5212 — inline document bytes

Both inbound parsers reduced an attachment to its name before any adapter ran.
`OcxContentPart` gains a document member carrying the media type and the base64 payload;
Anthropic emits the document block, OpenAI Chat the file part, Gemini `inline_data`.

Widening that union is the hazard, so the part also carries the marker every text-only consumer
already falls back to, which keeps a wire with no document representation byte-identical to
before. Six consumers needed more than the fallback: `ollama-native` and the Cursor tool-result
decoder would have read a nonexistent `imageUrl`, and the Kiro, Devin, Cursor and coding-agent
text serializers would have produced an empty turn. All were found by adversarial review.

The untranslated-media refusal is narrowed only where a converter actually builds the part:
user content on the Chat projection, user and developer messages on the Responses one. A file in
a tool output, a system message or an assistant message is still refused. The scanner and the
decoder share one predicate, so a request cannot be exempted in one and reduced to a marker in
the other.

## Known remaining gap

Tool-result documents keep the #939 marker. The Responses tool-output vocabulary has no file
block and every adapter's tool-result path flattens to text, so carrying bytes there is a
separate change rather than a half-done one.

## Union-defect check before push

- File-size ratchet: `src/adapters/openai-chat.ts` was the only capped file in the touch set
  (cap 822). The `parallel_tool_calls` decision moved to a sibling module and the file is 811
  lines. No cap was raised.
- `PROVIDER_CONFIG_FIELD_POLICY` in `src/server/auth-cors.ts` is
  `satisfies Record<keyof OcxProviderConfig, ...>`, so `foldDeveloperRoleToSystem` is classified
  there and in `providerConfigSchema`.
- Every new test file is registered in both `scripts/test-layout/layout.json` and
  `tests/fixtures/test-layout-expected.json`, which the layout guard asserts are equal.
- No count is restated: the provider reference tables gained a row rather than a number.

## Verification

Static source review plus exact-head hosted CI. Local suites, individual tests, typecheck,
build, install and live `ocx` execution were NOT RUN, per the lane constraints. Adversarial
source review ran on every commit and produced the passthrough, Kiro/Devin/Cursor/coding-agent,
role-aware-refusal and base64-predicate findings listed above.
