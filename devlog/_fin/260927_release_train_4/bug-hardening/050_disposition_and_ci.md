# Closure — assigned-item disposition and dev CI

Depends on B1–B4 or an evidenced decision to hold a batch. This document becomes the lane ledger; it is not a release or deployment instruction. Update its tables as merges and GitHub actions actually happen. Do not mark an unrun check successful.

## Exact action map

| Item | Required action after implementation decisions |
| --- | --- |
| Carried #6081, #6083, #6082 | After the corresponding lane-owned PR merges, comment in English on each source PR with thanks, the merged PR URL and `dev` merge SHA, then close it as superseded. Verify coauthor trailer survived in the lane PR. |
| #6088 | After B4 merges and exact `dev` SHA is observed, comment with PR/commit link and the verification scope, then close. |
| Held #6076, #5964, #6030, #5831, #5539, #6085 | Post one precise English comment per PR naming the current blocker and evidence; leave open unless an exact duplicate/supersession is subsequently proved. Do not imply the proposal was merged. |
| Open #4956, #4761 | Comment in English with the partial-fix and remaining-contract evidence; leave open. Do not close from a warning or fixture-only change. |
| Lane-owned PRs | Each PR uses the repository Summary, Verification and Checklist template; includes focused command output, full-suite contention exception, security review where applicable, correct coauthor trailers, and current-head CI links. Resolve valid Codex/CodeRabbit findings before merge. |
| `dev` integration | Fetch `origin/dev` before every merge; prove ancestry and combined file-size/union/doc gates. Record merge SHAs. Since Cross-platform CI does not trigger on `dev` push, dispatch `workflow_dispatch` on exact `dev` and inspect expected jobs, event, head SHA, attempt and conclusions. Repair a lane-caused failure. |

## Evidence ledger

| Batch | Lane PR | Head and merged `dev` SHA | Local commands and result | Exact-head CI run | Source PR/issue action |
| --- | --- | --- | --- | --- | --- |
| B1 | [#6113](https://github.com/lidge-jun/opencodex/pull/6113) (#6101 closed as superseded) | commit `10eca73196`; merged in `2275680ab3` | adapter-focused 100 pass / 0 fail (88 before), red before fix; review fixes added a per-ID lease for bridge-retained IDs | #6101 and #6113 pull_request CI (all executed jobs green on `364fc3bc59`) | #6081 and #6083 closed with thanks, carried with Co-authored-by |
| B2 | [#6099](https://github.com/lidge-jun/opencodex/pull/6099) | head `8812bb5dfc`, merged `6d64ea26a7` (squash, Co-authored-by luvs01 kept) | NativeTrayTests 59 assertions (53 before); trapped (exit 133) on old formatter | [36330651498](https://github.com/lidge-jun/opencodex/actions/runs/36330651498), every executed job success | #6082 closed as carried |
| B3 | no source PR | no merge | restart-focused baseline 45 pass / 0 fail; safety audit holds #6085 | N/A | [#6085 comment](https://github.com/lidge-jun/opencodex/pull/6085#issuecomment-5857829048), left open |
| B4 | [#6113](https://github.com/lidge-jun/opencodex/pull/6113) (#6102 closed as superseded) | commit `9f50bddfe8`; merged in `2275680ab3` | Link-focused 40 pass / 1 win32 skip / 0 fail, 4 red before fix; the PowerShell parser test passed on Windows shard 6/9 of dispatch [36331108394](https://github.com/lidge-jun/opencodex/actions/runs/36331108394) | #6102 CI; #6113 CI | #6088 closed with evidence; PowerShell 5.1 legacy quoting recorded as an untested limit |
| B6 | [#6113](https://github.com/lidge-jun/opencodex/pull/6113) (#6108 closed as superseded) | commit `f1f903bf0d`; merged in `2275680ab3` | focused 422 pass / 1 skip / 0 fail with ratchet, layout and structure guards on the rebased union tree `87afa8601f`; writer guards and repeated-ensure roster deletion red before fix | #6113 CI partial (the coordinator moved Cross-platform CI to one final `dev` run) | coordinator bug fixed; Claude intercept settings migration handed off to the picker CA lane |

Integration path. #6099 landed alone. The other three slices went through one batch PR, #6113, merged with a merge commit so each slice keeps its own commit and trailers. The batch was rebased twice because `dev` touched the shared test-layout registries and `structure/` docs. Following the coordinator's final merge rule, the gate at merge time was local verification of the union tree: typecheck, structure, privacy, the ratchet, layout and structure-SSOT tests, and the focused suites, all green. Per-PR Cross-platform CI was not awaited, and one Cross-platform CI run on final `dev` is left to the coordinator after all lanes land.

`test:changed` on the batch (`1435726536`) gave 26294 pass / 21 fail. Every failure either also fails on pristine `dev` (the three `shutdown-launcher` tests find the machine's real proxy on port 10100 through the existing configured-port probe) or passes in isolation, except one source-oracle harness gap, which was fixed.

Held and commented, left open: #6076 (pairing is Hub-only while join requires standalone, so the gate makes Child join unreachable; old dashboards would get a bare 403), #5964, #6085, #6030, #5831, #5539. Status comments: #4956 and #4761, left open.

Remaining risk: two homes that start before either publishes a hint, or a sibling that starts while the primary is briefly restarting, can still both sync. A data-listener-only hint counts as unknown. The Claude intercept settings migration does not consult the sibling mark yet.

Overlapping files for other lanes: `src/cli/index.ts` (start/ensure ownership, 1,996 lines against the 2,000 threshold), `src/cli/ensure-desired-integrations.ts`, `src/cli/claude-agent-startup-sync.ts`, `src/adapters/coding-agent/protocol.ts`, `src/link/ssh-*.ts`, `structure/runtime.md`, `structure/codex-home.md`, `structure/clients/integrations.md`, `structure/remote-link.md`, `structure/providers-and-adapters.md`, the CLI lifecycle docs in five locales, and both test-layout registries.

