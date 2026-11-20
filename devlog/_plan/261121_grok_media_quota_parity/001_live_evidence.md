# Live evidence (2026-11-21)

Docs were read through Aside (`browse.readText` on the `.md` form of each docs.x.ai page, plus the
parent research dump under the Aside artifacts directory). Live calls used the stored Grok OAuth
grant against `api.x.ai` and the main ChatGPT login; identifiers are redacted, balances omitted.

## Images (docs.x.ai)

- `grok-imagine-image-quality` retired 2026-11-02; requests are served by `grok-imagine-image-2.0`
  at `quality: "low"` (migration guide, release notes).
- `quality` accepts `low | medium | auto` and only on `grok-imagine-image-2.0`; default `auto`
  (low for generation, medium for edits). Up to five source images per edit; `21:9` and `5:2` added.

Live:

| Request | Result |
|---|---|
| 2.0, `quality: "bogus"` | 422, expected one of `low, medium, high, auto` (deserializer) |
| 2.0, `quality: "high"` | 400 `This model only supports the following quality value(s): low, medium, auto.` |
| 2.0, `aspect_ratio: "7:3"` | 422 listing `1:1 3:4 4:3 9:16 16:9 2:3 3:2 9:19.5 19.5:9 9:20 20:9 1:2 2:1 21:9 5:2 auto` |
| 2.0, `resolution: "4k"` | 422 listing `1k 2k 1.5k` |
| 2.0, low, 21:9 | 200, `cost_in_usd_ticks` 400000000 ($0.04) |
| `grok-imagine-image` (1.0), `quality: "low"` | 200, $0.02 — not rejected, but the docs limit `quality` to 2.0 |
| `grok-imagine-image-quality`, `quality: "medium"` | 200, billed $0.04, the 2.0 low price; the migration guide states the slug is served by 2.0 at low |
| `GET /v1/image-generation-models` | `grok-imagine-image` and `grok-imagine-image-2.0` only; 2.0 lists low/medium × 1k/1.5k/2k prices |

So OpenCodex's current default (the retired slug, no `quality`) is served as 2.0 low per the migration guide (billing agrees), and an
OpenAI `high` must be sent as `medium`, never `high`.

## Video (docs.x.ai)

| Capability | 1.5 | 1.5-lite | grok-imagine-video |
|---|---|---|---|
| T2V / I2V | up to 1080p native | up to 1080p (upscaled 720p) | up to 720p |
| reference_images | 14 | no | 7 |
| last_frame / keyframes (≤4) | yes | no | no |
| aspect ratios | 1:1 16:9 9:16 4:3 3:4 3:2 2:3 21:9 5:2 | same | same |
| price | $0.08/s | $0.02/s | $0.05/s |

Poll: `status` is `pending | done | failed`; failed carries `error{code,message}`.

Live (all validation errors are free, synchronous 400/422):

| Request | Result |
|---|---|
| lite + last_frame / keyframes / reference_images | 400 `` `<field>` is not supported for this model. `` |
| grok-imagine-video + 1080p | 400 `1080p video resolution is not available for this model.` |
| 1.5 keyframe at 5 s in a 2 s clip | 400 `must be strictly inside the clip (0 < t < 2s)` |
| 1.5 with five keyframes | 400 `Too many keyframes: 5. Maximum allowed is 4.` |
| lite, 1080p, 1 s | 200 → poll done, `model: grok-imagine-video-1.5-lite`, $0.14 |
| 1.5, image + last_frame, 480p, 1 s | 200 → poll done, $0.10 |

Upstream error text is precise, but OpenCodex currently replaces it with `xAI videos API returned 400`.
The OAuth grant's media spend drew from the subscription weekly pool (`creditUsagePercent` 5 → 6
after about $0.34); `onDemandCap` and `prepaidBalance` were 0, so no credit could be spent.

## Codex quota

- `GET /wham/usage` (Pro): `primary_window` is 7 days (604800 s), `secondary_window: null`.
  Additional fields not modelled by OpenCodex: `rate_limit.limit_reached`, `reset_after_seconds`,
  `code_review_rate_limit`, `model_usage`, `credits.approx_*_messages`,
  `spend_control.individual_limit`, `rate_limit_reached_type`, `promo`,
  `rate_limit_reset_credits.applicable_available_count`.
- `GET /wham/rate-limit-reset-credits`: `credits`, `available_count`, `total_earned_count`,
  `immediate_reset_purchase_eligible`, `history_enabled`.
- openai/codex main (`codex-rs/backend-client`, read 2026-11-21): credit rows are
  `{id, reset_type, status, granted_at, expires_at: Option<String>, title?, description?}`; consume
  takes `redeem_request_id` and an optional `credit_id`; the usage summary still reads only
  `available_count`.
- Running the capture through `parseUsageQuota` gives weekly 0 % with the right reset and no short
  window; the pool and main observations mark the short and monthly windows absent (Terra audit lane).

## Grok quota and coupons

- `GET cli-chat-proxy.grok.com/v1/billing?format=credits`: `currentPeriod{type: USAGE_PERIOD_TYPE_WEEKLY,
  start, end}`, `creditUsagePercent`, `onDemandCap`, `onDemandUsed`, `productUsage[{product, usagePercent}]`,
  `isUnifiedBillingUser`, `prepaidBalance`, `topUpMethod`, `billingPeriodStart/End`.
  `parseXaiCreditsResponse` reads percent and end correctly.
- Legacy `/v1/billing` returns a zero monthly limit for unified-billing users; the parser's null is correct.
- `GetRemainingResets` returned gRPC status 0 and one empty message (no coupons on this account),
  which decodes to `[]`. Docs: one usage reset per paid referral, added 7 days after payment,
  valid six months; after one is used another cannot be used for a while (length unpublished).
- `grok_api_v2.GrokBuildBilling/GetRemainingResets` also answers status 0 with an empty message, and
  `GetGrokCreditsConfig` returns period type 2 (WEEKLY) with the same start/end as the JSON billing route.

## Cross-check with the parent research reports

The parent Aside reports (openai-codex-report.md, xai-grok-report.md, 2026-11-21) agree with the live
results above. Corrections they carry: `-pro` was retired on 2026-05-15 (to `-quality`), 2.0 has no
`high`, Lite 1080p is an upscale priced about $0.14/s (matches the live charge), 1.5 reference-to-video
caps at 720p, `last_frame` is in the guides but not the REST schema (live accepted it), Codex Pro plans
have only a weekly window, Codex reset credits expire 30 days after grant, and plan types are
`prolite`/`pro`/`promax` (Pro 100/200/500).
