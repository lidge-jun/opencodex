# L6 — small contract and quality fixes

Base: `origin/dev` at `f1dfda8e48` (#4876 merged). Package 2.58.0.

This lane collects six narrow contract defects that share no code path. Each one
ships as its own pull request against `dev`. Nothing here is a refactor, a
generalization, or a CI change — the CI stabilization round closed before this
lane opened.

## Units

| Unit | Source | Surface | Doc |
| --- | --- | --- | --- |
| U1 | issue #4855 | `src/bridge/sse.ts`, `src/bridge/response-json.ts` | [010](./010_4855_terminal_stop_classification.md) |
| U2 | issue #4822 | `src/providers/model-discovery.ts`, `zai` registry row | [020](./020_4822_zai_model_discovery.md) |
| U3 | PR #4788 | Alibaba Token Plan catalogs | [030](./030_carried_catalog_and_gui_prs.md) |
| U4 | PR #4802 | `src/server/models-capabilities.ts` | [030](./030_carried_catalog_and_gui_prs.md) |
| U5 | PR #4863 | `gui/src/pages/Models.tsx` | [030](./030_carried_catalog_and_gui_prs.md) |
| U6 | issue #4857 | `src/claude/outbound.ts` | [040](./040_4857_first_frame_usage_contract.md) |

## Ordering

U1 goes first and waits on nothing. It is the only unit a user sees on every
Anthropic-routed turn, the fix is two predicates, and both call sites already
import the classifier it needs.

U6 goes last. It touches the same subject area as U1 — what a terminal frame is
allowed to claim — but a different file and a different contract, so treating
them as one unit would only make the visible defect wait for the harder one.

U2 through U5 are mutually independent and can land in any order. The only
coupling worth recording is textual: U2 edits the `zai` row and U3 edits the
two `alibaba-token-plan` rows, both in
`src/providers/registry/entries-extended.ts` and
`src/providers/registry/model-seeds.ts`. The rows are hundreds of lines apart
and neither reads the other's constants, so this is a merge-order note for the
host, not a dependency.

## Constraints this lane operates under

No local verification of any kind. No `bun test`, `bun run test:changed`,
`bun run typecheck`, `bun install`, `bun run build:gui`, or `ocx`
invocation. Every claim in these documents comes from reading the source at the
stated commit; every claim about whether a change is correct comes from hosted
CI at an exact head.

Pushes use `--no-verify` because the pre-push hook runs the local suite.

This lane never merges, never pushes to `dev`, and never rebases without being
told to. A unit is done when its PR is open and hosted CI has reported at its
exact head.

## Repository gates that bind these units

Two gates are load-bearing here and were checked against the tree rather than
assumed.

`scripts/file-size-ratchet.ts` caps every tracked file at its recorded line
count once the file is at or over 2000 lines. `gui/src/pages/Models.tsx` is in
`tests/fixtures/file-size-baseline.json` at 2792 and currently measures 2792,
so U5 cannot add a net line to it. The carried diff is +10/-4. This is resolved
in [030](./030_carried_catalog_and_gui_prs.md), not deferred.

`enforce-target` requires a screenshot in the description of any PR whose title
or body mentions `gui`. U5 is a GUI change and this lane cannot build the GUI,
so it cannot produce one. That is reported to the host rather than worked
around.

## Attribution

U3, U4 and U5 carry work authored by @oliver-mee, @Yum-wu and @codingbooo
respectively. Each carried branch gets a `Co-authored-by` trailer in a branch
commit so it survives the squash, per the "Landing another author's work" rule
in `AGENTS.md`. Prose credit is not a substitute and is not used here.

The carry runs on `codex/` branches rather than by pushing into the
contributors' forks. The original pull requests stay open and untouched; the
host decides which of the two lands.
