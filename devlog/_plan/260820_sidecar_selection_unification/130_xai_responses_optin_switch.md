# 130 — xAI Responses opt-in switch (atomic persistence + GUI)

The Responses implementation survives as an explicit opt-in lane, like the x_search
opt-in block. Default: chat (post-#2227). Surface: xai is ONE provider id
(registry.ts:1000); the 'two pages' are the auth-mode-scoped sections (OAuth account +
API key) of the same provider workspace.

## Contract (audit R1-B2)

- Config truth: `modelAdapters` entries for grok-4.5 + grok-4.6 -> 'openai-responses'.
- Atomic management API: extend the provider PATCH surface (provider-routes.ts:378 area
  + gui provider-workspace DTO types.ts:88) with a split write/read contract:
  - WRITE (PATCH input): `xaiResponsesOptIn: boolean` — sets/clears BOTH grok model
    entries in one config transaction, preserving unrelated modelAdapters overrides.
  - READ (GET/echo DTO): `xaiResponsesOptInState: true | false | "mixed"` — partial
    pre-existing state (one model set, one not) reads "mixed"; the first boolean
    write normalizes both entries and the echo returns the effective state.
- GUI: one switch rendered in both auth-mode sections; mixed state shows indeterminate.
- Tier policy: the doc-100 unit already made the OAuth registry tier policy
  unconditional; the switch adds NO tier behavior. API-key route: opt-in flips wire
  only; everything else keeps current dev semantics (#2072 deferred).
- #2217 sanitize layers arm only on this opt-in Responses route (RESHAPE disposition).
- Tests: atomic set/clear, override preservation, mixed-state normalization, effective-
  state echo, GUI switch render + PATCH round-trip, opt-in wire selection E2E.
- Docs-site: provider page gains the switch row; structure/04 notes the opt-in lane.

Execution phase: wp11 (after #2227 unit + reshaped #2217; before release prep).
