# OpenAI-compatible adapter: stream EOF without [DONE] is treated as success

Date: 2026-07-01
Surface: src/adapters/openai-chat.ts (streaming parseStream).
Class: C2 (single adapter, correctness/truncation bug on the data plane).
Status: SCAFFOLD - root-caused from code, fix designed, NOT yet applied.
Source: gajae/architect repo review (gpt-5.5), risk item 3b.

## Symptom (as reported)

If the upstream SSE ends (socket EOF) WITHOUT a terminal [DONE] sentinel, the
adapter still yields a normal { type: "done" }. A network cut or upstream
truncation is then presented to Codex as a clean, complete answer - the user
sees a silently truncated turn reported as success.

## Root cause (confirmed in code)

The read loop breaks on reader EOF and unconditionally finalizes:

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;            // ~line 229-230
      ...
    }
    if (currentToolCallId) { yield { type: "tool_call_end" }; }
    // EOF without a [DONE] sentinel: still surface any usage accumulated mid-stream.
    yield { type: "done", usage: pendingUsage };   // ~line 311-312

The clean path only happens inside the loop when payload === "[DONE]" (~line
239), which yields done and returns. So there is no way to distinguish:
- graceful close: we saw [DONE] -> returned already, OR
- ungraceful close: loop fell out via reader EOF with no [DONE].

Both land on the same trailing yield done.

## What already IS fail-closed (do not duplicate)

An inline provider error envelope on a 200 stream is already handled (~line
259): chunk.error -> yield { type: "error" } -> return, which the bridge maps
to response.failed. The gap is ONLY the silent-EOF (no [DONE], no error
envelope) case.

## Fix design (track terminal sentinel, fail closed on its absence)

1. Track whether a graceful terminator was seen:

    let sawDone = false;
    ...
    if (payload === "[DONE]") {
      sawDone = true;
      if (currentToolCallId) yield { type: "tool_call_end" };
      yield { type: "done", usage: pendingUsage };
      return;
    }

2. On reader EOF, branch on sawDone:

    // loop exited via reader EOF (done === true)
    if (currentToolCallId) yield { type: "tool_call_end" };
    if (!sawDone) {
      yield { type: "error", message: "upstream stream ended without [DONE] (possible truncation)" };
      return;
    }
    yield { type: "done", usage: pendingUsage };

Open question (verify, do not assume): some OpenAI-compatible providers close
the stream after the final choices chunk WITHOUT ever sending [DONE], yet the
turn is genuinely complete (finish_reason already delivered). If so, a strict
"no [DONE] => error" would false-positive. Decide the terminal signal:
- Option A: require [DONE] (strict; risks false errors on lax providers).
- Option B: accept EOF as success ONLY if a finish_reason was observed on the
  last choice; otherwise fail closed. (Safer; needs a sawFinish flag.)

Recommendation: Option B. Track sawFinish (any choice with finish_reason set);
treat EOF as success when sawDone || sawFinish, else emit error. This catches
true truncation (no finish_reason, no [DONE]) without breaking providers that
omit [DONE] but do send finish_reason.

## Blast radius

- Streaming path of the openai-compatible adapter only.
- parseResponse (non-stream JSON) path is unaffected (it has a full body).
- Risk: over-strictness could turn lax-but-complete providers into errors -
  mitigated by Option B (finish_reason acceptance).
