Fixed on our side, so I'm closing this. Thanks for sticking with it — your Opus 4.8 control is what made the report tractable, and it correctly ruled out the original "the proxy drops every `queued_command`" reading.

## What was wrong

Claude Code delivers a mid-turn steer as text riding the same user turn as the pending `tool_result`. The Kiro adapter merges adjacent user content, and the tool-result branch was pushing its placeholder sentence first, so the assembled current turn read:

```
The requested tool result is attached.

<your steering instruction>
```

That placeholder exists only so a tool-result turn with no other text isn't sent with blank content. It was never meant as a prefix, and putting it ahead of the newest human intent buried your instruction behind proxy boilerplate on the opening line of the current turn.

Tool results now carry empty content and the placeholder is backfilled only for turns that still have no text, so a mid-turn steer arrives as just your instruction, with the tool result still attached structurally in `userInputMessageContext.toolResults`. Nothing is lost.

## What we verified along the way

I reconstructed your scenario directly against the request builder rather than reasoning about it, invoking `buildKiroPayload` for both models on the tail Claude Code produces. Two things came out of that:

- The steering text was always reaching Kiro as the current turn — it was never dropped or pushed into history. Inbound preserves block order, the adapter merges adjacent user content, and that merged turn becomes `conversationState.currentMessage`.
- Request construction is otherwise the same for both models on this path. The only differences are the model identifier and Opus 5's native `output_config.effort`. Completion mode depends only on whether tools are present, the tool-catalog nudge takes no model argument, both are 1M-context entries, and the CLI-vs-IDE request shape depends on token type rather than model. Opus 4.8's emulated-thinking injection is also skipped whenever the current turn carries tool results, so neither model gets extra instruction text in this exact situation.

Regression tests now pin both behaviors: that a mid-turn steer is the entire current content with no placeholder filler, and that Opus 5 and Opus 4.8 receive identical request content apart from the native effort field. A future model-conditional regression on this path fails in CI instead of in someone's session.

## If it comes back

To be straight about scope: the ordering fix is a targeted change, and I can't prove from this side that it was the whole story. It's plausible Opus 5 weights the opening sentence of the current turn more heavily than 4.8 does, which would make this exactly the cause — but that stays a hypothesis.

So if you still see mid-turn steers ignored on Opus 5 once this is in your build, please reopen or file a follow-up. Two things would help most:

1. Whether the same scenario behaves differently with reasoning effort lowered or disabled. That isolates `output_config.effort`, the only other model-conditional field we emit, and needs no special instrumentation.
2. The `OCX_QUEUE_543` style capture you offered, if you still have the appetite for it. Worth noting the existing Claude inbound debug ring captures scalars only and not message structure, so it won't answer this on its own.

Also happy to hear about anything else you hit — the level of detail in this report made it much easier to work with than most.
