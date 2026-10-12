# Planned split: structure/providers/openai-tiers.md

## Why there is a grace entry

`openai-tiers.md` sat at 597 lines on `dev` against a 600-line budget, so it had
room for three lines. Any real contract addition fails the gate, which is what
happened when the account-selection work recorded the uploaded-file retention
invariant and the flagship roster polarity. The doc is now 638 lines and carries
a `grace.oversizeDocs` entry, which `structure/AGENTS.md` reserves for a split
that is already planned. This is that plan.

## The topic boundary

The file has held two subjects for a while. One is account identity and wire
shape: Pool and Direct modes, API-key separation, the ChatGPT wire identity, and
the entitlement rosters. The other is selection and quota behaviour: eligibility
guards, priority tiers, cache affinity, reset-first ordering, observed capacity,
and now uploaded-file retention. The split runs on that line, leaving
`providers/openai-tiers.md` with identity and wire shape and moving selection and
quota behaviour into a sibling doc with its own manifest entry.

## Why it is not done in this release

Splitting an invariant doc renumbers nothing but does move every anchor other
documents link to, and `structure:check` resolves those references. Doing that
while five behaviour changes are landing would mix a documentation refactor into
the release candidate for no user benefit. The grace entry states the debt
honestly and the gate drops it again once the doc is back under budget.
