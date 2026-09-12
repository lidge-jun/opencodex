# Live probe evidence — xAI Grok OAuth service_tier "priority" (2026-09-13, KST)

Mechanics: temporary `providers.xai.modelSupportsServiceTier` override in ~/.opencodex/config.json + POST /api/providers/reload (local one-shot capability, same path ocx's OAuth login uses). Probes: POST /v1/responses and /v1/chat/completions on the running proxy (127.0.0.1:10100, ocx 2.53.0) with model `xai/<id>--fast`. Every attempt logged credentialSource "grok-oauth", account of97b31. No API key involved.

## Matrix (Responses inbound)

| Model | HTTP | Upstream adapter | service_tier sent | service_tier echoed (ocx telemetry) | ocx fastOutcome/confirmation | Client body echo |
|---|---|---|---|---|---|---|
| grok-4.6 | 200 | openai-responses | priority | priority | applied/confirmed | yes |
| grok-4.5 | 200 | openai-responses | priority | priority | applied/confirmed | yes |
| grok-4.3 | 200 | openai-chat | priority | priority | applied/confirmed | NO (relay gap) |
| grok-4.20-0309-reasoning | 200 | openai-chat | priority | priority | applied/confirmed | NO (relay gap) |
| grok-4.20-0309-non-reasoning | 200 | openai-chat | priority | priority | applied/confirmed | NO (relay gap) |
| grok-build-0.1 | 200 | openai-chat | priority | priority | applied/confirmed | NO (relay gap) |
| grok-composer-2.5-fast | 200 | openai-chat | priority | priority | applied/confirmed | NO (relay gap) |
| grok-4.20-multi-agent-0309 | 200 | openai-responses | priority | default | downgraded/downgraded | "default" |

Request-id tails (ocx logs, 2026-09-13 00:4x KST): fb8c252e (4.20-non-reasoning), ffc1ac24 + f3bcff76 (multi-agent downgrades), 30869a34 + 1e2591ba (build), edc0cd22 + b2ba02e8 (composer), 6ff095a8 (4.6), 8fd2f267 (4.5), db85c0e5 (4.3, full entry captured), bf503c88 (4.20-reasoning), 54edc3de (4.20-non-reasoning r2).

Chat inbound (/v1/chat/completions, --fast): grok-4.6 and grok-4.5 both 200 (chatcmpl-95b4236e…, chatcmpl-cb33c39d…). These routed over openai-responses here (config modelAdapters), so the chat-upstream echo is covered by the openai-chat rows above; hermes-agent#89440 independently reports the echo on native chat completions over SuperGrok Heavy OAuth.

Chat inbound direct relay probe (audit round 2): `xai/grok-4.3--fast` over /v1/chat/completions (openai-chat upstream, no modelAdapters override) — client body keys are exactly choices/created/id/model/object/usage with NO service_tier, while ocx telemetry for the same turn (request …6838b50b) records wireValue "priority", fastOutcome applied, confirmation confirmed, responseServiceTier "priority". The chat-inbound relay gap is therefore direct evidence, not code inference.

## Findings

1. The user's Grok OAuth (subscription) gateway accepts service_tier "priority" on every probed model — zero 400s, zero "Argument not supported" (the stale rejection hermes#28490 worked around).
2. Priority is honored (echoed priority) on 7 of 8 models. grok-4.20-multi-agent-0309 accepts the field but the gateway answers "default" — a live downgrade, excluded from the change.
3. Relay gap: for chat-wire models the echo reaches ocx attempt telemetry (tierOutcome.responseServiceTier "priority") but not the client body — 4.6/4.5 on the responses wire relay it, the chat-wire responses-lane and chat-inbound assemblies do not. D4 in 010_plan.md.
4. Post-probe live state (kept at user request): config override trimmed to the 7 honored models and reloaded; multi-agent re-disabled in the catalog; the 7 models left enabled with --fast rows live on the running proxy. Backup at ~/.opencodex/config.json.probe-bak.
