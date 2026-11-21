# Grok media and quota parity — plan

Date: 2026-11-21. Branch `codex/261121-grok-media-quota-parity`, base `origin/dev` 3bc34e67ac.

## Objective

Bring the Grok Imagine image and video bridges and the Codex/Grok quota and reset logic up to the
behavior xAI and OpenAI ship today, verified against official docs and live read-only API responses
(evidence in [001_live_evidence.md](./001_live_evidence.md)). One PR to `dev`, ordered commits.

## Constraints

- Behavior changes land with a failing-first deterministic test.
- `tests/server/server-images.test.ts` has one line of ratchet headroom (cap 2755); new relay
  cases go to a sibling file registered in `scripts/test-layout/layout.json` (or its shard) and a
  `tests/fixtures/test-layout-expected*.json` shard.
- Docs change in English and all eight locales (es, fr, ja, ko, ru, tr, zh-cn, zh-tw).
- Live probing never redeems a coupon, reset credit or credit; secrets never printed.

## Work-phase map (dependency order)

| Phase | Doc | Outcome |
|---|---|---|
| wp0 | 000-001 | This roadmap and the live evidence |
| wp1 | [010](./010_image_bridge.md) | Image bridge defaults to `grok-imagine-image-2.0`, sends `quality`, full aspect set, multi-image edits, upstream error text |
| wp2 | [020](./020_video_bridge.md) | Video bridge on 1.5 / 1.5-lite, 1080p, frame pins and references, capability-aware tool, upstream error text |
| wp3 | [030](./030_quota_parity.md) | Reset-credit DTO keeps non-expiring credits and carries the documented detail fields |
| wp4 | [040](./040_misc_scope.md) | Other non-LLM changes: applied or excluded with a reason |
| wp5 | — | PR, exact-head CI, final review |

## Out of scope

New Grok STT/TTS/voice relays (the audio routes are OpenAI-only), the vendored
`scripts/model-metadata.source.json` snapshot, ima2-gen and progrok.


## Roadmap audit

Three read-only Terra review rounds (same reviewer). Round 1 and 2 blockers were folded: local files are
never read for video inputs (artifact references resolve to the xAI URL the image bridge recorded),
upstream error text reaches callers only as canonical messages rebuilt from a closed vocabulary,
over-limit edits are rejected before any upstream call, unknown video models keep today's tool surface,
capacity test expectations are recalculated, and the media contract is recorded in
`structure/data-planes/images.md`. Round 3's remaining finding (template vocabulary) is folded into 010.
