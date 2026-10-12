# wp3 — pull-request triage

Every open pull request was inspected at its exact head against `dev` `2b19983bfd`. The headline
result decides the release: **nothing is merge-ready, so 2.57.0 ships the 184 commits already on
`dev` and nothing else.**

## Why nothing lands

Two reasons account for almost every verdict.

The first is missing evidence. A pull request head here typically carries only the four policy
checks — `enforce-target`, `resolve-pr`, `label`, `hygiene` — and no product test suite. GitHub
reports `MERGEABLE / BLOCKED`, which reads like a branch-protection detail but means the required
test check never ran at that head. Merging on that basis would put an untested tree into a release
candidate.

The second is unresolved review. Several of the ready pull requests carry Codex or CodeRabbit
findings that are correct and open.

## Ready (non-draft) pull requests

| PR | Head | Verdict | The one blocking thing |
| --- | --- | --- | --- |
| #4824 | `4c984dbb7c` | NEEDS-WORK | No product CI at head. |
| #4823 | `867c8868f9` | HOLD | A new Opper provider preset is a credential-destination change; the primary-source evidence review required by `MAINTAINERS.md` is not complete. |
| #4816 | `47e8fe61ff` | HOLD | Process-global model-only window cache crosses account and request-mode boundaries (`src/adapters/cursor/discovery.ts:37`). CI green at `35097464862`. |
| #4815 | `407bf3ce56` | HOLD | Textual and structural frames can execute one tool call twice (`src/adapters/cursor/protobuf-events.ts:1273`). Seven open findings. CI green at `35096642245`. |
| #4805 | `91d74200a2` | HOLD | Credential-export change awaiting explicit security review; five open findings. |
| #4804 | `83668e1c4f` | NEEDS-WORK | Fresh-connection policy must be recomputed after dispatch overrides finalize the URL (`src/server/responses/fetch-helpers.ts:114`). |
| #4803 | `543f1c60a4` | HOLD | A non-terminal text EOF becomes HTTP 200, which can hide genuine truncation (`src/server/chat-native-sse.ts:367`). |
| #4802 | `14c478cda2` | NEEDS-WORK | No product CI at head. |
| #4800 | `af985d3d13` | NEEDS-WORK | 13 commits behind `dev`, past the 10-commit readiness window; needs a refresh and new exact-head CI. |
| #4782 | `76d7452afb` | HOLD | Experimental native steering, 40 files, no test CI and no live smoke. |
| #4781 | `110656662f` | HOLD | Profile-auth UI hangs on refresh (`gui/src/native-main-profile-session.ts:124`). |
| #4753 | `f07c61b3a3` | NEEDS-WORK | Duplicated admission route registry (`src/server/inbound-body-admission.ts:27`). |
| #4751 | `eb6184e98d` | NEEDS-WORK | 504 precedence and event-loop yield need a correctness pass. |
| #4728 | `82b652349d` | HOLD | 28k added lines across four control planes, with an unresolved vault salt finding (`src/credentials/vault.ts:27`). Not release-compatible breadth. |
| #4183, #3983, #3952 | — | HOLD | Each is 950-1150 commits behind `dev` and conflicting. Reconstruction, not review. |

## Drafts

`#4560` is the notable one: it is no longer conflicting, sits zero commits behind `dev`, and is a
44-file, 5k-line GUI redesign with no test CI at its head. It is held for the same evidence reason
as the rest, not because of its content.

`#4817` claims issue #4808 and is the only draft whose logic was disputed on review: as written it
replays ambiguous errors, while `src/server/responses/combo-stream-preflight.ts:160-162` documents
the fail-closed boundary the issue depends on. It needs affirmative retry evidence before it lands.

`#4783` is titled `[WRONG BRANCH]` and targets `main`, 184 commits behind. Its work is genuinely
unique — `src/web-search/backends.ts:82-89` on `dev` ends at Exa and exports no API-key search
executor — so it should be reopened against `dev` rather than closed as superseded.

`#4020` is structurally conflicted: a virtual merge from base `94063d0798` conflicts in 11 files
including `src/codex/auth-api.ts`, `src/codex/routing.ts` and `src/config.ts`.

## Stale contributor pull requests

Thirteen contributor drafts are both conflicting and five or more days without a substantive
commit: #2280, #2351, #2355, #2562, #3025, #3080, #3282, #3283, #3463, #3738, #4022, #4056, #4225.
#2562's pool and failover behaviour is already generalized on `dev`
(`src/oauth/generic-account-failover.ts:300`), and #3283 still imports a developer-local 2.51.0
tree (`tests/antigravity-balance.test.ts:2`).

These are other people's work, so the disposition is an owner decision rather than a triage
outcome, and nothing was closed on triage authority alone.
