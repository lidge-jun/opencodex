# Outcome

Unit closed 2026-09-01. Every phase is on `dev`.

| Phase | Doc | PR | On `dev` as |
|---|---|---|---|
| wp1 | 000 | #3092 | `5ef84b61e` -- roadmap, docs only |
| wp2 | 010 | #3093 | `a11038cb2` -- wire the committed assets + gap guard |
| wp3/wp4 | 020, 030 | #3095 | `910b4c736` -- 26 marks sourced |
| wp5 | 040 | #3098 | `15f92e3f6` -- the painting contract |
| wp6 | 050 | #3099 | `d71aa07c0` -- catalog marks |

Providers resolving a mark: **45 -> 77 of 83**. Painting split on the merged
head: 47 image, 17 mask, 7 light plate, 6 dark plate.

## What the plan got wrong

**One plate is not enough.** 040 specified a single constant light plate for
colour artwork too dark for the dark tile. That fixed twelve marks and broke
nothing, but it left six others still failing -- `parallel` at 1.00 dominant
luminance, `bizrouter` 0.98, `nebius` 0.87 -- because their artwork is near-*white*,
drawn for a dark header. They needed the opposite plate. The doc had assumed the
failure mode was one-directional because every example it had was.

**A mark can solve this itself.** `digitalocean.svg` carries its own
`@media (prefers-color-scheme: dark)` rule that repaints the glyph `#F4F5F5`.
Plating it defeated the vendor and produced light-on-light at 1.01:1 -- worse
than doing nothing. Nothing in the plan anticipated an asset that adapts, and
only rendered measurement caught it; reading the file's fill colour says #000 and
stops there.

**Tracing a favicon traces the plate.** 020 described the vectorization path as
settled work because `hermes-agent.svg` and `gajae-code.svg` had gone smoothly.
Those sources were transparent-background artwork. A favicon is usually a glyph
on a filled rounded square, and the first pass traced the square: `baseten` came
out 97.7% ink, `bizrouter` 89.3%. Border-ring plate detection was added and found
real plates behind six assets.

**The gap was older and wider than the count suggested.** The luminance guard,
written for the 26 new marks, immediately failed on five old ones:
`opencode.svg` (#211e1e) and `kimi-color.svg` (#1a1a1a) are the very files the
Integrations page already masks -- invisible on the provider surface the whole
time, because the two surfaces had no shared decision. `grok.svg` is the same
story one PR later. `ollama-color.svg` and `vercel-ai-gateway-color.svg` had never
been caught by either pass.

## Six providers keep the fallback tile

`chutes`, `nscale`, `tencent-coding-plan`, and the three `volcengine` plan ids.
Each was probed at its registry `baseUrl` and `dashboardUrl`, its docs subdomain,
and the conventional icon paths. What was found and why it was refused is in the
provider-icons README. A recorded empty is a result; borrowing a neighbouring
brand's mark would be a misattribution that outlives the commit.

## Verification as merged

CI green on every PR head, including the unsharded macOS job, before each admin
squash merge. On `d71aa07c0`: root and gui `tsc --noEmit` exit 0, `oxlint` clean,
`privacy:scan` clean. Every guard added in this unit was driven red before being
kept -- eleven falsifications across five test files.
