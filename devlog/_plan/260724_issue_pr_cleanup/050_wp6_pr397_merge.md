# WP6 — #397 openai-chat system-first merge (050)

PR #397 `fix(openai-chat): keep system messages first`. State: NOT draft,
MERGEABLE/CLEAN, all CI green, CodeRabbit review completed.

What it does (from diff): in `src/adapters/openai-chat.ts`,
`messagesToChatFormat` previously mapped `developer` role messages to inline
`role:"system"` at their original position — which for strict OpenAI-compatible
backends (LM Studio, llama.cpp) breaks the "all system instructions must
precede conversation history" contract. The fix folds text-only developer
messages into the single leading system block (`developerSystemText` helper +
`developerSystemParts`), and drops the in-history developer->system emission
(`if (msg.role === "developer" && !hasImages) break;`). Developer messages that
carry images stay as user-position vision messages (images are only valid on
`user` role).

Tests: new `tests/openai-chat-system-order.test.ts` (+103); existing
`openai-chat-dangling-toolcalls.test.ts` updated to assert the leading-system
hoist.

Risk: adapter behavior change on the wire; covered by focused tests. No auth/
credential/release-workflow surface -> not a security-boundary PR.

Actions:
1. A-gate: Sol reviewer confirms the hoist preserves tool_call/tool_result
   pairing and does not drop developer guidance.
2. `gh pr merge 397 --squash` to dev (already ready + clean).
3. Verify merged SHA + state.

Terminal: DONE = merged SHA. Independent of other WPs (adapter file only).
