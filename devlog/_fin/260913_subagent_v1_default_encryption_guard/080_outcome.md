# Outcome

Landed as [#4462](https://github.com/lidge-jun/opencodex/pull/4462), squashed onto `dev`.

## What shipped

All five work phases, as planned. v1 is the written install default; an absent `multiAgentMode`
still means base; existing installs are asked once instead of being rewritten; the approval dialog
guards all three places the mode switch is rendered; and the guide is published with a diagram.

## What the plan got wrong

Two things, both caught by review rather than by writing the plan more carefully.

**The repair path.** D1 argued that `getDefaultConfig()` reaches an existing config only on the
schema-repair path, and treated that as safe. It is not: a config missing an unrelated field —
`defaultProvider` is the common one — takes that path, and the defaults were spread *underneath*
the stored document. A base operator would have been repaired into v1 with the advisory
pre-answered, which is exactly the silent flip D2 forbids. Both merges now pin the two keys to the
stored document. The roadmap audit missed this; the implementation audit found it by enumerating
the merge paths instead of reasoning about them.

**The third switch.** 030 described two mode switches. There are three — the Subagents page renders
one too, and it wrote straight through, which made the dialog decoration on that page. The lesson is
cheap to state and easy to miss: when a control is duplicated, count the copies before gating one.

## Review findings, by who found what

| Reviewer | Finding | Severity |
| --- | --- | --- |
| Implementation audit | Repair path flips an existing operator's surface | blocking |
| Implementation audit | Ordering comment claimed a transaction the code does not have | blocking |
| GUI audit (second pass) | Subagents page bypasses the dialog | blocking |
| GUI audit (second pass) | Continuing to base or v2 left the notice raised, so the poll re-asked | real |
| GUI audit (second pass) | Locale test grepped source, so a key in a comment would pass | real |
| Codex | Acknowledgement gated on a projection that goes stale | P2 |
| CodeRabbit | Staged selections not scoped to the endpoint that staged them | major |
| CodeRabbit | Escape and backdrop dismissible while a write is in flight | minor |
| CodeRabbit | Unsupported stored mode echoed raw from the API | minor |
| CodeRabbit | Warning text overstated the failure on base; Korean, French and Russian copy | minor |

## Still true after this lands

The upstream limitation is unfixed. When a ChatGPT-native parent can emit a routed child's task as
plaintext, bump `MULTI_AGENT_SURFACE_ADVISORY_VERSION`, move the default back to base, and the same
machinery tells everyone who was asked the first time.
