# B8 — Remote Link relay and enrollment, sidecar probe, Windows Desktop proxy report

Base: `dev` `29cef45a86` (after B7 #6070; open issues reached 40). Branch `codex/train3-b8`.

| PR | Author | Change | Review |
|---|---|---|---|
| #6064 | luvs01 | Enrollment cancellation and commit share one terminal outcome: a tunnel exit aborts the connection transaction, an exit after commit keeps the key, and an exit before commit drains local rollback before revoking | APPROVE; security BLOCKER no; negative control fails the three advertised cases |
| #6068 | luvs01 | The Child relay authenticates and streams on one socket with a one-use, direction-tagged proof; pending rotation keys are accepted; no plain-fetch fallback (supersedes closed #6044) | LAND; security BLOCKER no; Windows segfault hold passed on the exact head (fork run) |
| #6067 | luvs01 | The web-search probe is released when the error body settles, not on status alone (follow-up to #6047) | APPROVE; new tests fail on dev |
| #6065 | kaladinhonor | `ocx doctor` and Desktop status report a Windows system proxy that bypasses Desktop first-party | APPROVE; prior hold points fixed |

Order: #6064 before #6068, resolving their shared tail of `structure/remote-link.md`; new layout entries go on
existing lines. Security reviews for #6064 and #6068 are recorded in scratch.

## Build and evidence

Carried: `159085ed6c` (#6064), `e1c8943670` (#6068; the `remote-link.md` tail keeps both sections),
`a5e2f7272a` (#6067), `390b69f2c8` (#6065); `eab0ac1422` pairs the two new layout entries (layout.json 1994 lines).

Local: typecheck, structure and privacy exit 0; the six carried test files plus `doctor.test.ts`: 185 pass here, and
the 19 `doctor` failures are this worktree's protected-home guard. In a `/tmp` worktree at `eab0ac1422`,
`doctor`, `link-join-route` and `claude-desktop-system-proxy` pass 136/136.

Aside: all four PR pages captured; no open CHANGES_REQUESTED review on any of them. Security reviews for #6064 and
#6068 (BLOCKER no) are kept in scratch.
