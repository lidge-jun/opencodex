# 040 — wp4 / PR4: documentation, close-out, and landing

Stacked on PR3. Scope IN: `docs-site/src/content/docs/reference/configuration.md`,
`devlog/_plan/260904_external_fast_wire/050_outcome.md` (written at close), the stacked-PR
landing itself. Scope OUT: further behaviour change.

## Docs

The `cursorEffortRows` entry at `configuration.md:51` is the template. The new section sits
beside it and states what a reader needs to decide whether to turn it on:

- `fastRows` is an optional boolean, default `false`.
- When on, the raw OpenAI-style `/v1/models` list and Claude Code discovery add
  `<base-id>--fast` for every model whose Fast policy is eligible, and selecting one
  routes the base model with the `priority` service tier.
- Name the surfaces exactly, and say plainly that `ocx export` and the OpenCode
  integration emit base ids only, because those identities are written into config files
  that outlive the flag. A reader who turns this on and then exports must not be surprised
  by a missing row.
- The base row stays listed; the fast row is additive.
- An exact configured model id always beats the suffix.
- `fastMode: false` still suppresses Fast, and a model that does not support Fast never
  gets a row.
- This is the same Fast the Codex app exposes through its picker toggle — the flag is what
  makes it reachable from clients that select by model id.

Note the `fastMode` relationship explicitly, because the two names are close and the
behaviours differ: `fastMode` is a global on/off applied to every request, `fastRows` is a
per-request selector. They compose — `fastMode: false` wins over a fast row.

## Landing the stack

Four PRs, each targeting its parent's head branch, per `DEV-STACK-01`:

| PR | Branch | Base at open | Retarget |
|---|---|---|---|
| PR1 | `codex/260904-fast-row-core` | `dev` | — |
| PR2 | `codex/260904-fast-row-listing` | PR1 head | `dev` after PR1 lands |
| PR3 | `codex/260904-fast-row-ingress` | PR2 head | `dev` after PR2 lands |
| PR4 | `codex/260904-fast-row-docs` | PR3 head | `dev` after PR3 lands |

`enforce-target` skips the wrong-base gate for children of an open PR, so the stack is a
supported shape rather than a workaround. Every PR fills all three template sections
(Summary, Verification, Checklist); none touches the GUI, so no screenshot is required.

Pushes use `--no-verify` per the user's instruction. That skips local hooks only — the
branch rulesets and remote CI still apply, and remote CI green on each PR's exact head SHA
is the evidence that closes criterion c7.

## Close-out

`050_outcome.md` records, per PR: merge SHA, the ancestry proof
(`git merge-base --is-ancestor <sha> FETCH_HEAD` against a freshly fetched `origin/dev`), the
CI conclusion for that exact head, and the residuals still open. The unit then moves from
`devlog/_plan/` to `devlog/_fin/`, which is the terminal marker for a unit whose work is
visible in public git history.

An empty `gh pr checks --required` is not green evidence — read the full rollup.
