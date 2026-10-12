# Round 2 — what the first batch left behind

Status: OPEN. The sixteen post-2.60.0 bundles and the #5261 incident work all landed on `dev`
today. This unit collects what that round deliberately left open, plus two things it caused.

Everything here is either a defect a user hit, a remainder a lane recorded rather than hid, or a
red check on `dev`. Nothing is new scope invented for its own sake.

## Priority 1 — a 2.60.0 regression that locks users out of the transition

#5321: on a Codex home whose history has been migrated to paginated form, enabling the integration
in its authless provider-table shape is hard-refused with
`history_paginated_openai_requires_native_writer`. Nothing is written and the integration stays
disabled. Before 2.60.0 the same transition completed, with the history relabel standing down while
the routing and catalog half was still written.

The guard itself is right. `src/codex/history-provider.ts` explains why: a provider-table
transition removes the root `openai_base_url`, and a row already paginated cannot be relabeled, so
standing it down would route an openai-tagged thread to Codex's own OpenAI endpoint. Refusing to
relabel is correct; refusing the entire transition and saying "do not retry" without naming a way
forward is what traps the user.

The reporter found the only exits by reading the preflight source: delete the affected
conversations, or downgrade. On their home that meant deleting 173 sessions. Neither is a
remediation this project can ship as the supported answer.

#4812 is the same guard family from the other side: `restore`, `stop` and `uninstall` also refuse
on paginated history, which leaves the CLI pointed at a dead proxy port. The two belong in one lane
because a fix that unblocks activation while leaving recovery blocked trades one trap for another.

## Priority 2 — `dev` is red from the desktop landing

The app stack brought a `macos widget + bundle` job. MenuBarCore's 118 tests, the dashboard build,
the sidecar preparation and the WidgetKit appex build all pass; `tauri build` then fails with
`A public key has been found, but no private key`. The updater public key is committed while the
private key is not a CI secret, so Tauri refuses to produce a signed update artifact.

This is configuration, not code. The CI job's purpose is to prove the appex and the app bundle
build and that the widget is embedded, which does not require a signed updater artifact. Release
signing belongs to the release workflow, where the key can be held as a secret.

## Remainders the first round recorded rather than hid

| Item | What is left |
| --- | --- |
| #5292 | `gui/src/pages/Logs.tsx` restates the recovery-kind union with nine of thirteen members, so four durable kinds have no label. The fix derives the GUI union from the roster instead of restating it. |
| #5261 | Generic OAuth and key login still discard the browser launch result, and the dashboard account roster keeps last-good rows after a failed refresh. |
| #4191 | The WebSocket failure projection is not threaded into the durable record, and the SSE fallback the issue asks for is a transport change. |
| #5180 | The shared cooldown and `Retry-After` handling are routing behaviour and were not in the stage-table branch. |
| #4942 + #4989 | Both express rows of the landed stage table and overlap in `upstream-retry.ts` and `passthrough-dispatch.ts`. They must not each buy an independent replacement send for one logical request, so they are one reworked change. |
| #2366, #3748, #3983, #5063 | Deferred as implemented because each adds a parallel store or a second emission path. The derived forms read from the landed recorder instead. |

## Lanes

| Lane | Scope |
| --- | --- |
| R1 | #5321 and #4812 — the paginated-history guard, from both activation and recovery |
| R2 | the `macos widget + bundle` failure on `dev` |
| R3 | #5292 and the two #5261 remainders |
| R4 | #4942 and #4989 as one rework, plus the #4191 and #5180 remainders |
| R5 | the four telemetry pull requests as derived consumers of the recorder |

## Execution constraints

Unchanged. One branch, ordered commits, one pull request to `dev` per lane. No native stack — the
desktop chain proved why: squashing the bottom of one detaches every child and the remaining work
has to be reconstructed. Carried contributor work needs a `Co-authored-by` trailer. No local
suites, typecheck, builds, installs or live `ocx` execution; verification is static review plus
exact-head hosted CI. Only the coordinator merges and closes.
