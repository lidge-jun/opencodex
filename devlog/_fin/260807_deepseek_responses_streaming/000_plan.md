# DeepSeek V4 Flash Responses upstream streaming re-enable

## Problem

User report: `deepseek/deepseek-v4-flash` through Codex "responds slowly / appears
unresponsive" since the model moved to the Responses wire. Reproduced live: the
proxy log shows a 28,387 ms turn (and the essay probe below took 46 s) during
which the Codex client receives **zero bytes** until the whole generation
finishes, because the #875 reliability policy forces `stream: false` upstream
(`modelResponsesUpstreamStreaming: { "deepseek-v4-flash": false }`) and
synthesizes the entire SSE sequence only after the bounded JSON body arrives.

Correctness is fine — every logged turn is 200, tool calls work end to end via
`codex exec` — the failure mode is pure perceived latency / no incremental
output, which reads as a hang for long generations.

## Evidence (fresh, 2026-08-07)

1. Official guide (https://api-docs.deepseek.com/guides/responses_api, fetched
   today): "Set stream: true to receive the response as a sequence of semantic
   server-sent events (SSE). … The stream ends with a `response.completed` /
   `response.incomplete` / `response.failed` event — **there is no `data: [DONE]`
   message.**" Model `deepseek-v4-flash`; Codex adaptation is explicit; public
   beta per the 2026-07-31 changelog entry.
2. Live probe, short turn: HTTP 200, first event at 0.22 s, stream **closed** at
   0.78 s after `response.completed`. No hang.
3. Live probe, tool-call replay (the #875 stall scenario — turn 2 after a
   `function_call_output`): closed at 0.72 s, last events
   `…output_item.done → response.completed`. No stall after tool results.
4. Live probe, 1500-word essay: 4149 events, first event 0.23 s, max inter-event
   gap 0.29 s, `response.completed` at 46.41 s, socket closed 46.42 s. The same
   turn under today's bounded-JSON policy delivers nothing for ~46 s.
5. Our own relay already handles the no-`[DONE]` shape:
   `src/server/relay.ts` (`createSseTerminalOutputBoundary`) treats a Responses
   terminal event as the protocol boundary and appends the conventional
   `data: [DONE]` itself when the upstream never sent one (commit 02ca79a37,
   "close passthrough streams at terminal events"). The WS bridge
   (`pumpResponsesSseToWebSocket`) likewise terminates on
   `response.completed|failed|incomplete` and never waits for `[DONE]`.

## Root cause of the original #875 stall (best supported reading)

The 2026-07-31-era DeepSeek Responses beta stream reportedly "delivered output
without closing on the terminal event". Whatever the historical truth, the
CURRENT upstream (probed today, including the exact tool-result replay shape
that stalled) emits the documented terminal and closes the socket. With
02ca79a37's terminal-boundary relay in place, even a gateway that leaves the
HTTP connection open after `response.completed` is cut off at the terminal
block and `[DONE]` is synthesized. The belt-and-suspenders `stream:false`
force is therefore no longer load-bearing for correctness, but it is now the
direct cause of the reported UX regression.

## Change map (one work-phase)

- MODIFY `src/providers/registry.ts`
  - DELETE the `modelResponsesUpstreamStreaming: { "deepseek-v4-flash": false }`
    line from the deepseek entry (and its comment block), restoring true
    streaming on the native Responses wire.
  - KEEP `responsesItemIdRepair`, `responsesPath`, `statelessResponses`,
    `preserveResponsesReasoningContent`, `supportsServiceTier` untouched.
  - The `modelResponsesUpstreamStreaming` registry FIELD and its resolver
    (`providerModelResponsesUpstreamStreaming`) STAY — the mechanism remains
    available for providers that genuinely need it; only DeepSeek's entry stops
    using it. Consumers in `src/server/responses/core.ts` short-circuit to
    `undefined` and become inert for deepseek automatically.
  - **Reachability disposition (audit round 1, blocker 2):** after the deletion
    no production registry entry opts in, so the `=== false` branches at
    core.ts:899 / :2322 / :2349 have no production activator. This is a
    DELIBERATE retention of a rollback knob, not an oversight: DeepSeek's
    Responses route is public beta (changelog 2026-07-31), and the #875
    symptom class returns with a one-line registry re-add if the upstream
    regresses. Test reachability is preserved by the synthetic-registry
    fixture below, so the branches stay exercised by the suite even with no
    production user.
- MODIFY `tests/deepseek-inbound-wire.test.ts`
  - Per-test disposition (audit round 1, blockers 2-3 — all eight pinned
    tests):
    | Test (current line) | Disposition |
    |---|---|
    | WS turn asks bounded JSON upstream (:129) | REWRITE — WS turn keeps `stream:true` upstream |
    | WS turn keeps plain JSON downstream (:135) | REWRITE — WS turn returns an SSE body (content-type text/event-stream) that index.ts feeds to the WS pump |
    | HTTP turns use bounded JSON (#875) (:156) | REWRITE — HTTP Responses inbound keeps `stream:true` upstream |
    | HTTP synthesized terminal SSE (#875) (:164) | REWRITE — upstream SSE (UUID `output_item.added` → deltas → `response.completed`, NO `[DONE]`) relays through with terminal close + synthesized `[DONE]` |
    | Synthesized-SSE id repair (:250) | MOVE to synthetic-registry fixture (mechanism coverage) |
    | WS bounded-JSON id repair (:271) | MOVE to synthetic-registry fixture (mechanism coverage) |
    | No-repair byte-identical bounded JSON (:290) | MOVE to synthetic-registry fixture (generic JSON path) |
    | Bounded-body size limit (:308) | MOVE to synthetic-registry fixture (generic JSON path) |
  - NEW streamed #938 integration case: drive `handleResponses` with a mock
    upstream emitting UUID-bearing `response.output_item.added` + delta +
    terminal frames WITHOUT `[DONE]`; assert canonical `msg_`/`rs_` ids reach
    the HTTP SSE client (the relay id-repair path at core.ts:2095, already
    unit-covered in tests/responses-item-id-repair.test.ts, gets deepseek
    integration proof).
  - **Synthetic-registry fixture (concrete, replaces the round-1 "provider
    override if available" hand-wave):** `PROVIDER_REGISTRY` is an exported
    mutable array (`src/providers/registry.ts`); the fixture pushes a
    dedicated entry (`id: "bounded-json-fixture"`, `adapter:
    "openai-responses"`, distinct baseUrl, `modelResponsesUpstreamStreaming:
    { "fixture-model": false }`, plus the id-repair policy) in `beforeEach`
    and pops it in `afterEach`, with a provider config matching the entry's
    transport so `providerMatchesRegistryTransport` accepts it. The four
    moved tests run against this fixture, keeping every bounded-JSON branch
    reachable from the suite.
- MODIFY `tests/deepseek-responses-item-id-repair.test.ts` (audit round 1,
  blocker 1 — this file also pins the bounded-JSON contract at :119/:150)
  - Rewrite its deepseek integration cases around a real streamed SSE
    upstream (UUID ids in `output_item.added`/`output_item.done` frames, no
    `[DONE]`), asserting repaired ids in the relayed stream; keep its pure
    rewrite-unit coverage untouched.
- MODIFY `structure/04_transports-and-sidecars.md`
  - Update the DeepSeek bounded-JSON paragraph: policy mechanism remains,
    deepseek entry no longer opts in; terminal handling is the relay boundary
    (02ca79a37) + documented `response.completed` terminal.
- MODIFY `devlog/_fin/260806_overnight_triage_round2/002_issue_1065_rca.md`
  (audit round 1, minor 4) — append a dated supersession note: the
  "keep bounded JSON, do not restore streaming" disposition is superseded by
  this unit (fresh 2026-08-07 upstream probes show terminal-closing streams;
  the first-byte-deadline fix that RCA shipped remains valid for the
  synthetic-fixture path).

## Out of scope

- No change to Chat/Anthropic inbound wiring (they stay on /chat/completions).
- No change to the bounded-body primitive, first-byte deadline, or WS bridge.
- No change to other providers' `modelResponsesUpstreamStreaming` usage
  (none exist today — deepseek is the only user — but the field survives).

## Accept criteria

1. `bun run typecheck` clean; `bun run test` green (full suite — shared
   registry + responses core touched).
2. Activation evidence (C-ACTIVATION-GROUNDING-01): live `curl` through the
   running proxy with `stream:true` shows incremental `response.output_text.delta`
   events arriving BEFORE generation completes (first delta << total time), and
   the stream closes after `response.completed` + `[DONE]`.
3. Codex exec end-to-end: a tool-call turn against the live proxy still
   completes (no stall after function_call_output replay).
4. The mechanism tests prove bounded-JSON still works when a provider opts in
   (mechanism not dead).

## Risks

- DeepSeek Responses is public beta; a regression on their side would re-open
  #875 symptoms. Mitigation: the relay's terminal boundary already defends the
  no-close case, and the registry knob can be re-enabled in one line.
- WS path: Codex app connects over WS when available; the WS pump terminates on
  the terminal event, so live streaming is safe there too (426 fallback to HTTP
  SSE observed in codex exec runs; both paths covered by tests).
