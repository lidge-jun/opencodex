# 021 — 이슈 #543 코멘트 최종 초안 (게시 전, 사용자 승인 필요)

아래 영어 본문을 그대로 게시할 수 있다. **GitHub 쓰기는 사용자 승인 후에만.**

---

Thanks for the Opus 4.8 control — that comparison is what made this tractable, and it
correctly rules out the original "the proxy drops every queued_command" reading.

## What we verified on our side

I reconstructed your scenario directly against the request builder rather than reasoning
about it, invoking `buildKiroPayload` for both models on the tail Claude Code produces for
a mid-turn steer:

```
user("Refactor module A.")
assistant(text + tool_use call_1)
tool_result(call_1)
user("<steering instruction>")   ← the queued_command content
```

The steering text does reach Kiro as the current turn. It is not dropped and not buried in
history: the Claude inbound translator preserves block order
(`src/claude/inbound.ts:264-301`), the Kiro adapter merges adjacent user content
(`src/adapters/kiro.ts:442-451`), and that merged turn becomes
`conversationState.currentMessage` (`src/adapters/kiro.ts:521-570`).

Request construction for the two models is the same on this path. The only differences are
the model identifier itself and Opus 5's native `additionalModelRequestFields.output_config.effort`
(`src/adapters/kiro.ts:256-259`). Notably, Opus 4.8's emulated-thinking injection is skipped
whenever the current turn carries tool results (`src/adapters/kiro.ts:555`), so neither model
receives extra instruction text in this exact situation.

Everything else we audited is model-agnostic: completion mode depends only on whether tools
are present, the tool-catalog nudge takes no model argument, both models are 1M-context
entries, `wireClient` (CLI vs IDE shape) depends on token type and profile ARN rather than
model, and the continuation cache cannot replace the tail — a missing Kiro continuation state
returns 400, not 200.

## What we found and changed anyway

The reconstruction did surface a real wart on our side. `KIRO_TOOL_RESULT_CARRIER_MESSAGE`
("The requested tool result is attached.") exists so a tool-result turn with no other text
isn't sent with blank content. Because merging appends, it was landing *ahead* of your
instruction:

```
"The requested tool result is attached.

 <your steering instruction>"
```

That is proxy boilerplate occupying the opening line of the newest human turn. Tool results
now carry empty content and the carrier sentence is backfilled only for turns that still have
no text, so a mid-turn steer arrives as:

```
"<your steering instruction>"
```

with the tool result still attached structurally in `userInputMessageContext.toolResults`. No
information is lost.

I want to be precise about status: **this is a targeted mitigation, not a demonstrated fix for
your report.** It is plausible that Opus 5 weights the opening sentence of the current turn
more heavily than 4.8 does, in which case removing the filler is exactly the fix — but that is
a hypothesis, and I have no way to prove it from this side.

## What would settle it

Most useful next step, if you're willing: retest mid-turn steering on Opus 5 with a build that
includes this change. If steers start landing, the ordering was the cause and we're done. If
they're still ignored while 4.8 keeps working, the remaining difference is upstream behavior on
identical request content, which is worth reporting to the Kiro side.

A second, independent experiment that needs no patched build: run the same Opus 5 scenario with
reasoning effort lowered or disabled. That isolates `output_config.effort`, the only other
model-conditional field we emit. If steering works without it, the effort field becomes the
suspect; if not, it's ruled out.

The `OCX_QUEUE_543` wire capture you offered is still welcome, though our static reconstruction
already predicts the marker will be present. Note that the existing Claude inbound debug ring
captures scalars only and not message structure (`src/claude/inbound-debug.ts:58-77`), so it
won't answer this on its own.

Regression tests now pin both behaviors: that a mid-turn steer is the entire current content
with no carrier filler, and that Opus 5 and Opus 4.8 receive identical request content apart
from the native effort field. A future model-conditional regression on this path will fail in
CI rather than in someone's session.

---

## 게시 시 참고

- 라벨: `needs-info`는 유지가 맞다. 패치 빌드 A/B 결과가 아직 없다.
- 우리 커밋(9eb0837e5)은 `dev`에 로컬로만 있다. 푸시 승인은 별개다.
