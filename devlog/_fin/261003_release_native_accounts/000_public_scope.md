# Native-account carry publication

This record preserves three public proposals used in the integration train. It records
source provenance and review order; it does not claim that the proposals have
landed or passed integration checks.

| Public source | Proposed behavior | Observed source head |
| --- | --- | --- |
| [#6496](https://github.com/lidge-jun/opencodex/pull/6496) | Explain revoked-session quota failures while retaining the last-known plan. | `8b645854fcae802c93c516a10245f9c3b7eabb76` |
| [#6507](https://github.com/lidge-jun/opencodex/pull/6507) | Keep stored native-main credentials in Pool health on translated Claude turns. | `7ffd1a856957c320d139ff262b4adaf4dd3da07b` |
| [#6505](https://github.com/lidge-jun/opencodex/pull/6505) | Try the next combo target when the current ChatGPT plan cannot use a model. | `ce2c1a60fd6934ee84b1c52d4392a6128911d914` |

All three proposals were open against `dev` when inspected on 2026-10-03.
Their author is @vadymhimself. Carries preserve source authorship and coauthor
trailers. Source heads and reviews must be rechecked before adoption.

Review quota diagnostics first, then stored-main ownership and refresh, then
combo refusal behavior. Each coherent change receives its own regression checks,
independent security review where applicable, and applicable CI at the exact PR
head. The integration coordinator owns merging and final integrated verification.

Unpublished security analysis and implementation plans remain in ignored scratch
space under the repository's security-working-notes policy. This public record
contains only scope already disclosed by the linked proposals.

## Publication outcome — 2026-10-04

Preparation is recorded as three public carry pull requests:

| Carry | Published scope | Local focused verification |
| --- | --- | --- |
| [#6515](https://github.com/lidge-jun/opencodex/pull/6515) | Revoked-session quota diagnostics, retained plan, and causal reauth attribution. | 750 tests passed at the corrected implementation checkpoint. |
| [#6523](https://github.com/lidge-jun/opencodex/pull/6523) | Stored-main credential provenance, scoped grant refusal, preview read fences and alternate-refresh cancellation. | 934 tests passed across 20 files; 51 hard-lock read-guard cases also passed. |
| [#6527](https://github.com/lidge-jun/opencodex/pull/6527) | Plan/model combo fallback with bounded evidence through HTTP and SSE error projection. | 374 tests passed across 11 files at `af350a1924ee55ddc60fe9fa04289d1aa494f437`; [exact-head CI](https://github.com/lidge-jun/opencodex/actions/runs/37146395644) passed. |

The carry commits and descriptions retain @vadymhimself's authorship credit and
source commit references. Each pull request records independent review and its
applicable CI; current-head checks remain authoritative after further commits.
The full local suite was deferred because concurrent release worktrees shared the
host. Focused regressions, typecheck, privacy, structure and relevant documentation
checks ran locally; the coordinator owns final integrated verification.

This closes publication preparation. Integration, source-PR disposition and release
remain coordinator-owned. Real provider sessions and packaged application behavior
remain outside this lane's evidence. Detailed investigation and security review
working notes remain in ignored scratch space.
