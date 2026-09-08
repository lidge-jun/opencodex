# Axis 1 delivery record

Terminal outcome: DONE for the authorized bounded bug/diagnostic scope, with the explicitly listed broader work deferred. Completed 2026-09-07.

## Delivered

- #3825 carries #3809 with serving-credential quota attribution, upstream deadline handling, probe-clock preservation and known-reset expiration. Invalid reset metadata does not erase otherwise valid usage; no new unknown-window TTL or synthetic zero was introduced.
- #3826 corrects CLI-versus-proxy version guidance in both directions and prevents false doctor match claims.
- #3827 exposes bounded recovery refusal/timeout/transport/invalid-output reasons through shared flights while preserving admission, success-only caching and caller-local cancellation.
- #3842 is supporting validation work: exact private BigInt file identities preserve existing Aside profile boundaries, including high-ID distinction and directory replacement detection. Public IO/serialization and link refusals remain unchanged.

## Landing proof

All four ordinary PRs were merged bottom-up with owner-authorized admin authority. No native stack was registered. Children were retargeted to dev before their parent branches could be automatically deleted.

| PR | Reviewed layer head | Merge commit |
| --- | --- | --- |
| [#3825](https://github.com/lidge-jun/opencodex/pull/3825) | `d3c70f9d8c8cc6fced7a93577b93e8b141473ea3` | `85fbdb59621046da3db1839a5cce4c7260f99385` |
| [#3826](https://github.com/lidge-jun/opencodex/pull/3826) | `872f0e5aa714f6a2e757510195d1c038ac70e26d` | `860baaf9032fa7ea3030c78ab555608e3325a338` |
| [#3827](https://github.com/lidge-jun/opencodex/pull/3827) | `2e8ef03428f8e619dc92b250fbbc5d5dd7ad53cb` | `5a97db9b20f03a65e714ddc88d2523bea9aeacae` |
| [#3842](https://github.com/lidge-jun/opencodex/pull/3842) | `b29bbb440aaf70b283445a9c37e194a4a4e6859a` | `5fdf9bbdd9ff7657f0b6d7101697317d708af0e7` |

The runtime integration commit is `5fdf9bbdd9ff7657f0b6d7101697317d708af0e7`. Its full tree `90a75118402d2f310393bef9ac3e4668cfcbdcfa` exactly matches the final combined validation candidate `9470fdb1bc9a02715a3760c36301d3d030a4e4fa`. A fresh fetch and ancestor check confirmed every merge on dev. The candidate included dev `bf85e675484a2391b94b2135bbebe739813a9621` plus all four layers.

## Verification

- [Cross-platform CI 34074350604](https://github.com/lidge-jun/opencodex/actions/runs/34074350604): all 26 jobs succeeded at the combined candidate, including Linux, macOS, Windows, Docker smoke, typecheck, privacy, build and operational checks.
- [Service lifecycle 34074351720](https://github.com/lidge-jun/opencodex/actions/runs/34074351720): Linux, macOS and Windows succeeded at the same candidate.
- Independent Astra high source/security audits covered the scoped implementations, merge interactions and exact-identity support.
- All current review threads on the four delivered PRs were resolved after runtime evidence was available.
- No local application test suite or local typecheck ran. Pushes used --no-verify; per-layer CI was deferred by explicit owner instruction. Cancelled and skipped checks were never represented as passing tests.
- Privacy scanning passed. Documentation static build produced 425 pages in 8.23 seconds at 2522264d5; its documentation subtree remained unchanged by the supporting identity fix. Dependencies were installed from the frozen lockfile with install scripts disabled. The build changed no tracked files.
- The assigned pre-existing working-tree changes were preserved; delivery used an isolated worktree.

## Corrections and remaining limits

Initial verification exposed incomplete test homes/default configuration and old calendar reset dates in current-measurement fixtures. Those fixtures were corrected without removing behavioral assertions. Known-expiry tests use explicit simulated time. Later review added expired-window handling, field normalization and a global test network guard.

Imported axis-five closeout contact addresses blocked privacy scanning. [#3836](https://github.com/lidge-jun/opencodex/pull/3836) removed the addresses while retaining author names and all commit attribution; no scanner rule or allowlist was weakened.

Earlier Windows Aside incidents reported an apparent shared catalog target. Their actual file IDs were not captured. The independently demonstrable Number-precision defect was corrected by #3842, and semantic/native regressions plus the previously failing route case passed in final CI. This does not retroactively prove every earlier incident's raw IDs or cause.

An earlier Windows outbound-proxy test timed out at its existing 15-second bound. Its scoped test/transport files were unchanged and the stalled phase was not measured. No timeout increase or unrelated proxy repair was made; later passing execution is not a claim that the timing root cause was fixed.

## Attribution and issue disposition

Éverton Toffanetto's Co-authored-by trailer is retained in reachable commit `f215f79b4562735029ad5672a68bc6104e534b98`. The issue reporters garysassano and Hu9956 are acknowledged in the corresponding diagnostic commits. Merge commits preserve those commits and trailers.

The original #3809 was confirmed closed with a landed-via-#3825 marker at final recheck. The initial carry source was 4a1012359; the original author subsequently updated the source PR, so this record does not claim a verbatim merge of its later head.

#3464 remains open for its broader automatic-repair/request-policy requests. #3661 remains open for multipart reconstruction and recovery retry policy. Those choices were outside this delivery. No release, deployment, new account-selection strategy or authentication-default change was performed.

The preceding numbered documents are historical plans and audits; their original _plan paths refer to the planning stage.
