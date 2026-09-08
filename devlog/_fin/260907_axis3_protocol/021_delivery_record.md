# Axis 3 delivery record

## Delivered runtime

Ordinary PR chain, merged bottom-up with explicit owner admin authorization:

| PR | Scope | Merge commit |
| --- | --- | --- |
| [3830](https://github.com/lidge-jun/opencodex/pull/3830) | Claude envelope foundation from #3815 | 2269e076d4222ada6ea3694fb8eed04f91a201d2 |
| [3831](https://github.com/lidge-jun/opencodex/pull/3831) | Grok strict-client projection from #3816 and SSE field correction | 07f8d70a75f088b19f4c9dd849e34034a88ab5f3 |
| [3832](https://github.com/lidge-jun/opencodex/pull/3832) | Replay boundaries, terminal overflow, established-history fixtures | 4349cf3cefdb5ed04575f49023ae34ffe6462e1c |

Original contributors are retained in commits: SB Yoon and Yumi for #3815, Danh Thanh for #3816. Merge commits preserve the carried commits. The documentation-only tail of #3815 through221353662 is carried with both original contributor trailers in68d90aa37.

## Verification

- [Final candidate CI](https://github.com/lidge-jun/opencodex/actions/runs/34065721438) completed SUCCESS: all25 jobs at9b5b670db3e24ae5522c5d61e74c071c71257a26, including Linux, macOS shards/control and all six Windows shards.
- Same-head remote Linux Bun1.4.0 full suite:20897pass18skip0fail with `bun run test -- --parallel=1`; typecheck, privacy scan and documentation build passed. Focused protocol coverage:405pass1skip0fail.
- While CI ran, dev advanced to b65b9d8f2 with BigModel/Raycast changes. Conflict-free integration cc6afe2c97fb423363e99682b906bcb529478688 passed remote typecheck and633tests1skip0fail across15 relevant files, including shared passthrough/registry/layout guards.
- Actual runtime landing tree at4349cf3ce equals the integration tree ccaf0a0383cb3e8808e24576271c861625b506fb exactly. This is integration proof, not a claim that the earlier full CI ran on4349cf3ce.
- Independent Astra high source/security/integration reviews passed. The terminal-closure overflow finding was fixed before acceptance. New-test oracle mistakes found remotely were corrected without weakening exact assistant-array or pairing assertions.
- The earlier parallel remote run had21 catalog timeouts; isolated and final sequential runs passed, and final hosted CI passed. No separate root-cause fix is claimed.
- No local test suite or typecheck ran. All pushes used `--no-verify`. Native stacks and fabricated check statuses were not used. Automatic lower/intermediate CI was deferred or cancelled under the owner's combined-first direction.

## Explicit remainders

#3807 remains open: the demonstrated complete external-task envelope is already supported, and current-version raw reporter reproduction is unavailable. New ordinary, stored-ID continuation, v2-trigger and v1-compact fixtures preserve established history without relaxing missing-call-ID validation.

#3719 remains open: live intended-Anthropic acceptance and controlled cache measurements are unverified. Locally hidden text through the Claude boundary and legacy combined-envelope streaming ordering remain outside the preservation claim. Existing compatibility enforcement, hidden display, authentication, routing and cache-retention defaults remain intact.

The supplied dirty worktree and existing remote main checkout were preserved; execution used separate task worktrees. No release, deployment or account configuration change was made.
