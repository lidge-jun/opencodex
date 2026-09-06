# 070 — D delivery result

Verified 2026-09-06 against integrated `dev@014061a7ea908118225314538b607afdac2015b1`.
All five assigned units landed through six PRs. The four source PRs and issue #3646 are closed;
the separate Anthropic thinking/replay/cache request remains open as
[#3719](https://github.com/lidge-jun/opencodex/issues/3719).
This records the verified public implementation outcome.

## Delivered changes

| Unit | Landing | Merge commit on dev | Outcome |
| --- | --- | --- | --- |
| #3669 | [#3684](https://github.com/lidge-jun/opencodex/pull/3684) | `22da7a4bc80040f66b819239c5028e578f9a1ede` | Refuse lossy TOML temporal-value rewrites before client configuration mutation. |
| #3673 | [#3702](https://github.com/lidge-jun/opencodex/pull/3702) | `eeca697b6fecddb507fdab6808ccbe7eb9de2f74` | Retain late tool-call index aliases while preserving budget ownership and cleanup. |
| #3628 | [#3707](https://github.com/lidge-jun/opencodex/pull/3707) | `6dd23d6314c41f1113639e042353aae9e6614e62` | Preserve Cursor executable tool schemas and reserved-name handling. |
| Cursor guidance follow-up | [#3715](https://github.com/lidge-jun/opencodex/pull/3715) | `67fdf24eb6e661f4d9e84aaa86a4eb39c6f3ba58` | Retain parser-owned freeform input descriptions, including apply_patch guidance. |
| #3625 | [#3712](https://github.com/lidge-jun/opencodex/pull/3712) | `cf6f30727e71c59a4c50f0be87d6fe7614564fc3` | Composable loaded-row Logs filters, reset/focus behavior, proxy-relative time, responsive controls and translated documentation. |
| #3646 | [#3720](https://github.com/lidge-jun/opencodex/pull/3720) | `014061a7ea908118225314538b607afdac2015b1` | Hub-issued Desktop IDs/origin, restart routing, owned restoration, key migration/recovery and explicit legacy standard fallback. Unresolved date-shaped IDs return mapping-unavailable 503; unknown legacy hashes return 400, without fallback. |

## Verification

| Evidence | Verified result / limit |
| --- | --- |
| [Integrated CI 34001966922](https://github.com/lidge-jun/opencodex/actions/runs/34001966922) | Exact integrated head `014061a7ea908118225314538b607afdac2015b1`: all four Linux shards, both macOS shards, common gates and aggregate succeeded. |
| Dispatch-only jobs | Six Windows shards and the macOS control job were **skipped**, not passed. This run does not establish full-suite Windows coverage. |
| Remote candidate `500aa73a760993d95f3e96f9ff9cfd240de2b7b4` | Bun 1.4.0 / Node 22.22.0: full suite **20,098 pass / 15 skip / 0 fail**; TypeScript checking and **425-page** docs build passed. |
| Same-candidate focused validation | **562 tests across 26 files**, exit 0; privacy scan passed; final-patch Gitleaks scan found no leaks. |
| Logs at `2221aed73cf8ef5b24452f22eda369c6539b2273` (#3712) | Browser evidence covers composition/reset, exact models, empty/offline states, keyboard navigation and widths 320–1440. Remote GUI suite: **1,499 pass / 0 fail**, with lint/i18n/build and docs validation. |
| Final Logs surface comparison | The recorded comparison with candidate `500aa73a7` preserves the browser-verified Logs surface and relevant inputs. Existing screenshots remain applicable; no new final-head browser run is claimed. |

All application test/typecheck execution was remote or hosted. No local application tests or
typechecks were run. The final verifier checked every landing's ancestry in both dev and the
integrated CI head, original/follow-up disposition, carry-review resolution and retained authorship.
Evidence receipts: `.tmp/d-delivery/final-verification.json`,
`.tmp/d-delivery/final-014061a7e-verifier.log`, `remotealias-remote-proof.json`,
`remotealias-focused-proof.json` and `logs-final-surface-identity.json` in the same evidence directory.

Synthetic screenshots published with #3712:
[English desktop](https://raw.githubusercontent.com/lidge-jun/opencodex/2221aed73cf8ef5b24452f22eda369c6539b2273/docs-site/public/screenshots/logs-filters-desktop-en.png),
[proxy-clock window](https://raw.githubusercontent.com/lidge-jun/opencodex/2221aed73cf8ef5b24452f22eda369c6539b2273/docs-site/public/screenshots/logs-filters-proxy-clock.png),
[Korean mobile](https://raw.githubusercontent.com/lidge-jun/opencodex/2221aed73cf8ef5b24452f22eda369c6539b2273/docs-site/public/screenshots/logs-filters-mobile-ko.png).

## Attribution and remaining work

The verifier confirms eight contributor-authored commits retained in dev:

| Author | Retained commits |
| --- | --- |
| Hako | `08c7d3784d0cfa96c61467b8c7a581ea661378e3`, `fef024a69cfbe735d3ce0a6d33e65e911461bd2d` |
| SB Yoon | `4f0c278420998778e1341f7c7ed88e818c7ae048`, `3a7e4996435e68fd8caf8374dc75b3c759133582`, `f13cf27a22d975db2927e71960cec6e5fea02288`, `0073dd331b075578d1616d39a915bf87f00befaa`, `846197c91efeb3e411c3650e884260fdf6e45a7b`, `e7c3495b73bf73ab199bf283d0d8a079eed929e1` |

The earlier PR CI run for candidate `500aa73a7` timed out in macOS shard 1's
`shellStreamExec completion acknowledgement` test. Its native root cause remains unproven;
the successful integrated run is new evidence, not proof that the timeout cause was fixed.
macOS CI runner-policy alignment remains a separate maintenance task; this record does not
claim a native-shell root-cause repair.

Closing #3646 records delivery of its remote-alias and connection-lifecycle slice only.
Thinking/redacted-thinking replay and prompt-cache behavior remain separate in #3719;
no cache-fidelity, cache-hit or quota-saving fix is claimed here.
