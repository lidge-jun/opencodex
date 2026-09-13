# Sub-agent surface: v1 as the install default, with an approval guard on base and v2

## Why this unit exists

The v2 collaboration surface cannot deliver a task from a ChatGPT-native parent to a
routed child. Codex mints that child task as backend `encrypted_content`, and only the
ChatGPT backend holds the key, so an external provider receives ciphertext it cannot
read. OpenCodex already fails closed on it (`unreadable_encrypted_agent_task`) and
documents the limitation as issue #92, but the product still ships `base` as the install
default, and `base` pins Sol and Terra to v2. A new user who delegates from Sol to Grok
therefore meets the failure on their first attempt, with no warning that the mode they
never chose is the reason.

This unit makes v1 the default, and makes base and v2 a choice the operator confirms
after reading what it costs.

## Locked decisions

**D1 — an absent `multiAgentMode` key still means base.** Roughly fifteen call sites read
`config.multiAgentMode ?? "default"`, and the management API deletes the key when the
operator selects base. Re-pointing that fallback to `"v1"` would make the key's absence
ambiguous: it could no longer distinguish "never configured" from "explicitly base". So
what changes is the written default — `getDefaultConfig()` now emits an explicit
`multiAgentMode: "v1"`, exactly the shape `subagentModels` already uses. The resolver is
untouched, and the merge that could push a default into an existing document runs only
on the schema-repair path.

**D2 — an existing operator is asked, not flipped.** Rewriting a stored
`multiAgentMode: "v2"` during an update would change a setting its owner deliberately
made, on a machine they are not looking at. Instead the runtime computes an advisory,
the GUI raises it once, and only the operator's answer writes. That is also what makes
the two buttons meaningful: 계속하기 keeps the current mode, v1으로 바꾸기 applies v1.

**D3 — the advisory is a version counter, not a boolean.** `multiAgentSurfaceAdvisoryVersion`
mirrors `subagentModelsVersion`. When the encryption limitation is fixed upstream, or when
a later release needs to say something different about the same setting, bumping the
constant re-raises the notice for everyone without adding another key.

**D4 — one dialog component, two triggers.** The approval dialog shown when the operator
selects base or v2 and the post-update advisory differ only in their heading and body
text. They offer the same two actions and link to the same guide, so they are one
component with a `reason` discriminator rather than two that drift apart.

**D5 — the guide is a real published page, not an anchor.** The dialog links to
`https://opencodex.me/guides/subagent-v1-default/`, a new docs-site page whose job is to
make the failure legible: an inline SVG showing the same delegation succeeding under v1
and dying at the provider boundary under v2.

## Work phases

| Phase | Outcome |
| --- | --- |
| wp1 | This roadmap, with the decisions above locked before any code moves. |
| wp2 | Runtime: `getDefaultConfig()` emits v1, the advisory state and its version constant exist, and `GET/PUT /api/v2` carry them. |
| wp3 | GUI: the approval dialog, both triggers wired, and translations for all nine locales. |
| wp4 | The docs-site guide and its SVG, plus the link from the dialog and the existing surface guide. |
| wp5 | Focused tests, typecheck, PR to `dev` with a UI screenshot, exact-head CI, merge. |

## Out of scope

Fixing the encryption limitation itself. `agentTaskRecovery` and `plaintextV2AgentMessages`
remain experimental and default-off; this unit changes which surface an operator lands
on by default, not what v2 can carry.
