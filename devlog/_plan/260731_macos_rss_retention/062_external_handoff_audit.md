# 062 — external handoff adjudication (ChatGPT branch + issue #820 ZIP)

Audited 2026-08-01 during wp5. Source: user-supplied ChatGPT branch
conversation ("램누수 문제 해결 요청") and its handoff ZIP
`opencodex-32-session-handoff-18545f87.zip` (54 files, baseline
`dev@18545f87e`, umbrella issue lidge-jun/opencodex#820). The ZIP's
`repo-dropin/devlog/_plan/260801_32_session_protocol_safe_memory/` is a
PROPOSED unit — nothing from it is auto-adopted; this doc records what
overlaps, what corrects us, and what is deferred.

## Overlap with this unit (already landed or in flight)

| Handoff item | Our state | Verdict |
|---|---|---|
| PR2 bounded/single-parse inspector (1 MiB frame, 256 items, 8 MiB bytes, parse-once, clear-after-callback, counters) | wp3 landed (41af6168e) with the same shape; frame cap 4 MiB per our audit round 1 blocker 4 (large agentic tool events) | CONVERGENT — no action. Cap difference is deliberate and recorded in 061. |
| PR4 one-reader relay opt-in behind runtime qualification | wp5 in flight (a209188fb + uncommitted repairs): darwin explicit `eager-relay` opt-in, `auto` stays tee, abort-stress gate | CONVERGENT — our gate is narrower (config-eager only), which the handoff's own "canary before default" ordering endorses. |
| Harness/metrics first (PR1) | wp2 landed (harness warm-gate fix + remote smoke); inspection counters on `/api/system/memory` (wp3) | PARTIAL — our counters are inspector-scoped; the 32-session app-owned byte metrics (reader/turn/lease/tool/request) are broader and deferred. |
| tee() as dominant amplifier + Bun allocator plateau residual | 000/051/053 established the same three-layer diagnosis independently | CONVERGENT. |

## New findings we did NOT have (deferred to a follow-up unit)

1. **Continuation last-entry cap hole:** `while (storedResponseBytes > byteCap() && states.size > 1)` never evicts the final entry — a single oversized response (images, giant tool results) can pin unbounded bytes for up to an hour, and a test locks this behavior in as policy. Handoff PR6 proposes a real hard cap + content-addressed blob refs. OUT of this unit's scope (state.ts is not in our IN list); flagged as the top candidate for the next unit.
2. **Cursor blob store byte hole:** count/TTL limited (4096/15min) but no byte cap or pinning. Same follow-up unit.
3. **32-session recall harness + turn lease + session lanes + active-load account scheduling (PR5/PR7):** architecture-level work under issue #820; separate planning cycle required.
4. **Eager-relay multiplication caveat:** 8 MiB queue + 15 s/32 MiB drain PER STREAM multiplies under 32 concurrent sessions (≈256 MiB queue + 1 GiB drain worst case). Our wp5 opt-in is single-user-scale; the multiplication concern belongs to the #820 unit and does not block the opt-in landing.

## Corrections the handoff makes to its own earlier advice (noted, no action)

- Tool-argument passthrough was retracted by the branch itself: OpenCodex is a
  protocol translator (MCP namespace flatten/restore, custom tool wrappers,
  reasoning signatures), so raw passthrough is not adoptable. Matches our 052
  finding that eager needs inline bounded transforms, not wrapper removal.
- The existing interleaved tool-call assembly (260709_parallel_tool_calls) is
  intentional; the handoff withdrew its initial claim that the bridge needed a
  live multi-call Map replacement.

## Decision

This unit (070–110) continues unchanged: the handoff independently converges
on the same P0s we already landed. Items 1–4 above go to a new unit after this
one closes — likely aligned with issue #820's PR3/PR5/PR6/PR7 split — with
fresh P-phase verification against whatever has landed by then.
