# C-lane delivery result

All five assigned code changes are merged into `dev`. Original-author credit survives in the landed history. This record contains published outcomes only; working security notes remain in scratch.

| Source | Landed PR | Scope | Merge commit | CI |
|---|---|---|---|---|
| [#3638](https://github.com/lidge-jun/opencodex/pull/3638) | [#3682](https://github.com/lidge-jun/opencodex/pull/3682) | Windows scheduler priority | `9b3955a3345561b3310508793b40ac0813e26b78` | [run 33978490397](https://github.com/lidge-jun/opencodex/actions/runs/33978490397) |
| [#3536](https://github.com/lidge-jun/opencodex/pull/3536) | [#3687](https://github.com/lidge-jun/opencodex/pull/3687) | Account deletion persistence | `ed7ecc5780ea0bd936468aff3828e60c7d9d0d34` | [run 33978685977](https://github.com/lidge-jun/opencodex/actions/runs/33978685977) |
| [#3631](https://github.com/lidge-jun/opencodex/pull/3631) | [#3688](https://github.com/lidge-jun/opencodex/pull/3688) | OAuth provider configuration | `789f69ab1bf57d74dcdd0d658f1bc13d9d486e7b` | [run 33979181943](https://github.com/lidge-jun/opencodex/actions/runs/33979181943) |
| [#3576](https://github.com/lidge-jun/opencodex/pull/3576) | [#3691](https://github.com/lidge-jun/opencodex/pull/3691) | Antigravity OAuth 401 recovery | `7e7ab281cca35600b41f1f80222f3462a87dd4e1` | [run 33979752516](https://github.com/lidge-jun/opencodex/actions/runs/33979752516) |
| [#3658](https://github.com/lidge-jun/opencodex/pull/3658) | [#3693](https://github.com/lidge-jun/opencodex/pull/3693) | Bounded main quota diagnostics | `71edeec8807d99e8e56a8c093f74da27d163d47a` | [run 33985146886](https://github.com/lidge-jun/opencodex/actions/runs/33985146886) |

Verification:

- Each recorded code head passed the hosted Cross-platform CI with executed Linux/macOS suites and typecheck. Independent source/security reviews passed on those heads.
- The service change also passed native Linux, macOS and Windows lifecycle run [33978490408](https://github.com/lidge-jun/opencodex/actions/runs/33978490408).
- Focused remote checks passed for each layer; the top diagnostic head passed 554 tests across eleven files, including the bounded subprocess regression. Documentation built 425 pages at that head.
- No local product test suite, typecheck or build was run. Pushes used the maintainer-authorized `--no-verify` path; admin merges followed verified code gates and review evidence.
- Original PRs #3638, #3536, #3631, #3576 and #3658 were closed after dev ancestry was proven. Resolved issues #3634 and #3575 were closed at their respective landings.
- Issue [#3644](https://github.com/lidge-jun/opencodex/issues/3644) remains open: diagnostics were delivered, while its underlying Windows/WHAM failure is still a separate investigation.
