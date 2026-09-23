# Live probe evidence — Anthropic OAuth `speed: "fast"` (2026-09-23 KST)

Mechanics: direct POST https://api.anthropic.com/v1/messages with the active ocx Anthropic OAuth credential and ocx's own OAuth fingerprint (`ANTHROPIC_OAUTH_BETA`, Claude Code system block, `CLAUDE_CODE_HEADERS`), `max_tokens: 256`, prompt "Reply with exactly: OK". Script kept in scratch (`.tmp/claude-fast/probe.ts`); no token printed or stored.

## Beta header

| Request | Result |
|---|---|
| claude-opus-5-5, speed fast, no fast beta | 400 `speed: Extra inputs are not permitted` |
| claude-opus-5-5, speed fast, `fast-mode-2026-02-01` | 429 `rate_limit_error: Usage credits are required for fast mode.` |
| claude-opus-5-5, speed `turbo` + beta | 400 `speed: Input should be 'standard' or 'fast'` |
| claude-opus-5-5, speed `standard` + beta | 200, `usage.speed: "standard"` |

## Model matrix (active account, standard control vs speed fast + beta)

| Model | Standard | Fast |
|---|---|---|
| claude-opus-5-5 | 200 OK | 429 usage credits required |
| claude-opus-5 | 200 OK | 429 usage credits required |
| claude-opus-4-8 | 200 OK | 429 usage credits required |
| claude-opus-4-7 | 200 OK | 400 does not support the `speed` parameter |
| claude-opus-4-6 | 200 OK | 200, `usage.speed: "standard"` (silent downgrade, documented) |
| claude-fable-5-1 | 200 OK | 400 does not support `speed` |
| claude-fable-5 | 200 OK | 400 does not support `speed` |
| claude-sonnet-5 | 200 OK | 400 does not support `speed` |
| claude-sonnet-4-6 | 200 OK | 400 does not support `speed` |
| claude-haiku-4-5 | 200 OK | 400 does not support `speed` |

Every configured Claude model works on the OAuth lane at standard speed. Standard responses carry `usage.service_tier: "standard"` and no `usage.speed`.

## Accounts (claude-opus-5-5, speed fast + beta)

| Pool slot | Result |
|---|---|
| 1 (active) – 4 | 429 `Usage credits are required for fast mode.` |
| 5, 6 | 400 `Fast mode is not enabled for your organization. An organization admin must enable this feature.` |

No account currently serves a fast turn: the feature is on, but fast draws on usage credits (extra usage), which none of the four personal accounts has funded, and the two org accounts have it disabled by admin.

## Streaming

claude-opus-4-6 fast stream: the echo is in `message_start.message.usage.speed` ("standard"); `message_delta.usage` carries no speed.
