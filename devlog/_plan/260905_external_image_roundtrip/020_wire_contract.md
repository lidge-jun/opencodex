# External wire contract and stack delivery

Depends on wp1 and its corrected Chat converter. One full PABCD cycle.

Delegated B lanes (user reconfirmed unlimited useful parallelism): worker A exclusively
edits tests/responses/openai-responses-passthrough.test.ts; worker B exclusively adds
the HTTP regression in tests/responses/chat-completions-endpoint.test.ts. Main owns
public docs, structure, devlog and git/CI. C reviewers are read-only and independent.
All lanes prohibit local test suites, services, config/auth and git/FSM mutation.

User steering during B: all image representations must be audited before merge. This
cycle now publishes the wire-contract child; the original exact-head CI/merge/ancestry
criterion is unchanged and moves to appended wp3 after the expanded audit. No criterion
is dropped or marked met early. Only existing 020 implementation runs in this B.

## MODIFY tests/responses/openai-responses-passthrough.test.ts

Import real chatCompletionsToResponsesBody, anthropicToResponsesBody,
parseRequest, and createOpenAIChatAdapter wrapped with the
existing withTestTranslatorBudget. Add a table-driven regression for each ingress:
Chat user image, Chat tool screenshot (depends on wp1), Claude user image, Claude
tool_result image. Use data and HTTPS URL fixtures, two ordered images, and image-only
tool output. Build each through public API-key Responses, canonical ChatGPT forward,
and Chat adapter; assert exact image payloads in the actual serialized body, original
input immutability, and tool call/result adjacency. Add orphan tool-result case using
the existing repair path; don't modify production adapters unless evidence demands it.
Do not claim these body tests prove upstream model OCR or live route selection.

## MODIFY docs-site/src/content/docs/reference/proxy-formats.md

After the Chat intro add:

```diff
+ Image URLs and base64 data URLs use Chat `image_url` content parts. Translation
+ preserves supported `detail` values (`auto`, `low`, `high`). OpenCodex also accepts
+ image-bearing tool-result arrays as a compatibility extension: Responses routes
+ retain structured output, while Chat adapters send tool images in a following user
+ message because the upstream Chat tool role is text-only. Plain text results remain
+ strings. Native passthrough follows its upstream contract.
```

No locale currently contradicts this additive contract; inspect sibling translated
sections before deciding whether an amendment is needed. Document no model entitlement.

## MODIFY tests/responses/chat-completions-endpoint.test.ts

Reuse mockDualWireUpstream (line 113) and dualWireConfig (line 2764), beside the
existing Chat-to-Responses HTTP regression (line 2834). POST a user image with high
detail and a paired tool screenshot to mock/grok-4.5; consume the stream and assert
one captured /responses body with unchanged ordered image parts. This is real HTTP
route proof in CI, not real-model OCR or canonical account authentication.
The manual HTTP probe showed that data-only mock Responses frames don't satisfy the
native event-name terminal observer. Add matching `event: response.output_text.delta`
and `event: response.completed` fields to mockDualWireUpstream's existing frames;
preserve all body assertions and require `[DONE]` on the new HTTP cases.

## MODIFY structure/04_transports-and-sidecars.md

Add one short paragraph beside the Chat inbound responsibility: its converter owns
detail and tool-image preservation; adapters own target-specific image placement.
Retain all existing transport/security/sidecar policy.

## Acceptance / delivery

Run `node node_modules/typescript/bin/tsc --noEmit`; public documentation build in CI
or local build (not tests); focused
regressions and full OS suites in GitHub CI only. A fresh independent patch audit
checks each wire assertion and absence of secret/logging changes. Publish child branch
codex/external-image-wire-contract against the open lower branch using `git push
--no-verify` (same explicit no-local-suite override as 010). Record admin bypass
authorization in both PR bodies; merge lower only when exact-head full CI is green,
don't delete parent branch. Prefer merge commits to preserve stack ancestry; retarget
the child to dev and refresh CI/review. If squash is used, restack and reverify its new
HEAD before merge. Fetch origin/dev and prove both merge SHAs ancestors. Archive this
unit only after the completed outcome is public. No restart/deployment is authorized.
