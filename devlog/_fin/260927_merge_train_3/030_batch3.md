# B3 — quota activation, update launcher, link join, settings reads, account selection, combo exhaustion

Base: `dev` `06d7914e6a` (after B2 #6061). Branch `codex/train3-b3`.

Previous D (B1+B2): both batches landed with exact-head CI (35 success, 5 path-skipped each). Direction kept: serialized
carries with review fixes as separate commits. Lesson: build only inside B, after A.

| Item | Author | Plan | Fixes to fold |
|---|---|---|---|
| #6049 | luvs01 | Carry. Bounded, non-blocking read of the global Codex config on the settings poll path. | Layout registries: union with #6048's compaction. |
| #6037 | luvs01 | Carry. `systemd-run` resolves only from trusted root-owned paths, probed off the event loop. | `src/update/job.ts` import conflict: keep both imports (file lands at 1999 of 2000 lines). |
| #6042 | luvs01 | Carry. The Remote Link join key leaves only after the tunnel's listener ownership is proven twice. | None required; the connect-phase race stays documented in `structure/remote-link.md` as the PR states. |
| #6020 | terrytan95 | Carry; resolves #6018. Deadline-first quota activation with bounded backoff. | Retry records carry the credential generation, so an old credential's failure cannot hold back a replacement; a local `native main busy` refusal retries in one minute without growing the backoff; drop the duplicate delete. |
| #6056 | luvs01 | Close as superseded by #6020. On dev the retained earliest deadline already starts an idle window once, and #6020 stops the polling. | — |
| #6050 | luvs01 | Carry. `ocx account clear`; an account id `auto` wins over the reserved word; clearing works while main is paused. | Rewrite the dev test that pinned the old 409; revert its unrelated `shadow` default and `strategy` doc hunks; union the layout registries. |
| #5494 | (issue, found through Aside) | Implement. A 429 whose body says the token-plan quota "has been exhausted" is account exhaustion, so the combo target takes the long hold instead of being offered again every 60 s. | Regression test next to the combo exhaustion tests. |

Held: #6027 (owner's three blockers are still open on a draft head), #6030 and #6003 (drafts), GUI PRs.

Security-boundary items: #6037 (updater command execution) and #6042 (link join credential) have dedicated Kimi
security reviews with no blocker recorded in this unit.

## Audit (Kimi, NEAR-PASS) and folded decisions

- #6020 busy path: a named `NativeMainBusyError`; the retry record keeps its prior `delay` and sets `after = now + 60 s`.
- #6020 `main account unavailable`: stays in the growing backoff. It is keyed by generation, so a token that
  arrives later starts clean.
- #6020 both retry maps (`retryAfterByAccount`, `quotaRefreshAfterByAccount`) carry the credential generation; a
  record from another generation is dropped when read. The generation is captured before `warm()`/`refresh()` and a
  failure is not recorded when it changed during the await. The second same-tick `hasScheduledWindows` delete goes,
  because the generation check covers it and a leftover metadata backoff cannot gate a scheduled account.
- #6020 tests: replacement during the await, repeated busy refusal then release, reauth then rotation.
- #5494: the regex is anchored to the token-plan phrasing,
  `/usage limit (?:has been )?reached|token-plan\s+\S+\s+quota has been exhausted/`, with a negative case for
  "quota exhausted for this minute". The hold is the existing ten-minute exhaustion cap, not the announced reset.

## Build and evidence

| Commit | What |
|---|---|
| `c79fe409c6` | #6049 (layout registries unioned) |
| `33b1920cce` | #6042 |
| `b697756cdb` | #6037 (`job.ts` import conflict: both imports kept; 1999 lines) |
| `8e08f26f86` | #6020 |
| `2a49525f1d` | #6020 review fix: generation-keyed retries, flat one-minute retry on `NativeMainBusyError`, three regression tests in `codex-quota-auto-refresh-generation.test.ts` (all three fail without the fix) |
| `9fdc0c4582` | #5494: token-plan exhaustion takes the ten-minute hold; positive and per-minute negative tests (the positive fails without the fix) |
| `cafe6202ad` | #6050 (the dev test pinning the old paused-main 409 on clear is removed; the new file covers the contract) |

Kimi's note that #6050 regressed the `shadow` defaults and the Kiro-only `strategy` note came from diffing against
an older base; the squash onto current `dev` changes only the account-selection lines in the eight locales.

Security receipts: #6042 dedicated review, BLOCKER no (connect-phase race stays documented, as the PR states). #6037
review found no blocking defect; the updater launcher now trusts only root-owned absolute paths, and Ingwannu's
earlier CHANGES_REQUESTED findings (lexical ancestors, synchronous probes) are fixed at the carried head.

Aside: #6037 still shows one CHANGES_REQUESTED review and #6020 two, both from earlier heads; this batch answers
#6020's findings in `2a49525f1d`. #5494's page shows the reporter's two messages and no maintainer reply; the fix
covers the part the repository can prove (the 60-second re-offer). Why the official DeepSeek stream ended early needs
the reporter's logs.

Local proof at `cafe6202ad`: typecheck, structure and privacy exit 0; 13 focused files 619 pass, 3 skip, 0 fail;
combo failover files 297 pass; layout and ratchet guards 27 pass.
