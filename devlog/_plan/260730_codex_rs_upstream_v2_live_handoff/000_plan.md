# 000 — codex-rs upstream v2 / GPT Live handoff: plan

Unit status: **docs-only roadmap cycle closed**. No production code changed.
Implementation starts at the NEXT loop run, one work-phase per decade doc.

## Objective

codex-rs upstream (`openai/codex` main @ `5a1097ed2`) is **658 commits** ahead of our
fork point `1f0566d3f` (branch `codex/spawn-agent-metadata-ux`). Several of those
commits change contracts OpenCodex already implements: the `[agents]` config
surface, multi-agent v2 subagent settings, and the realtime/GPT-Live wire dialect.

This unit records, at diff-level precision, every OpenCodex change those upstream
commits require, so a later loop can execute each work-phase without re-doing the
research.

## Evidence base

Four parallel research lanes, all read-only:

- upstream config + feature-flag delta (`001`)
- upstream multi-agent v2 + realtime v3 behavior (`002`)
- OpenCodex agent/subagent config surface (`003`)
- OpenCodex realtime/live surface (`004`)

Every upstream SHA cited in this unit was verified with `git log --oneline <sha> -1`
in `/Users/jun/developer/codex/121_openai-codex`. Every OpenCodex file:line cited was
read in `/Users/jun/Developer/new/700_projects/opencodex` at branch `dev`, HEAD
`959e9ff11`.

## Headline finding

OpenCodex is much closer to upstream than a naive commit scan suggests: it already
owns `features.multi_agent_v2.max_concurrent_threads_per_session`, a marker-owned
`[agents].default_subagent_model` writer, and a canonical
`LIVE_SIDEBAND_API_ROOT = "https://api.openai.com/v1"`.

The real problems are narrower and sharper than "adopt the new keys":

1. **An off-by-one in the v1↔v2 concurrency translation.** Upstream adds 1 to
   `[agents].max_concurrent_threads_per_session` when feeding V2 (the root agent
   occupies a slot). OpenCodex treats the two keys as interchangeable. Migrating a
   user between v1 and v2 therefore shifts their real concurrency limit by one.
2. **The sideband canonical-URL policy is conditional on provider shape.** Upstream
   now always uses the Realtime API host for WebRTC sideband joins unless explicitly
   overridden. OpenCodex applies the canonical host only for ChatGPT-backend-shaped
   providers, and derives it from the provider base URL otherwise.
3. **Three upstream keys have no OpenCodex reader/writer at all**: `agents.enabled`,
   `agents.max_depth`, and `features.multi_agent_v2.subagent_developer_instructions`.

## Scope

IN: config-surface parity for the `[agents]` and `multi_agent_v2` tables; the
sideband URL policy; feature-flag hygiene; realtime v3 pass-through correctness.

OUT: rebasing `codex/spawn-agent-metadata-ux` (separate task, and a prerequisite for
nothing in this unit — every change here targets OpenCodex `dev`, not the fork);
implementing app-server-side v3 session semantics OpenCodex does not host; any
change to auth, credentials, or release automation.

## Work-phase map (dependency-ordered)

Each work-phase is one full PABCD cycle consuming exactly one decade doc.
Ordering is foundations → core → integration → hardening: later phases consume the
verified output of earlier ones.

| WP | Doc | Slice | Depends on | Closes with |
|----|-----|-------|------------|-------------|
| 1 | `010` | Concurrency semantics: fix the v1↔v2 `+1` translation and pin it with tests | — | `bun run test` on the features suite, asserting both migration directions |
| 2 | `020` | Config-surface parity: add `agents.enabled`, `agents.max_depth`, `subagent_developer_instructions` readers/writers | WP1 (same TOML edit helpers) | typecheck + new parity tests per key |
| 3 | `030` | Management API and CLI exposure of the WP2 keys | WP2 (the keys must exist first) | route tests + `ocx v2 status` output |
| 4 | `040` | Sideband URL policy: explicit override precedence, canonical default, query-param exclusion | — (independent of 1-3) | sideband URL unit tests across provider shapes |
| 5 | `050` | Feature-flag hygiene: `code_mode_host` structured shape, retire removed flags | — | typecheck + config-parse tests |
| 6 | `060` | Cross-provider subagent spawns: widen V2 model eligibility to every routed model | — (independent) | roster tests + a real cross-provider spawn |

WP4 and WP5 are independent of WP1-3 and may be reordered against them, but not
internally split.

## Accept criteria (mirror into goalplan `criteria[]`)

- Every decade doc is diff-level: exact paths, NEW/MODIFY/DELETE, before/after code.
- Every upstream claim carries a verified SHA.
- Research docs (`001`-`004`) contain no diffs; decade docs contain no survey prose.
- Each work-phase closes with an independently verifiable gate named in the table.
- Conditional paths name their activation scenario, so a later C phase can prove the
  branch fired rather than merely that the suite is green.

## Cross-provider spawn models (RESOLVED — see the decisions section below)

Upstream `92938d880` restricts V2 `spawn_agent` models to the active backend and
rejects others with `Unknown model <m> for spawn_agent. Available models: ...`.
OpenCodex is deliberately multi-provider, so preserving that restriction verbatim
would block exactly the cross-provider spawns OpenCodex exists to enable.

Resolved by the user as option B: widen the eligible set, keep the guardrail. Full
diff-level design is `060`; background is `002` §A8.

---

# Audit fold-back (A-phase, blocker 1, Critical)

An independent review caught a factual error in this plan's own framing. The original
text claimed the upstream delta was "216 commits". Independent count:

```
$ git rev-list --count 1f0566d3f..5a1097ed2
658
```

216 was a misreading of a `git pull` fast-forward summary (a file count) as a commit
count. Corrected above.

## What this does and does not invalidate

The reviewer's concern is fair: a wrong denominator undermines any claim to have covered
"every OpenCodex change". So the coverage claim is now stated precisely rather than
broadly.

What the research actually covered:

- 249 of the 658 commits match the agents/realtime/live/feature/config keyword filter
  (`git log --grep="agent\|realtime\|live\|feature\|config" -i`).
- 53 files changed under the four directories that own the surfaces this unit touches:
  `codex-rs/core/src/agent`, `codex-rs/features`, `codex-rs/config`, and
  `codex-rs/codex-api/src/endpoint/realtime_websocket`.
- Every specific claim in `001` and `002` was verified against the **current** upstream
  tree, not against a commit message. That is the stronger check: it does not matter how
  many commits produced a given struct field if the field's present shape is read
  directly.

What remains unverified, stated plainly:

- The remaining ~409 commits were not individually reviewed. They are dominated by TUI
  rendering, MCP transport, plugins, thread-store, and build/CI work, none of which
  OpenCodex mirrors — but that is an inference from the commit subjects, not a per-commit
  audit.
- **This unit therefore claims completeness only for the four surfaces it names**:
  the `[agents]` config table, the `multi_agent_v2` feature config, the realtime/live
  sideband URL policy, and OpenCodex's feature-flag delegation boundary. It does not
  claim to have swept all 658 commits for every possible OpenCodex-relevant change.

If a later cycle needs that broader sweep, it is a separate work-phase with its own
research doc, not a silent expansion of this one.

## Why the plan still stands

The three defects this unit documents were each found by reading the current code on both
sides, and each was independently confirmed by the reviewer:

- the concurrency off-by-one is real and the fix direction is correct
- `normalizeSidebandRoot` handles the path-prefix and root-path cases correctly
- the WP5 NOOP evidence (`code_mode_host`, `enable_fanout`, `item_ids` absent from
  `src` and `gui/src`) reproduces

A wrong commit count does not make a defect found by reading the code disappear. It does
mean this plan cannot be read as an exhaustive upstream sweep, and the scoping above says
so.

---

# Decisions recorded (user, 2026-07-30)

## Sideband URL policy — DECIDED: strict upstream parity

The user chose strict parity and asked whether it can ship without disrupting other
users' onboarding. Investigation says yes, and the reason is stronger than expected:
the regression is **unreachable on the current code**.

`resolveLiveRelay` gates provider selection before any sideband URL is built, and only
two shapes pass — the canonical ChatGPT forward provider, or the built-in OpenAI
provider pinned to `https://api.openai.com/v1`. A non-OpenAI base cannot reach the URL
builder at all; it is refused with an explicit "Routed providers cannot serve voice
call-create" error. So the derived host and the canonical host are already the same
string for every user who can reach the code.

The earlier "this is a user-visible change" warning in `040` is withdrawn on that
evidence. WP4 is reclassified from repair to **hardening**: its real deliverables are the
missing override knob and the removal of a redundant branch that had already drifted from
upstream. Full evidence and an onboarding checklist are in `040` under
"Decision recorded".

## Cross-provider spawn models — DECIDED: option B (widen the eligible set)

Unlike the sideband question this is not unreachable plumbing: it changes what a user
can actually ask for. Importing upstream's restriction verbatim would make `spawn_agent`
refuse exactly the cross-provider delegation OpenCodex exists to enable.

The user chose option B — any model OpenCodex actually routes is eligible, while models
pinned to the *other* multi-agent backend (`v1`) stay excluded and the unknown-model
guardrail and error shape are preserved. Written up as work-phase 6 in `060`.

Investigating the implementation site shrank the phase considerably. OpenCodex does not
re-implement upstream's validator; it generates the catalog the native binary validates
against, and it already copies the single-backend filter in exactly two lines of
`src/codex/catalog/sync.ts` (89 and 113). So this is a catalog-eligibility change, not a
tool-schema or validator rewrite as first assumed.

One risk stays open and `060` names it: if the native binary carries its own model pin
independent of the catalog we write, a newly advertised model could still be refused at
spawn time. That must be settled by running a real cross-provider spawn, not by reading
the Rust source, and the phase closes `BLOCKED` with evidence if the refusal happens.
