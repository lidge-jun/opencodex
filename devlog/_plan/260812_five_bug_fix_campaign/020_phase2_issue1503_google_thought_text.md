# 020 — Phase 2 (#1503): Google `thought` parts must not become visible text

Depends on: 010 only for the shared "adapter classifies before emitting"
discipline; the code paths are disjoint (`google.ts` vs `openai-chat.ts`), so
the branches do not conflict.

## Scope

IN

- `src/adapters/google.ts` — streaming part loop and buffered part loop.
- `tests/google-hardening.test.ts` — regression coverage.
- `structure/04_transports-and-sidecars.md` — record the transport decision.

OUT

- `observeAntigravityReplay` and every `thoughtSignature` path. Replay must be
  byte-identical after this change; Gemini 3 function calling returns 400 when
  the first function-call part of a step loses its signature (see `001`).
- Inline image materialization.
- Function-call ordering.
- The Antigravity/Vertex namespace split.

## Contributor-first delivery decision

Draft PR **#1508** by `Ingwannu` already implements this fix:

- branch `agent/fix-1503-google-thought-visibility`, head `219e7f365a`,
  state `MERGEABLE`;
- files: `src/adapters/google.ts`, `tests/google-hardening.test.ts`,
  `structure/04_transports-and-sidecars.md` — exactly the scope above;
- author-reported verification: Google focused tests 81/81, typecheck pass,
  privacy scan pass, rebased onto `dev@4fed8d3fe`.

`dev` has since advanced to `cbbfdd877`. The plan is therefore **review and
land the contributor branch**, not reimplement it:

1. Fetch the PR head and diff it against current `dev`.
2. Verify the four properties below against the real diff.
3. Re-run the Google focused suite and typecheck on `ssh lidge` at the PR head
   merged onto current `dev`.
4. If the diff is correct → merge it, and #1503 closes via the PR.
5. If the diff is incomplete → push a small correction commit **on top of** the
   contributor's commits (never a squash that erases authorship, never a
   force-push without `--force-with-lease`), then merge.
6. Only if the branch is unusable → implement independently, and say so in the
   PR discussion with the specific reason.

## Properties the diff must satisfy

| # | Property | Why |
|---|---|---|
| P1 | A part with `thought === true` and non-empty `text` produces a hidden reasoning event (`reasoning_raw_delta` / `thinking_delta`), never `text_delta` | the reported defect |
| P2 | Both the streaming loop and the buffered `parseResponse` loop are covered by one shared classifier | the issue names both; two copies drift |
| P3 | Ordinary text (`thought` absent or false) still produces `text_delta` | guard against over-broad suppression |
| P4 | `thoughtSignature` observation and replay are untouched | hard API requirement (001, Lane B) |

Additional checks against the current tree:

- the locally-declared part shape
  `{ text?: string; functionCall?: { name: string; args: unknown } }`
  must gain `thought?: boolean` (both loops declare their own shape, so both
  need it);
- `reasoning.summary: "none"` must continue to suppress visible rendering
  downstream, which follows from routing through the reasoning channel rather
  than a new one.

### `emittedContentEvent`: corrected after audit (B1)

An earlier revision of this document asserted that a thought-only part must not
set `emittedContentEvent`. That assertion was wrong, and reading the consumer
shows why: the flag feeds
`return emittedContentEvent ? "content" : "continue"` (`google.ts:645`), whose
only consumer is heartbeat suppression —
`if (sawLiveness && !sawContentEvent) yield { type: "heartbeat" }`. It is
**liveness classification**, not user-visible-content accounting. A candidate
carrying model thinking is genuine upstream activity, so suppressing the
synthetic heartbeat for it is correct.

PR #1508 keeps `emittedContentEvent = true` for both event types, which the
main agent judges correct. What is genuinely missing — and this is the valid
core of audit blocker B1 — is that the PR **changes heartbeat behavior for
thought-bearing streams with no test pinning the intended contract**. The
decision must be recorded and covered rather than inherited from a refactor.

Required additions before merge:

1. a test asserting that a thought-only SSE frame classifies as `content`
   (no synthetic heartbeat), pinning the decision above;
2. an explicit thought-signature replay regression, rather than relying on
   existing fixtures being unchanged.

## If independent implementation is needed

Shared classifier near the part loops:

```ts
// Gemini marks model-internal reasoning with `Part.thought`. That text is a
// thought summary, not the answer channel, so it crosses into the hidden
// reasoning stream instead of visible output. `thoughtSignature` is a separate
// opaque replay handle and is deliberately not read here.
function googlePartTextEvent(part: { text?: string; thought?: boolean }): AdapterEvent | undefined {
  if (!part.text) return undefined;
  return part.thought === true
    ? { type: "reasoning_raw_delta", text: part.text }
    : { type: "text_delta", text: part.text };
}
```

Streaming loop:

```ts
const textEvent = googlePartTextEvent(part);
if (textEvent) {
  // Both branches set the flag (audit R2-2). `emittedContentEvent` drives only
  // heartbeat suppression (google.ts:645 -> the `sawLiveness && !sawContentEvent`
  // check), and a thought delta is real upstream activity, so a synthetic
  // heartbeat must not be emitted alongside it.
  emittedContentEvent = true;
  yield textEvent;
}
```

Buffered loop:

```ts
const textEvent = googlePartTextEvent(part);
if (textEvent) events.push(textEvent);
```

## Activation scenario (C-ACTIVATION-GROUNDING-01)

No credential or live request is needed — the issue supplies the synthetic
candidate:

```json
{"candidates":[{"content":{"parts":[{"thought":true,"text":"internal reasoning"}]},"finishReason":"STOP"}]}
```

Buffered activation: `adapter.parseResponse(new Response(JSON.stringify(payload), {headers:{"content-type":"application/json"}}), budget)` →
the returned events contain no `{type:"text_delta", text:"internal reasoning"}`
and do contain a hidden reasoning event carrying that text.

Streaming activation: the same candidate delivered as an SSE `data:` frame
through `parseStream` → same assertions on the yielded sequence.

Mixed activation proving P3: parts
`[{thought:true,text:"secret"},{text:"visible"}]` → exactly one `text_delta`
with `"visible"`, and `"secret"` appears only on the reasoning channel.

Signature activation proving P4: a candidate carrying both a thought part and a
`functionCall` part with a `thoughtSignature` → the replay observation records
the same signature value as before the change (assert against the existing
Antigravity/Vertex replay test fixtures).

## Accept criteria

1. Buffered thought part → no visible `text_delta`, hidden reasoning present.
2. Streaming thought part → same.
3. Ordinary text still visible in both parsers.
4. Thought-signature replay fixtures unchanged.
5. A thought-only SSE frame classifies as `content`, so no synthetic heartbeat
   is emitted for that batch. (New test — pins the decision above.)
6. An explicit thought-signature replay regression asserts the observed
   signature is byte-identical before and after the change. (New test — not
   inferred from unchanged fixtures.)
7. `bun run typecheck` exit code 0.
8. Google focused suite green on `ssh lidge`.
9. PR CI green at the exact merged head (the current aggregate is red from a
   macOS timeout).

## Verification commands

```bash
bun x tsc --noEmit
bun test tests/google-hardening.test.ts tests/google*.test.ts
```

## Delivery

Preferred: merge PR **#1508** (contributor-authored), which carries
`Closes #1503` or is closed manually against `dev` per the branch policy note in
`AGENTS.md` (PRs target `dev`, so GitHub auto-close does not fire; close the
issue manually citing the merge SHA).

The two missing tests are pushed **on top of** the contributor's commits
(`agent/fix-1503-google-thought-visibility`, head `219e7f365a`), never as a
squash that erases authorship and never with a force-push lacking
`--force-with-lease`. The reviewer also noted the PR's aggregate CI is currently
red from a macOS timeout; CI must be re-run and green at the exact merged head.
