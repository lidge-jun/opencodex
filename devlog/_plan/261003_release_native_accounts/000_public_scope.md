# Native-account release stabilization

This unit tracks three public proposals for the next integration train. It records
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
