# 040 — Phase 4: carry PR #3917 (routed agent_message conversion), stack tip

Branch `codex/a-stack-l4-routed-agentmsg`, based on layer 3. This branch is the
stack tip and the only one with a pull request.
Carried commit `2430724e57e0950bde4b006c0175a2d5c70a0baf` by mashfromband.

## Problem

Codex writes every sub-agent reply into the rollout as an `agent_message` input
item, which is private to the ChatGPT Codex schema, so it is replayed in the input
of every later turn of that thread. The routed Responses destinations reported in
#3911 and #3907 reject the whole body with
`422 unknown item type "agent_message"`. 422 is a client error, so nothing fails
over and the thread stays broken. The plaintext conversion already existed but was
scoped to the OpenCode Go destination, and nothing in those reports is specific to
that destination.

## MODIFY / RENAME map

1. `src/adapters/opencode-go.ts` -> `src/adapters/routed-agent-messages.ts`.
   `isOpenCodeGo` is deleted; its only production consumer is the call site below.
   `normalizeOpenCodeGoAgentMessages` becomes `normalizeRoutedAgentMessages` with
   the algorithm unchanged, including the fail-closed check that every content part
   is `input_text`/`input_image`/`input_file`.

2. `src/adapters/openai-responses.ts:1` and `:2366`.

   Before:

   ```ts
   import { isOpenCodeGo, normalizeOpenCodeGoAgentMessages } from "./opencode-go";
   ...
   if (!forward && isOpenCodeGo(provider.baseUrl)) outBody = normalizeOpenCodeGoAgentMessages(outBody);
   ```

   After:

   ```ts
   import { normalizeRoutedAgentMessages } from "./routed-agent-messages";
   ...
   if (!forward) outBody = normalizeRoutedAgentMessages(outBody);
   ```

   `forward` is `provider.authMode === "forward"` (2356). All forward destinations
   retain the existing behavior and keep the item unchanged.

3. `tests/providers/opencode-go-agent-messages.test.ts` ->
   `tests/adapters/routed-agent-messages.test.ts`, with the two Go-specific
   expectations (54, 120-122) changed from `agent_message` to the converted
   `message`/`user` shape for arbitrary routed URLs.

4. `tests/responses/responses-opaque-blob-recovery.test.ts` — the four assertions
   at 553, 583, 611 and 754. That fixture is `authMode: "key"` (163-164), so its
   retried item is now converted. Opaque-blob recovery repairs an undecryptable part
   into `[encrypted content omitted]`, which leaves the item fully plaintext; on a
   routed retry it is converted too, which is what lets the retry be accepted.
   Expected object becomes:

   ```ts
   {
     type: "message",
     role: "user",
     content: [
       { type: "input_text", text: 'Agent message {"author":"/root/child_task","recipient":"/root"}' },
       { type: "input_text", text: "Message Type: MESSAGE\nTask name: /root\nSender: /root/child_task\nPayload:" },
       { type: "input_text", text: "[encrypted content omitted]" },
     ],
   }
   ```

   The `authMode: "forward"` case in the same file is untouched.

5. Both test-layout registries, because the test basename and directory change:
   `scripts/test-layout/layout.json:917` and
   `tests/fixtures/test-layout-expected.json:752` drop
   `"opencode-go-agent-messages.test.ts": "providers"` and gain
   `"routed-agent-messages.test.ts": "adapters"`.
   `tests/test-layout-tooling.test.ts:250` compares the two tables exactly, so
   missing either one fails.

6. `docs-site/src/content/docs/reference/adapters.md` and
   `docs-site/src/content/docs/reference/configuration/providers.md`, whose wording
   describes the conversion as Go-specific, as in the carried pull request. The
   carried text's universal "any routed destination" phrasing is narrowed to the
   observed non-forward destinations rather than copied unchanged.

## Preserved behavior

Forward destinations, ciphertext and unknown part types (the `every` guard),
replay immutability and no-op reference identity, the identity prefix text, and
the session-header assertion at 55 of the moved test.

## PR #3838 boundary

#3838 stays open and independent. Its `normalizeOpenCodeGoAdditionalTools`
promotion, `customToolWireName` export and `statelessResponses` registry flag are
unrelated to this conversion. Its mixed-content policy drops ciphertext and unknown
parts whenever plaintext survives, which contradicts the fail-closed retention kept
here; it is not carried.

## Verification (C)

No local command. Verified by the single tip CI run in 050. Local suites: NOT RUN.


## Which destinations actually change (audit finding 5)

`src/types/provider.ts:449` declares `authMode?: "key" | "forward" | "oauth" | "local"`.
Because the new gate is `!forward` and `forward` is `provider.authMode === "forward"`
(`openai-responses.ts:2356`), the conversion now applies to **key, oauth, local and
undefined** whenever this adapter is selected. Every forward destination is
unchanged, including noncanonical forward gateways; the built-in ChatGPT
destination is forward (`src/providers/registry.ts:1200-1204`), so its native items
stay intact.

No repository-declared non-forward destination requires plaintext `agent_message`
preservation. Authentication mode alone cannot prove what an arbitrary custom
upstream accepts, so the carried claim that *every* routed destination rejects the
item is stated here as the observed pattern rather than a proven universal.
Regression coverage adds a non-forward mode beyond the carried key/forward
fixtures.
