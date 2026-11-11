# Prior art: tokscale leaderboard

Source: [junhoyeo/tokscale](https://github.com/junhoyeo/tokscale) (MIT) README, its
[privacy policy](https://tokscale.ai/privacy) and [leaderboard](https://tokscale.ai/leaderboard), read 2026-11-09.

## UX

- Local stats work without any account. Joining the leaderboard is a separate, explicit action:
  `tokscale login` (GitHub OAuth), `tokscale whoami`, `tokscale submit`; `submit --dry-run` previews the upload.
- Headless/CI submission uses an API token created in the web settings (`TOKSCALE_API_TOKEN`).
- Public profile page `/u/<username>`, SVG embed and badge (`metric=tokens|cost|rank`).
- Settings can delete submitted data or the whole account, immediately.

## Data model

- Submission: `POST /api/submit` with aggregate usage. Server validation: required fields, mathematical
  consistency, non-negative values, no future dates, duplicate detection.
- Uploaded: token counts, estimated cost, per-day breakdowns, clients and models, message counts, session timing,
  MCP server names, CLI version, device labels.
- Public: username, avatar, display name, totals, contribution graph, client/model breakdowns, devices, groups;
  indexable by search engines. OAuth scopes `read:user`, `user:email`.

## What opencodex adopts and what it does not

| tokscale | opencodex profile v1 |
| --- | --- |
| Explicit login + submit, dry run | Explicit connect (human-only), status shows the exact next submission (`preview`). |
| Server validation (consistency, non-negative, no future, dedup) | Same, plus closed family roster, per-day plausibility caps, first-write-wins per (profile, day), no-backfill window. |
| GitHub identity, e-mail scope | Handle + server secret; no e-mail anywhere. GitHub device flow deferred (needs an OAuth app). |
| Public devices, session timing, MCP names, cost | Not collected. Only day totals, token buckets and model-family totals. |
| Avatar from GitHub | Closed colour palette, initials; no image URLs (no tracking pixels, no moderation surface). |
| Delete data/account | Disconnect deletes the profile and all rows; retried until confirmed. |

