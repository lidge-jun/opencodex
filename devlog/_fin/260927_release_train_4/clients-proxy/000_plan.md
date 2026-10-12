# Release train 4: clients and proxy lane

At `origin/dev` `24b2f39b77` on 2026-09-27, this lane has a mix of useful client
integrations, routing changes, and proposals whose current diffs are not safe to
land. Carry the bounded changes through ordinary PRs to `dev`, correct the observed
regressions, and leave concrete reasons on proposals that need a new contract.

## Loop specification

- Archetype: satisfy the release-train acceptance contract, one dependency-ordered
  work phase per PABCD cycle.
- Trigger: the release train 4 `clients-proxy` lane assignment.
- Goal: land verified client/proxy changes that help the next release and record a
  disposition for every assigned PR and issue.
- Non-goals: `main`, `preview`, releases, version changes, other lanes, writes to
  contributor forks, automatic third-party installer execution, and eager client
  activation on the three core request paths.
- Verifier: the focused commands in the decade docs, `bun run test:changed`,
  `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`,
  `bun run skill:surface:check` when CLI capabilities change, exact-head PR CI,
  and a successful post-merge `dev` CI run. Conditional branches have explicit
  activation cases in their phase documents.
- Stop condition: every row below has a supported merge or hold decision, each
  landed PR passed its actual required jobs, source PRs/issues received the
  appropriate links and disposition, and the final `dev` run succeeded.
- Memory artifact: this numbered unit, its phase evidence, and the lane's
  session-bound goalplan/ledger.
- Terminal outcomes: DONE means that stop condition holds; NOOP means no
  candidate survived review; NEEDS_HUMAN means an external contract or approval
  blocks a specific candidate; BLOCKED means repeated external failure prevents
  all meaningful progress; UNSAFE means validation found an unresolved release
  blocker. There is no user-specified token or wall-clock bound.
- Escalation: a new scope, an unresolvable security boundary, or a required
  external account decision goes to the coordinator. PR push/merge and issue/PR
  disposition within this lane are already authorized.

All source edits, Git operations, and tests use this lane's dedicated
worktree checkout. The native
session directory is used only for ignored FSM and goalplan state. Local full
suite may be omitted due to seven concurrent lane worktrees; focused regressions
remain mandatory, and each PR's Verification section will state the exact
commands, results, and coverage left to CI.

## Source ownership and selection

`structure/clients/integrations.md:27-55` assigns pure client builders to
`src/clients/config-export.ts`, detection paths to
`src/integrations/registry.ts`, and snapshot/classification/writes to the shared
integration modules. New clients stay explicit and use those seams. The three
core request files (`src/router.ts`, `src/server/lifecycle.ts`,
`src/server/responses/core.ts`) must retain the Lab import boundary enforced by
`tests/lab/core-lab-boundary.test.ts`. `src/config/proxy-env.ts` owns process
proxy activation (`structure/config-proxy.md:1-20`).

| Item | Current head/state | Decision and evidence | Work phase |
| --- | --- | --- | --- |
| #6051 | `987b8097`, open | Carry the disposable-home management-API recipe with a discoverable contributor link; `.agents/skills/` has no existing entry point. | [010](010_recipe.md) |
| #5893 / #5853 | `3743320a`, draft | Carry only when every macOS exception maps faithfully onto the bypass variables the active transports read, or discovery refuses before any environment write; an inherited SOCKS proxy keeps its existing path. | [020](020_macos_proxy.md) |
| #5950 / #5660 | `ef03f5ab`, open | HOLD Qoder: opt-in config writes, restore, and path handling still need current-base revalidation (`src/clients/config-export/qoder.ts`, PR test). | [030](030_qoder.md) |
| #5272 | `7dd796d7`, open | Carry Kilo after checking all merged config candidates; first-file-only selection can be overridden by a later legacy file (`src/clients/config-export/kilo.ts:57-63` in PR). | [040](040_kilo.md) |
| #5193 | `91090f80`, open/conflicting | Reimplement a focused Droid slice on current `dev` only if its client contract and export provenance can be proven. The PR's broad rewrite changes shared loopback export behavior. | [050](050_droid.md) |
| #5871 | `ba2d2600`, open/conflicting | Carry after conflict repair and an outbound decision-payload regression (`src/combos/jev.ts:588-595` in PR). | [060](060_jev.md) |
| #5983 / #5982 | `cd45810f`, open | Carry with explicit non-memory metadata taking precedence over the subagent header fallback (`src/server/responses/memory-models.ts:65` in PR). | [070](070_memory.md) |
| #5905 / #5679 | `19948a38`, draft | Hold: opening regular Cursor integration status can automatically fetch an external installer manifest. Decide explicit opt-in and cover timeout/status before carry. | [080](080_held_items.md) |
| #3833 | `d47e376b`, draft | Hold: Command Code rejects the exported literal `apiKey` placeholder; the PR test only checks presence. Needs supported client credential form and live client proof. | [080](080_held_items.md) |
| #4854 | open | Hold OpenScience until its actual config schema and ownership paths are established. Manual OpenAI-compatible endpoint is available. | [080](080_held_items.md) |
| #3494 | open | Hold VS Code extension integration until one named extension's supported settings and reload lifecycle are verified. | [080](080_held_items.md) |
| #1416 | open | Hold Orca launch manifest until the stopped-proxy, secret-free consumer contract is pinned; live-catalog config export is the wrong bootstrap path. | [080](080_held_items.md) |
| #2811 | open | Design only: #5016 was closed because `plan` required `managed: true` that the production inspector never reports. A reachable provenance proof precedes apply. | [080](080_held_items.md) |

## Dependency order and merge method

`010` establishes the verification recipe, `020` owns outbound proxy activation,
`030` proves the existing client path on current `dev`, and `040`/`050` reuse that
verified roster with one client at a time. `060` precedes `070` because both touch
`src/types/config.ts`; that is a merge-conflict dependency, not a runtime one.
`080` records held items after each applicable outcome. [090](090_final_ci.md)
checks the latest integrated tree. Each carried source PR becomes a new ordinary
`dev` PR from this lane, with a `Co-authored-by` trailer in the PR description
or branch commit. Git authorship alone does not satisfy the carry policy. A
large or conflicted source diff is reduced before
landing; the source PR is thanked, linked, and closed only once its replacement
is merged. No GitHub native stack or tip-only CI exception is selected.

For every batch, fetch `origin/dev` again, inspect the source PR's current head
and diff, check the file-size ratchet and merged union/locale/count consumers,
run focused tests and typecheck, perform explicit security review for any
credential, proxy, installer, or authentication boundary, then inspect
required CI at the exact new PR
head before merging. GUI changes need a screenshot in the PR description from
the separate `pr-assets` branch, never committed to the PR branch. Merge only
when the new PR head contains the latest `origin/dev`; dispatch `ci.yml` on
`dev` manually as specified in [090](090_final_ci.md) and inspect its exact
head before the next batch.

## Consultation and uncertainty

The architect proposal: D1 existing
integration ownership and D2 proxy ownership accepted; D3 Cursor discovery
amended to hold pending opt-in; D4 managed clients accepted with #3833 held;
D5 new client proposals held pending primary client contracts; D6 JEV then
memory accepted; D7 Codex updater remains design-only. Four independent source
PR reviewers examined the candidates. The architect's first reflection
found three gaps: attribution trailer, explicit security review, and the
recipe's OS-home isolation condition. All three were folded into this revision
before independent audit. Their findings are proposals; each carry is
rechecked on the actual integrated diff and current `dev`.

Baseline verifier preflight on `24b2f39b77`: `bun run typecheck`,
`bun run structure:check`, `bun run privacy:scan`,
`bun run skill:surface:check`, and `bun test
tests/lab/core-lab-boundary.test.ts` each exited 0; the Lab guard ran 25
tests. These check the baseline and this planning tree only. New PR behavior
still requires the phase-specific commands after the relevant diff is present.
`bun run test:changed` on this docs-only staged diff selected zero tests and
exited 1; it is not evidence of test passage. Docs checks and semantic audit
cover the roadmap, and implementation batches rerun changed tests.

The same architect rechecked the D2 safety amendment and returned ALIGNED.
The independent A reviewer first
reported six blockers, then one remaining test-layout blocker; every finding
was folded into the relevant decade document and its final verdict was PASS.
This closes the roadmap design review, not any proposed code change.
