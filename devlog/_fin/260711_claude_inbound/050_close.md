# 050 — Close-out: WP1-WP5 (claudecode branch)

HOTL goal loop (host goal + manual PABCD; `cxc` CLI absent — preflight noted in
000). Goalplan: `.codexclaw/goalplans/claude-inbound/`. All five work-phases
closed DONE except the one NEEDS_HUMAN item below.

## Shipped (commits on `claudecode`)

| Commit | Scope |
|---|---|
| 953fb5b9 | (pre-unit) model-ordering docs + v2 thread-limit work, committed on dev before branching |
| bb9da3ae | WP2 — core inbound: src/claude/{inbound,outbound}.ts, src/server/claude-messages.ts, routes, x-api-key auth, 19 tests |
| 103310a8 | WP3 — src/claude/alias.ts, discovery /v1/models branch, ocx claude launcher + help, 12 tests |
| 12e82239 | WP4 — GUI (Claude ON toggle + Claude page), /api/claude-code, i18n x4, docs-site x3, README x3, 3 tests |

## Deviations from the P docs (recorded, all deliberate)

1. **Path rename**: `src/anthropic/*` (010 draft) -> `src/claude/*` — avoids
   collision with the existing provider adapter `src/adapters/anthropic.ts`.
   Tests are `tests/claude-*.test.ts` for the same reason.
2. **Non-stream strategy**: routed adapters reject internal `stream:false`
   ("Non-streaming not supported by this adapter"), so the inbound ALWAYS
   replays with `stream:true` and folds the translated Anthropic SSE into a
   message JSON for non-streaming clients (`collectAnthropicMessage`).
3. **Error taxonomy shipped in WP2** (was 040 workstream 2) — table-driven, cheap.
4. **030's "section on Models page"** superseded by user spec: dedicated nav tab
   below API + sidebar literal "Claude ON" toggle (all locales).

## 040 workstream disposition

| Workstream | Status |
|---|---|
| 1. Thinking round-trip | v1 policy shipped: synthetic `signature_delta` out (CCR precedent, 003 E6), replayed thinking dropped in. Anthropic-family signed replay NOT built — 040's decision gate ("demonstrate a real failure first") stands |
| 2. Error parity | DONE in WP2 (taxonomy + retry-after passthrough + anthropic-shaped auth/origin rejections) |
| 3. Protocol edges | `?beta=true` path-match, heartbeat->ping, EOF-without-terminal clean close, cancellation via `abortSignal: req.signal` + stream `cancel()` propagation, non-stream native passthrough JSON fallback — all shipped. `HEAD /` probe: docs say rejectable; static handler answers GET, HEAD falls to 404 = acceptable per protocol reference |
| 4. Observability | Request log rows flow through the normal deferred-log path (model/provider populated after routing). `surface="claude"` tag + Logs filter chip = follow-up, not blocking |
| 5. ccs-wrapper banner + release | OUT OF SCOPE per goal (ccs-wrapper repo excluded; no release requested) |

## Gate evidence (fresh runs, 2026-07-11)

- `bun test ./tests/`: **2126 pass / 3 skip / 1 fail** — the fail is
  `install-scripts > Node can import the package main` which spawns `node`;
  `node` is not on this shell's PATH (pre-existing environment issue, fails
  identically before this branch's changes).
- `bun x tsc --noEmit`: clean.
- `cd gui && bun run build`: clean (tsc -b enforces i18n key parity).
- `cd docs-site && bun run build`: 55 pages, clean.
- Playwright visual QA against an isolated live server (port 18234):
  Claude page renders (en + ko), sidebar toggle shows literal "Claude ON" in
  Korean locale, click flips API `enabled` false->true round-trip, alias list
  renders 9 entries with honest display names.
- e2e streamed turn: mock openai-chat upstream -> `/v1/messages?beta=true` ->
  Anthropic SSE sequence asserted (tests/claude-messages-endpoint.test.ts).

## Live smoke round 1 (user, real Claude Code CLI) — 3 wire bugs found+fixed

User ran the real CLI against a branch build. Discovery WORKED (picker listed
`gpt-5.5 (native)` aliases, selection persisted), but turns failed. Each failure
was reproduced locally against the REAL ChatGPT backend and fixed:

| # | Symptom | Root cause (verified live) | Fix |
|---|---|---|---|
| 1 | `400 unsupported message role: system` | Claude Code sends `role:"system"` entries in `messages` despite the published API having no system role | inbound folds system-role messages into `instructions` (with top-level `system`, in order) |
| 2 | `400 upstream error (400)` (opaque) | native ChatGPT backend: `{"detail":"Unsupported parameter: max_output_tokens"}` — codex-shaped bodies only | claude-messages strips `max_output_tokens/temperature/top_p/stop/user` on `openai-responses` routes; error reshaping now surfaces upstream body text |
| 3 | (would-be) `401 {"detail":"Unauthorized"}` for pool-less installs | `ocx claude` placeholder Bearer was forwarded upstream as ChatGPT auth | internal replay strips `authorization`; native routes inject the main codex login (`getMainAccountToken`); pool rotation still overrides |
| 3b | `400 {"detail":"System messages are not allowed"}` | first fix for #1 mapped system-role to system message ITEMS — native backend rejects those | superseded by the instructions-folding fix |

Local live proof (isolated OPENCODEX_HOME, real backend): `claude-ocx-native--gpt-5.5`
and `claude-ocx-native--gpt-5.6-sol` with placeholder Bearer + system-role message ->
full `message_start .. text_delta("Hi"/" there"/", friend") .. message_delta(end_turn)
.. message_stop` sequence.

## NEEDS_HUMAN (remaining)

Re-run the CLI smoke on this build (fixes above are post-round-1): plain turn
should now answer; then a tool-use turn + a ROUTED (non-native) provider turn.

## Follow-ups (filed, non-blocking)

- `surface="claude"` request-log tag + GUI Logs filter chip (040 §4).
- Anthropic-family signed-thinking replay via ocxr1 envelope (040 §1) — only if
  a real replay failure is demonstrated.
- count_tokens drift check vs provider-reported input_tokens on live turns (040 §3).
- ccs-wrapper deprecation banner (separate repo, when touched next).
