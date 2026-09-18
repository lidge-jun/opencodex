# 020 — #4190: refuse vendor scaffolding on the qoder route

Unit: `devlog/_plan/260911_l6_streaming_tools`. Lane L6, work-phase 2.
Issue: [#4190](https://github.com/lidge-jun/opencodex/issues/4190).

## The contract that was being broken

The qoder route is documented as a text and reasoning surface. `buildQoderArgs` launches the
CLI with `--tools "" --strict-mcp-config --setting-sources "" --max-turns 1
--no-session-persistence`, and both `coding-agent/protocol.ts` and `coding-agent/turn.ts`
state that Codex retains tool control and vendor tools are never invoked.

The reporter saw two things reach the client as assistant text anyway: an MCP lazy-loading
`<system-reminder>` block enumerating the local machine's configured MCP servers from
`~/.qoder/mcp.json` and from plugins, and vendor tool-call markup opened as
`<functions.exec>` and closed as `</invoke>` — mismatched, which is what a model emitting
remembered markup looks like rather than a serializer's output.

The proxy-side hole is one line of trust. `mapRawStreamEvent` forwards a `text_delta`
verbatim; frame *types* are filtered, frame *contents* are not. So whatever the vendor's agent
layer puts in the text channel is relayed, and the strongest version of this leak publishes
the operator's MCP server inventory to whoever is reading the turn.

## What was implemented

`src/adapters/qoder/scaffold-guard.ts`, a streaming filter, and `guardQoderScaffolding` in
the adapter, which wraps the `emit` callback handed to `runCodingAgentTurn`. That wrapper is
the last qoder-specific point in the path, which is why the guard sits there rather than in
the parser every coding-agent CLI shares — CodeBuddy runs the same turn code and is not part
of this report.

Two shapes, two answers, per the lane packet's recorded decision:

- A complete `<system-reminder>…</system-reminder>` block is recognizable and
  self-delimiting. It is removed and the answer around it survives.
- Anything else carrying a scaffolding signature — `<functions.`, `<invoke name=`,
  `</invoke>`, or a `</system-reminder>` with no opener — fails the turn closed. A partial
  tool-call block has no reliable end, and the prose around it may be the vendor's own agent
  narration rather than the model's answer, so repairing it would be guesswork.

It is a stream filter, not a regex over a finished string. A marker can be split across
deltas, so a tail that is still a possible marker prefix is held rather than emitted, and the
terminal event flushes both channels first. That flush is load-bearing in a way that is not
obvious: `isContentEvent` in `empty-completion-guard.ts` counts only non-empty
`text_delta`s as content, so an answer swallowed in full and followed by `done` would reach
the client as a successful but empty turn instead of as the refusal it is.

The suppressed block is discarded as it arrives; only the trailing bytes needed to spot a
split closer are kept, so an unclosed reminder cannot grow memory. A 64 KiB ceiling bounds
how much of a turn one unterminated block may swallow before the turn is refused.

## Decisions this issue left open

**Qoder only, not the shared coding-agent path.** The lane owns `src/adapters/qoder/` and
not `src/adapters/coding-agent/protocol.ts`, and the leak is reported only for Qoder. If
CodeBuddy turns out to do the same thing, the filter is a pure module and lifting it is a
small change — but it should be driven by a report, not by symmetry.

**Fail closed rather than strip, for tool-call markup.** The issue's own review lists both
options. Silently deleting markup leaves the user with a mutilated answer and no signal that
the route's contract was violated; the error names the marker class and says why.

**Not retryable.** The leak is intermittent, so a retry would often succeed. It is still
marked `retryable: false`: an automatic retry spends the operator's vendor credits on a
contract violation the proxy cannot influence, and hiding an intermittent violation is how it
stays unfixed.

**Vendor tool-call frames are left alone.** `mapRawStreamEvent` maps a `tool_use` block to
`tool_call_start`. That is arguably also a contract violation, but it is a typed frame rather
than leaked text, the issue reports the text channel, and `protocol.ts` documents that seam
as deliberately prepared for a future tool bridge.

**Known false positive.** A turn that legitimately discusses `<system-reminder>` or
`<functions.…>` syntax will be stripped or refused. That is the cost of failing closed on a
route whose leak publishes the operator's MCP inventory, and it is the direction the packet
recorded.

**Not touched: making the CLI actually run with MCP disabled.** The issue's first suggested
direction is to fix the spawn so the vendor agent layer never initializes. The installed
`@qoder-ai/qodercli` bundle still contains the reminder builder and appears to initialize it
despite the flags, so that fix lives in the vendor, not here. This guard is the containment
that does not depend on the vendor agreeing.

## Verification

Focused regression test at `tests/providers/qoder-scaffold-guard.test.ts`, beside the
existing `qoder-adapter.test.ts`, registered in `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json`. It covers block removal, a marker split across
three deltas, the held tail released on flush, fail-closed on tool-call markup and on a stray
closer, the unterminated-block case, the latch, and the wrapper's terminal handling including
the flush-before-`done` rule and forwarding a vendor error rather than replacing it. Two
cases assert that neither the leaked server list nor the leaked shell command appears in the
refusal message.

Local suite, typecheck and build: NOT RUN, by operator instruction for this dispatch round.
Hosted CI on the pushed head is the evidence.

