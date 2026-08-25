# 111 — wp7 audit response: the plan was wrong, and the scope is bigger than #2568 states

Auditor verdict: **fail**, 7 blocking findings. I verified each against the tree. Six hold;
one I partially rebut. The honest conclusion is that `110` understated the problem badly
enough that it should not be implemented as written.

## Verified against the tree

**B1 — the call-site table was incomplete. ACCEPTED.** The three import-only files were
right, and the three direct callers were right, but there are two more LIVE rotation sites
reached through an injected `on429` hook rather than a direct call:
`src/images/loop.ts:574` and `src/web-search/loop.ts:511`, wired from
`core.ts:4267` and `core.ts:4355`. My `rg` for the symbol could not see them because the
call site passes a closure. That is exactly the failure mode hazard H4 warned about.

**B2 — the standalone Antigravity image endpoint bypasses core entirely. ACCEPTED.**
`src/server/images.ts` resolves the active OAuth token, reads its project separately, and
returns upstream 429 without any rotation.

**B3 — Cursor 429s never reach an HTTP-status rotator. ACCEPTED, and this is the finding
that breaks the plan.** Cursor converts transport failures into adapter EVENTS
(`src/adapters/cursor.ts:308`), and both the streaming and buffered paths have already
committed HTTP 200 by then (`core.ts:4556`, `:4619`). `cursor-errors.ts` classifies a bare
`resource_exhausted` tail into a 429 class at the ADAPTER layer, not as a response status.
So a `response.status === 429` loop — which is the entire mechanism #2568 proposes — cannot
serve Cursor at all. The issue names Cursor as an affected provider; the proposed design
cannot deliver it.

**B4 — a token-only resolver is unsafe. ACCEPTED.** `getValidAccessTokenForAccount` returns
a string, but Copilot credentials carry an account-specific `apiBaseUrl`
(`src/oauth/github-copilot.ts:281`) and Antigravity needs an account-matched `projectId`
that `core.ts:2780` deliberately keeps paired with the token snapshot precisely so "an
account rotation cannot mix a fresh token with project metadata re-read from a different
credential generation". The existing code already anticipated this hazard; my plan would
have reintroduced it.

**B5 — continuity/cache criteria absent. ACCEPTED.** Anthropic rebinds affinity on rotation
(`anthropic-routing.ts:490`); xAI pins conversation/session ids
(`providers/xai-transport.ts:105`); Cursor scopes checkpoints to credential identity
(`cursor/request-builder.ts:422`). A rotator that ignores these silently corrupts
continuation state rather than failing loudly.

**B7 — the acceptance criteria permitted a partial ship. ACCEPTED.** "A provider" and "one
replay" would have been satisfied by xAI-Responses-only, while Anthropic already allows
three failovers.

## Partial rebuttal

**B6 — opt-in vs presence-driven.** The auditor is right that the issue asks for failover
"without first discovering and enabling a toggle", and right that default-off lets the
implementation pass while the reported xAI workflow stays broken. I accept that as the
issue's contract.

Where I do not fully agree: the auditor treats this as a plan defect. It is a product
decision I was structurally unable to take — `request_user_input` is denied under an active
goal, and spending a second subscription account's quota by default is not a call an agent
should make silently. The correct resolution is not to pick a default under duress; it is to
escalate. Recorded as such below.

## Consequence: wp7 does not proceed as a single work-phase

The plan claimed a parameterization. The tree says otherwise: three distinct failure
surfaces (HTTP-status rotation, adapter-event classification, and a bypassing image
endpoint), three distinct credential shapes (bare token, token+apiBaseUrl,
token+projectId), and three distinct continuity contracts. That is a program, not a phase.

wp7 is therefore split, and the first unit is the only one that can be built safely without
an owner decision:

- **wp7a** — generic rotator for HTTP-status OAuth paths (`core.ts` streaming and
  non-streaming), with a per-provider credential resolver that returns the FULL snapshot
  (token plus whatever routing metadata that provider pairs with it), not a bare string.
  Gated behind an explicit knob so no default changes.
- **wp7b** — adapter-event 429 rotation, which is what Cursor actually needs.
- **wp7c** — `src/server/images.ts` and the injected `on429` sidecar loops.
- **wp7d** — the activation-default decision. **ESCALATE: needs the owner.**

## Escalation (NEEDS_HUMAN, recorded)

The default-on question is not mine to settle. Presence-driven rotation spends another
subscription account's quota without the operator asking for it in that moment; opt-in
leaves the issue's stated workflow broken. Both readings are defensible and the issue text
supports the auditor's. This phase reports **NEEDS_HUMAN** on that specific decision, and
implements nothing that depends on it.

