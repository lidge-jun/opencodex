# Sponsors

opencodex is an independent, MIT-licensed project maintained without company backing. Provider
sponsorships fund maintenance and keep the proxy current with every upstream protocol change.
This page is the public rule set: what a sponsor gets, who qualifies for which tier, and how to
ask. It is written so that a sponsor, a contributor, and a user reading the README all see the
same terms.

"Sponsor" here means a paying provider sponsor. It is unrelated to the `maintainer-sponsored`
label in [`MAINTAINERS.md`](./MAINTAINERS.md), which is about a maintainer vouching for a
contributor's change to a restricted surface.

Sponsorship buys placement and maintenance attention. It never buys a change in routing behavior,
a default model, a weaker security default, or an exception to the review policy in
[`MAINTAINERS.md`](./MAINTAINERS.md). A sponsored preset goes through the same registry
pattern, typecheck, tests, and review as any other provider.

## Tiers

Two tiers, split by what the sponsor is.

### Main — model developers

Reserved for organizations that train or host their own foundation models (the OpenAI,
Anthropic, Google, Moonshot, MiniMax class). API relays and gateways are never sold Main
regardless of budget.

Every model developer is supported as a first-class provider whether or not it sponsors; that
part does not change. A Main sponsor additionally receives:

- The single banner slot above the sponsor table in the README (one at a time; see
  [Placement](#placement)).
- First mention in the README login and provider lines (the "Log in once" OAuth paragraph and
  the Providers & adapters summary, both marked with a `sponsors:main-first-mention` comment)
  and priority ordering in the built-in provider picker.
- Everything in the Standard tier below.

### Standard — relays, gateways, and API resellers

For OpenAI-compatible relays, routers, gateways, and other resellers of model access. A Standard
sponsor receives:

- One row in the sponsor table: logo (about 150px wide, linking to the sponsor URL), a
  "Thanks to X for sponsoring this project!" line, and a blurb of up to about 80 English words
  supplied by the sponsor and published verbatim. The maintainer may decline or require edits to
  text that is false, misleading, disparages third parties, or breaches applicable law or GitHub
  policy. A second-language blurb (for example Chinese) may run alongside the English one.
- A built-in provider preset (`ocx provider select <id>`) shipped in a public npm release,
  listed near the top of the provider picker in the dashboard and CLI and marked as a sponsor
  there. (The registry field and picker ordering that back this land with the first sponsor
  preset; today the picker follows registry order.)
- A detailed entry on the [providers page](https://opencodex.me/guides/providers/) of the docs
  site.
- Maintenance: if a release breaks the preset or its adapter, the maintainer fixes it; issues
  filed against that provider are triaged first. There is no response-time SLA.

## Placement

The README sponsor section sits directly under **Quick start**, before the Docker Compose
details, so it is on screen before a first-time visitor scrolls. Inside the section:

1. One Main banner (empty until a Main sponsor signs).
2. The Standard table, one row per sponsor, in order of signing date.

The translated READMEs under [`readme/`](./readme) carry one linking line right after their
own quick-start block instead of duplicating the section, so a sponsor change is one edit in
English.

## Pricing

Pricing is by inquiry; there is no public rate card. Sponsors who sign before the repository
reaches 20,000 GitHub stars lock in their rate for the length of their agreement. Rates rise
once that mark is passed.

Agreements are integration-scoped: they name the deliverables above, anchor the term to the npm
release that ships them, and carry no marketing obligations on either side. Both sides can walk
away with a pro-rated refund of unused months if the integration cannot be delivered.

## How to ask

- X: DM [@claudeebum](https://x.com/claudeebum)
- Discord: [discord.gg/JEaPEtkHwh](https://discord.gg/JEaPEtkHwh), channel `#sponsors`
- Email: jun@lidgeai.com

Send what you are (model developer or relay), the base URL and model list of your
OpenAI-compatible endpoint, and the tier you want. The maintainer replies with terms and a
draft agreement.

## What sponsors do not get

- No influence on routing defaults, failover order, quota policy, or which provider a user's
  request reaches.
- No relaxation of the [security review](./MAINTAINERS.md) that applies to authentication,
  credentials, or workflow changes.
- No access to user data, request logs, or telemetry; opencodex does not collect any.
- No say over unrelated issues, pull requests, or the release schedule.

## Current sponsors

Listed in the README sponsor section. This page carries the rules; the README carries the
names.
