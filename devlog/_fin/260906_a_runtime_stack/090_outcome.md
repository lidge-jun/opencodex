# A runtime and routing outcome

All five assigned originals are closed and their credited changes are on dev. The final stack entered dev through [#3716](https://github.com/lidge-jun/opencodex/pull/3716), merge [`a2f69c8aa`](https://github.com/lidge-jun/opencodex/commit/a2f69c8aa60976345740ae6f3d2301f89297328e). GitHub automatically recognized the folded review PRs as merged; their actual dev integration is recorded below.

| Original | Reviewed carry | Dev integration | Full CI before dev integration |
| --- | --- | --- | --- |
| [#3672](https://github.com/lidge-jun/opencodex/pull/3672) | [#3683](https://github.com/lidge-jun/opencodex/pull/3683) | [#3683](https://github.com/lidge-jun/opencodex/pull/3683) · [`c6d8678f7`](https://github.com/lidge-jun/opencodex/commit/c6d8678f73ce6e1ae9df004ab032af09837b5b45) | [33981578769](https://github.com/lidge-jun/opencodex/actions/runs/33981578769) |
| [#3679](https://github.com/lidge-jun/opencodex/pull/3679) | [#3686](https://github.com/lidge-jun/opencodex/pull/3686) | [#3686](https://github.com/lidge-jun/opencodex/pull/3686) · [`a6d1065cf`](https://github.com/lidge-jun/opencodex/commit/a6d1065cfbadc7d8f9c02e17549908b42d2bfd7a) | [33981581047](https://github.com/lidge-jun/opencodex/actions/runs/33981581047) |
| [#3568](https://github.com/lidge-jun/opencodex/pull/3568) | [#3690](https://github.com/lidge-jun/opencodex/pull/3690) | [#3690](https://github.com/lidge-jun/opencodex/pull/3690) · [`6e15dad6a`](https://github.com/lidge-jun/opencodex/commit/6e15dad6a42682d5dbf3e61c51493385091e37a6) | [33981582675](https://github.com/lidge-jun/opencodex/actions/runs/33981582675) |
| [#3581](https://github.com/lidge-jun/opencodex/pull/3581) | [#3692](https://github.com/lidge-jun/opencodex/pull/3692) | [#3716](https://github.com/lidge-jun/opencodex/pull/3716) · [`a2f69c8aa`](https://github.com/lidge-jun/opencodex/commit/a2f69c8aa60976345740ae6f3d2301f89297328e) | [33991642514](https://github.com/lidge-jun/opencodex/actions/runs/33991642514) |
| [#3671](https://github.com/lidge-jun/opencodex/pull/3671) | [#3694](https://github.com/lidge-jun/opencodex/pull/3694) | [#3716](https://github.com/lidge-jun/opencodex/pull/3716) · [`a2f69c8aa`](https://github.com/lidge-jun/opencodex/commit/a2f69c8aa60976345740ae6f3d2301f89297328e) | [33991642514](https://github.com/lidge-jun/opencodex/actions/runs/33991642514) |

Original author identities and account-linked Co-authored-by trailers were retained: Hako, Clive Rosfield, voiys and SB Yoon. The carried contributor commits remain ancestors of the final integration. Each source head was checked again before closure; the original WebSocket author rebase had an identical verified patch.

## Additional verified repairs

- #3696 stabilized Windows shutdown-spill fixtures with controlled clocks and complete ACL mocks; hosted Windows causal and negative controls passed before integration.
- #3708 kept Unix probe cleanup bounded and fail-closed while allowing the existing observation interval to confirm disappearance after transient EPERM. Replay fixtures now keep one caller credential snapshot across a forced second boundary.
- #3716 budgeted transition-probe startup from the two bounded Windows identity lookups, reported early exits, and joined children before cleanup. Quota fixtures now join their ordered observation/forget queue instead of guessing completion after five milliseconds.

The final candidate passed all 24 actual cross-platform producers and the aggregate CI check in run33991642514. Remote regression controls covered delayed process startup, direct early exit, delayed quota delivery and deliberately suppressed delivery. Reverting the quota fixture reproduced the exact three historical failures; the repaired fixture passed all sixteen cases under the controlled delay. No local product tests, typechecks or builds ran.

## Scope and verification record

[#3661](https://github.com/lidge-jun/opencodex/issues/3661) remains open: this work covers the proven native MESSAGE recovery slice, not its remaining multipart/backend/caller cases. The five source PRs expose no additional closing-issue links.

Historical failed CI jobs were preserved. One earlier Cursor echo/close timeout has no established cause; the same source subsequently passed all final cross-platform checks. It was not claimed to be fixed by the fixture changes.

Integrated dev `a2f69c8aa60976345740ae6f3d2301f89297328e` passed [run33993960826](https://github.com/lidge-jun/opencodex/actions/runs/33993960826): all17 applicable producers and the aggregate succeeded. Windows suite and unsharded macOS control are dispatch-only and were correctly skipped on this push; both were included in the successful24-producer final candidate run above.
