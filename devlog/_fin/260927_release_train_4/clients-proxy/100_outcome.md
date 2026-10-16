# Phase 10: lane outcome

The clients/proxy lane lands through one integration PR, [#6124](https://github.com/lidge-jun/opencodex/pull/6124). It stacks the six reviewed lane PRs linearly, each with its commits and `Co-authored-by` trailers intact, plus two union commits. Batching replaced six sequential rebase-and-CI cycles on a congested Actions queue. Each lane PR passed its own exact-head `Cross-platform CI` run before batching:

| Carry | Lane PR, reviewed head | PR CI run | Source PR | Review outcome |
| --- | --- | --- | --- | --- |
| Management API test recipe, roadmap | #6095 `fc6c06050e` | [36333525807](https://github.com/lidge-jun/opencodex/actions/runs/36333525807) | #6051 | PASS after folding pre-disclosure wording and agent ids |
| JEV per-target notes | #6107 `186ed34fee` | [36333529243](https://github.com/lidge-jun/opencodex/actions/runs/36333529243) | #5871 | NEAR-PASS; control-character rule and error text folded |
| Memory-phase model routing | #6109 `fd4087e9c6` | [36336008534](https://github.com/lidge-jun/opencodex/actions/runs/36336008534) | #5983 (#5982) | NEAR-PASS; malformed/null metadata folded; debug-log finding withdrawn |
| macOS system proxy discovery | #6111 `001b83317b` | [36333558812](https://github.com/lidge-jun/opencodex/actions/runs/36333558812) | #5893 (#5853) | PASS after four rounds (defaults, noProxy, localhost) |
| Kilo Code integration | #6114 `e54be87916` | [36336759783](https://github.com/lidge-jun/opencodex/actions/runs/36336759783) | #5272 | PASS; conflict naming and disable-under-conflict folded |
| Factory Droid integration | #6115 `adbd3927b7` | [36338469971](https://github.com/lidge-jun/opencodex/actions/runs/36338469971) | #5193 | PASS after four rounds (legacy collisions, selectors, IPv6) |

## Decisions that changed the roadmap

- **Qoder (#5950, #5660): HOLD.** Qoder's own CLI documentation says not to configure BYOK manually in `settings.json` and documents no `providers`/`modelConfigs` schema. A writer could therefore target a file the client does not honour. Comments on #5950 and #5660 ask for a supported import path or official schema.
- **macOS default exceptions (020 amendment).** The strict "refuse any unrepresentable exception" rule would never activate on a default macOS configuration (`*.local`, `169.254/16`). A Bun 1.4.0 probe showed `.local` matching `local` and its subdomains on label boundaries, while `*.local` and CIDR entries are ignored. So `*.<domain>` maps to `.<domain>`, and only the exact link-local ranges are dropped, with a notice. Any other CIDR, glob, or simple-host rule still refuses before an environment write.
- **Kilo and Droid landed together** because Qoder was held. That made the client count seventeen, which needed one reconciliation commit.
- **Test layout seeds moved.** The union of new test registrations brought `scripts/test-layout/layout.json` to exactly 2,000 lines, which is `NEW_OVERSIZED`. `keepAtRoot`, `domains`, and `migrated` moved into `seeds.json` beside it, and `explicit` stayed in `layout.json`. No cap or exemption changed.

## Held items and triage comments

The following stay open. Each has an English comment naming the missing proof: #5950 and #5660 (Qoder contract), #5905 and #5679 (remote installer lookup must follow an explicit user action), #3833 (literal `apiKey` is refused by Command Code; needs a documented key reference or `false`), #4854 (OpenScience schema and ownership), #3494 (a named VS Code extension's supported settings and reload lifecycle), #1416 (a versioned, secret-free Orca launch manifest), and #2811 (design only; needs a reachable provenance predicate before any apply).

## Verification boundaries

Local full root suites were not run. Seven lane worktrees share one Bun test lock and one machine, so hosted CI shards are the broad gate. Each lane PR's and the batch's Verification sections list the focused and GUI runs. Not exercised: a real macOS Settings session (`scutil` is mocked), live Kilo or Droid clients (schemas are checked against vendor documentation), and native Windows (Windows-shaped path tests only). The merge SHA and the post-merge `dev` CI run are recorded in the lane's final report and on #6124.

