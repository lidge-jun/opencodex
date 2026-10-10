# 040 — Source-of-truth, verification, and dev integration

Depends on: `010_ca_publication.md`, `020_desktop_continuity.md`, and `030_codex_drift_heal.md`. Work phase `wp4`. Delivery is one ordinary PR from this lane branch to `dev`; no release or promotion action.

## File changes (diff-level)

| Path | Change | Before → after |
| --- | --- | --- |
| `structure/clients/claude-desktop.md` | MODIFY | A failed predecessor untrust is described only as disabling picker → document the blind egress relay, actual applied URL, preserved row/retry, public pending journal and process-restart retry, with no claim that picker MITM arms. |
| `structure/config.md` | MODIFY | Drift heal says the tick reruns standard full sync → document direct guarded config reinjection, generation cancellation and the write-lock deadline scope; catalog-only convergence remains separate. |
| `structure/overview.md` | MODIFY | No bound picker rotation/continuity invariant → add a narrowly worded `INV-PICKER-01` bound to a test file that actually covers the failed-untrust applied URL and journal retry. The test repeats the id in a comment. |
| `docs-site/src/content/docs/guides/claude-code.md` | MODIFY | Restart guidance omits failed predecessor cleanup → explain that Desktop remains connected through its profile proxy as a blind relay while picker aliases are unavailable, and that `picker status`/a later retry reflects recovery. English remains canonical; review translated versions for contradictions and adjust directly affected translations only. |
| `devlog/_fin/260927_release_train_4/picker-ca/` | MODIFY | Fill each numbered phase with the actual result, commands, PR/CI links and limitations. Keep unreleased security working detail in ignored `.tmp/`. |

## Gates and exact-head evidence

1. Rebase/merge latest `origin/dev` before push; inspect the union for file-size caps, locale/union/count drift, and touched-source doc map. Do not raise ratchet caps.
2. Run focused picker CA/runtime/recovery and Codex scheduler tests with isolated home; `bun run test:changed`; `bun run typecheck`; `bun run privacy:scan`; `bun run structure:check`; `bun run skill:surface:check`. Run docs-site frozen install/build if the guide changes. The local full suite may be omitted for seven-lane contention only with exact focused results and the CI coverage boundary in PR Verification.
3. Independently review the source, the direct CONNECT observation, journal contents, test home paths and private-key absence. No real user keychain, Desktop library, or service is touched.
4. Fill the repository PR template. Security-sensitive CA changes require explicit technical security review under `MAINTAINERS.md`. Verify the branch is current, every required check is **success on the PR's exact head**, and correct Codex/CodeRabbit findings are addressed. If macOS shards are skipped by the native path filter, run or request an exact-head `macos-control` workflow and report its own job result; a skipped job is not success.
5. Merge only this PR into `dev` under the delegated authority, record PR number/merge SHA and policy choice, then inspect the resulting dev CI. If red due to this change, repair via a new scoped PR and repeat the gate. Do not modify `main`, `preview`, version, release, or another lane.
