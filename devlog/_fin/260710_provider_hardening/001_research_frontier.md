# 001 — Frontier provider research (Aquinas, gpt-5.6-sol, 2026-07-10)

Tier-2 = source page actually opened. Unverified claims MUST NOT drive registry edits.

## OpenAI API — UNVERIFIED (freeze)

Model catalog / reasoning / deprecations pages all redirected to
`https://developers.openai.com/rss.xml`. gpt-5.5/gpt-5.6 lineup, context windows,
effort levels: all unverified. Registry action: FREEZE openai/openai-apikey model data.
Opened: developers.openai.com/api/docs/models, /guides/reasoning, /deprecations (all redirect).

## Anthropic API — VERIFIED

| id | ctx | thinking |
|----|-----|----------|
| claude-fable-5 | 1,000,000 | adaptive always-on; extended: no |
| claude-opus-4-8 | 1,000,000 | adaptive: yes; extended: no |
| claude-sonnet-5 | 1,000,000 | adaptive: yes; extended: no |
| claude-haiku-4-5-20251001 | 200,000 | extended: yes; adaptive: no |

Aliases: claude-fable-5, claude-opus-4-8, claude-sonnet-5, claude-haiku-4-5.
Lifecycle-active but detail-unverified: claude-opus-4-7, claude-opus-4-6,
claude-opus-4-5-20251101, claude-sonnet-4-6, claude-sonnet-4-5-20250929.
DROP now: claude-opus-4-20250514, claude-sonnet-4-20250514, claude-3-7-sonnet-20250219,
claude-3-5-haiku-20241022, claude-3-haiku-20240307, 3.5-sonnet snapshots,
claude-3-opus-20240229, 2.x/1.x/instant. DEPRECATED (remove before 2026-08-05):
claude-opus-4-1-20250805.
Opened: platform.claude.com/docs/en/about-claude/models/overview,
/model-deprecations, /build-with-claude/extended-thinking.

## Google Gemini API — VERIFIED (partial)

| id | ctx | thinking |
|----|-----|----------|
| gemini-3.5-flash (stable) | 1,000,000 | minimal/low/medium/high, default medium |
| gemini-3.1-pro-preview | unverified | low/medium/high, default high |
| gemini-3-flash-preview | unverified | minimal/low/medium/high, default high |

gemini-3-pro-preview: RETIRED. No gemini-3.5-pro documented.
DROP: gemini-3-pro-preview, gemini-3.1-flash-lite-preview, gemini-3.1-flash-image-preview,
2.5 preview snapshots, 2.0 text. Scheduled: 2.5 pro/flash/lite shutdown >= 2026-10-16.
Opened: ai.google.dev/gemini-api/docs/models, /thinking, /deprecations.

## xAI API — PARTIAL (freeze detail fields)

Docs nav names grok-4.5 latest; dynamic routes exist for grok-4.5,
grok-4-1-fast-reasoning, grok-4-1-fast-non-reasoning, grok-code-fast-1. Pages
returned nav shells only — ctx/effort/retirement tables unreadable => unverified.
Registry action: keep current xai entry (refreshed 260709 from account-verified
evidence), no automatic changes.
Opened: docs.x.ai/developers/models, /grok-4-5, /model-capabilities/text/reasoning,
/migration/may-15-retirement (shells).
