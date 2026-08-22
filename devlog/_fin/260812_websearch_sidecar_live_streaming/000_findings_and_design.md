# Web-search sidecar: opt-in live streaming (`streamRoutedModelOutput`)

Date: 2026-08-12. Follow-up to `260806_codex_desktop_streaming/000_findings.md` — this identifies
the concrete cause of the "chat answers arrive as one end-of-turn burst" symptom that investigation
left open, and lands the fix.

## Root cause (reproduced end-to-end)

Codex CLI/Desktop sends a hosted `web_search` tool on every real turn. For routed (non-passthrough)
models with a usable ChatGPT credential, `planWebSearch` engages the web-search sidecar, and
`runWithWebSearch` → `consumeIterationEvents` **fully buffers** every semantic adapter event of an
iteration before scanning for `web_search` calls. Client-visible output therefore arrives only at
turn end — 6–50 s of silence on reasoning-heavy turns, then a burst.

Evidence chain (all on one machine, same provider `opencode-go/deepseek-v4-flash`, same key):

- Two bit-identical proxy installs behaved differently: the instance with ChatGPT auth buffered
  (`firstOutputMs ≈ durationMs` on 99/103 conversation requests), the instance with an EMPTY
  `CODEX_HOME` streamed (`firstOutputMs ≈ 1.5–3 s`) — because only the former could engage the
  sidecar.
- Byte-identical replay of a captured real `codex exec` request: buffered on the sidecar-enabled
  instance, streamed on the other. Field bisect: removing only the `web_search` tool made the
  sidecar-enabled instance stream (first delta 3.5 s, 448 deltas); removing `tool_search` /
  `namespace` tools did not.

## Why buffering exists, and what the fix preserves

Buffering keeps two invariants: (1) the synthetic `web_search` tool call must never leak to Codex,
and (2) preliminary output from a pre-search iteration must not surface as the answer. The fix
keeps both by construction:

- Live delivery is **opt-in** (`webSearchSidecar.streamRoutedModelOutput`, default `false`).
- Only event types the sidecar-less path would deliver identically may leave the live window:
  `text_delta`, `thinking_delta`, `reasoning_raw_delta`, `thinking_signature`,
  `redacted_thinking`, `kiro_redacted_reasoning` (allowlist in `loop.ts`).
- The window closes permanently at the first buffer-only event — tool calls above all — so the
  `web_search` interception decision stays atomic and live events are exactly the first N
  passthrough entries. The terminal replay skips them by count; nothing is delivered twice.
- Scanner semantics are unchanged: live events are still buffered for `extractIterationThinking`
  and the forced-answer output check (#1001 behavior intact).

Accepted tradeoff (documented in `docs-site/.../sidecars.md`): text the model emits before deciding
to search — which buffered mode silently drops — becomes visible and may partially repeat in the
post-search answer. Reasoning-first models (the common case) avoid the text-repetition case, though
their leading reasoning deltas become client-visible too — that visibility is the point of the
option.

## Verification

- `bun test tests/web-search.test.ts` — 55 pass, including 4 new tests: a gated adapter proves
  deltas reach the client while the adapter is still mid-turn (buffered mode would deadlock the
  gate); default-off buffering; window close at `tool_call_start` with exactly-once replay of the
  tail; search-loop pass with pre-search text delivered exactly once.
- `bun test tests/web-search-*.test.ts` — 78 pass. `bun x tsc --noEmit` clean.
- Live replay of the captured Codex request through a patched instance (sidecar-less path):
  893 deltas, first at 2.6–3.3 s, unchanged totals.
- Sidecar-ACTIVE live E2E (patched build running as the native-main owner with a real ChatGPT
  credential, identical text-forcing request, routed `opencode-go/deepseek-v4-flash`): toggle off →
  18.3 s silence then 2829 deltas in one 0.02 s burst; toggle on → first delta at 4.0 s, 2538
  deltas over 9.9 s. The toggle applied without restart via `PUT /api/sidecar-settings`.
  Field note: a paused ChatGPT account (`pausedCodexAccountIds`) silently disables the sidecar and
  masks both bug and fix — everything streams because the sidecar-less path runs.
