# Contradiction Scan Round 2 (post-answer, Mind dispatch)

Date: 2026-07-12
Phase: I (INTERVIEW)
Minds: Noether (ontology, 9 findings), Avicenna (constraint/vision, 5 findings)

## User Answers Recorded (round 2 input)

- AUTH: Anthropic sidecar = claude OAuth ONLY. Activate only when a Claude
  OAuth credential exists; no API-key billing path.
- CONFIG: global default exposure; luna is the fallback WHEN anthropic is
  not configured. Claude GUI tab can set a separate model override; unset
  there -> the gpt/global model applies.
- IMAGES: the question is "claude에서 이미지 사이드카가 과연 가능한지" —
  can a Claude model back the vision (image-describe) sidecar.

## CRITICAL REFRAME (Noether #4, HIGH-impact medium)

The user's observed "Did 0 searches in 40s" case is NOT the sidecar path.
Every gpt-capable provider in the live config (openai, chatgpt) is
authMode:"forward" => Claude Code + gpt model takes the NATIVE PASSTHROUGH
branch (claude-messages.ts:292-296 nativeRoute). web_search runs
SERVER-SIDE on the ChatGPT backend. The ONLY gap for this cell is
outbound.ts:268 dropping web_search_call frames instead of translating
them to server_tool_use + web_search_tool_result blocks.
=> Fixing outbound translation alone repairs the user's observed case,
   with zero sidecar work.

## Corrections to earlier devlog claims (00/01/02)

- WRONG: "sidecar runs on the Claude Code routed path today." Reality: it
  is UNREACHABLE there (Noether #1). claude-messages.ts:331 strips the
  caller authorization; authContext resolves kind:"main"; planWebSearch
  bails at web-search/index.ts:102. Also the luna executor copies auth
  from selectedForwardHeaders, which are empty on this path.
- WRONG: "vision sidecar believed working on Claude inbound." Reality
  (Avicenna #1): same auth hole — planVisionSidecar returns undefined and
  stripImagesInPlace replaces images with "[image omitted: no ChatGPT
  login]" unless a Codex account POOL resolves (kind main-pool/pool).
- WRONG: provider id "anthropic-pb51d9b" — that is a log label; the live
  provider id is `anthropic` (authMode:"oauth") (Noether #8).
- IMPRECISE: activation condition "incoming authorization header" — real
  gate receives selectedForwardHeaders and is skipped entirely for
  pool/main-pool contexts (Noether #9).

## Contradiction Triage

HIGH (folded into plan; no user re-ask needed, evidence-resolved):
- N1: Claude routed path sidecar unreachable -> plan must add main-token
  (or stored-credential) injection for sidecar calls on Claude inbound.
- N2: planWebSearch hardwires forwardProvider (non-optional) -> plan/
  executor split must be restructured into backend-pluggable SidecarPlan.
- N3: anthropic sidecar activation must key off STORED provider credential
  (getValidAccessToken("anthropic")), never the incoming header.
- A1: vision sidecar auth hole on Claude inbound (same fix family as N1).
- A2: vision executor equally hardwired -> second executor needed for a
  Claude vision backend.

MEDIUM/LOW -> OPEN ASSUMPTIONS:
- OA-5 (N5): no reusable Anthropic SSE parser for server_tool_use /
  web_search_tool_result; adapters/anthropic.ts parseStream drops them.
  New parser+executor required for the anthropic search backend.
- OA-6 (N6): anthropic OAuth fingerprint constraint — executor request
  MUST carry CLAUDE_CODE_SYSTEM_INSTRUCTION as first system block +
  ANTHROPIC_OAUTH_BETA + CLAUDE_CODE_HEADERS, or the OAuth spoof breaks.
  web_search is exempted in ANTHROPIC_BUILTIN_TOOLS (oauth/anthropic.ts:17)
  => OAuth CAN run the tool.
- OA-7 (N7): precedence conflict between credential-driven default (a)
  and config-driven global (b). Proposed: explicit global backend wins;
  when unset, default = anthropic if OAuth credential exists else luna.
  (pending user confirm)
- OA-8 (A4): stored-OAuth proxy-initiated calls have precedent (quota
  polling, oauth providers w/ getValidAccessToken) => anthropic sidecar
  usable from Codex clients too. OA-1 reframed: token availability is
  solved; remaining question was billing, settled by OAuth-only decision.
- OA-9 (A5): vision sidecar has NO per-turn cap and NO description cache;
  it re-describes every historical image on every request. A Claude-backed
  vision sidecar without cap+cache burns subscription quota. Plan must add
  both regardless of backend.

## Answer to user's image question (evidence-backed)

"claude에서 이미지 사이드카 가능한지" => YES, feasible:
- anthropic adapter already builds image blocks (base64 + url, even inside
  tool_result) with per-request image-count guard (A3).
- OAuth proxy-initiated call precedent exists (A4).
- Required work: (1) second describe-executor speaking /v1/messages with
  OAuth fingerprint headers, (2) the Claude-inbound auth fix so ANY vision
  sidecar can fire there, (3) per-turn cap + description cache (OA-9).

## Scan round evidence

Round 2 complete: 2 Minds dispatched (explorer role, non-full-history),
14 findings, 5 HIGH folded into plan constraints, 5 OPEN ASSUMPTIONS
recorded, 1 user confirmation pending (OA-7 precedence).

## Scan round 3 (no-delta)

request_user_input returned empty answers (dialog dismissed). No new
information entered the interview => inline rescan is a no-op; no Mind
dispatch (nothing to contradict). Pending user confirmations remain:
scope (3-phase vs subset), backend precedence (explicit-config-first
recommended), proceed-to-Plan fork. Re-asking as one consolidated question.

## Scan round 4 (no-delta, dialog fatigue)

Second consecutive empty request_user_input return. Interpreting as
dialog-fatigue, not as answers. No new information => no Mind dispatch.
Interview stays OPEN at the proceed fork; confirmation moved to plain-text
final message. Assumption set if user says proceed:
- SCOPE: 3 phases (outbound translation -> anthropic search sidecar ->
  claude vision sidecar with auth fix + cap/cache).
- PRECEDENCE: explicit global backend wins; unset => anthropic when OAuth
  credential exists, else luna.

## Round 5 — user confirms the reframe (plain text)

User: already knew search executes (server-side gpt / luna) and results
arrive; the work is returning them the way Claude expects, with prompt
shaping hidden at the opencodex layer. => Goal dimension CONFIRMED:
format-faithful return to Claude Code is the primary deliverable
(outbound web_search_call -> server_tool_use + web_search_tool_result).
No new contradiction surface introduced; inline rescan no-delta.

## Round 6 — FINAL user decisions (interview close)

- CONFIG SURFACE (final): main settings expose exactly TWO sidecar
  settings — (1) web-search sidecar, (2) image/vision sidecar (backend +
  model each). Claude tab gets per-client override of the same two.
- SCOPE (final): full matrix — anthropic search executor (Codex-format
  return rides existing bridge), claude vision executor, claude outbound
  translation, auth-hole fix. "각각 호환 코드" = 2 executors + 1 outbound
  translator + reachability fix.
- MODE: HOTL loop, multiple PABCD cycles, sol subagent reviews.
Interview CLOSED -> P.
