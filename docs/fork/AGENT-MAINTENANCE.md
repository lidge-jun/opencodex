# Jules and Cursor maintenance

This repository uses GitHub as the control plane. Jules implements trusted maintenance issues and opens pull requests against `dev` (the repository integration branch); the existing Cursor Automation continues to own only `hotspot-handoff` and `history-diverged` upstream-sync cases. Cursor Bugbot, CodeRabbit, CI, and maintainers review every resulting pull request. Changes merge to `dev` first and promote to `main` on release.

## Repository settings

Install the Google Jules and Cursor GitHub Apps for this repository only. Configure Jules for co-authored commits and Reactive Mode. Configure Bugbot for automatic full-diff reviews with Autofix, learned public-comment rules, and unnecessary MCP access disabled.

Add secret `JULES_API_KEY` and variables:

- `AGENT_MAINTENANCE_MODE=off|shadow|dispatch|repair`
- `AGENT_MAINTENANCE_SCHEDULES=off|on`
- `CURSOR_BUGBOT_POLICY=shadow|required`
- `CURSOR_BUGBOT_APP_ID=<immutable App ID>`
- `CURSOR_BUGBOT_USER_ID=<immutable bot user ID>`
- `JULES_BOT_USER_ID=<immutable Jules GitHub user ID>`

Capture the IDs from a staging Bugbot review. Keep the controller at `off` until every value exists. The controller creates its lifecycle labels lazily.

## Dispatch and recovery

A current `write`, `maintain`, or `admin` actor applies `agent:jules` for direct implementation or `agent:plan` for plan approval. The controller stores one state marker on the issue, limits Jules to two active tasks, and reconciles every 15 minutes. Duplicate events reuse the deterministic task title; uncertain create responses are resolved by listing sessions before any retry.

Every Jules PR must remain open in this repository with base `dev`. Bugbot passes only with a successful check from the configured App ID on the live head. `neutral`, stale checks, comments, and resolved threads do not pass. The `review-bot-waived` outage label passes only with approvals from two current maintainers on that exact head.

Repair mode accepts only current-head review comments from `CURSOR_BUGBOT_USER_ID`, caps the digest at 10 findings and 12 KiB, and permits two prompts. Protected paths, unexpected head movement, a third dirty review, or an allowlist expansion stop at `agent:needs-human`.

Weekly documentation drift is limited to `README.md`, `docs-site/**`, `screenshots/**`, `examples/**`, and related documentation tests. Monthly test health is limited to `tests/**`; production work must move to a separate `agent:plan` issue. A clean automated review stays in `agent:reviewing`; only a human-merged PR reaches `agent:done`.

## Ruleset

Protect fork `main` with pull requests, deletion and force-push blocking, dismissed stale approvals, approval of the most recent reviewable push by someone other than its pusher, and no automation bypass. Allow merge commits for upstream sync. Require one maintainer approval ordinarily and the existing two-maintainer trusted gate for protected paths.

Require `Cross-platform CI / ci`, `Enforce PR target branch / enforce-target`, and `PR hygiene / hygiene`; bind each check to its expected GitHub App where GitHub supports a source binding. Enable GitHub auto-merge only after a maintainer expresses merge intent. Keep owner-only emergency recovery.

## Rollout

1. Start `shadow` for the controller and Bugbot policy; verify event payloads, IDs, check names, and API shapes.
2. Set maintenance mode to `dispatch` and run one docs-only issue.
3. Set Bugbot policy to `required`; prove stale, neutral, and spoofed checks stay blocked.
4. Set maintenance mode to `repair`; prove one controlled repair creates a new SHA and a new Bugbot review.
5. After two weeks without duplicate sessions, stale-head acceptance, or uncontrolled pushes, set `AGENT_MAINTENANCE_SCHEDULES=on`.

Switching `AGENT_MAINTENANCE_MODE` to `off` is the kill switch. Changes to workflows, credentials, release automation, authentication, or dependency installation still require explicit human security review.
