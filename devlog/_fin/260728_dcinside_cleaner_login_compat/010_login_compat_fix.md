# Phase 1: browser-driven account cleanup

## Exact actions

- Navigate the already-running headed `agbrowse` profile to the official DCInside login page with gallog as the return URL.
- Pause for the user to enter credentials and complete any CAPTCHA; do not inspect secure fields or extract cookies.
- Snapshot the authenticated gallog and require exact path `energy6435`, nickname `ㅇㅇ`, post count `1146`, and comment count `3171` before mutation. The user's explicit request to delete all content plus explicit 5-at-once instruction is the human authorization for this exact account/count set.
- Discover the current delete controls/requests from the live gallog only after login; do not reuse the stale 2023 client contract.
- Run posts and comments as two serial classes. Before each class, enumerate every page into an in-memory deletion ledger with item type, `data-no`, canonical URL, page index, date, and a local content hash. Do not persist raw post/comment text. Ledger count must equal the visible total or the run stops.
- Delete only ledgered IDs, in batches of at most 5 concurrent same-origin requests with a delay between batches. Parse the active URL with `new URL`; destructive calls require protocol `https:` and host exactly `gallog.dcinside.com`.
- Treat the first 5-item batch as the activation probe. Verify the class count changes by exactly `-5`, all five IDs disappear, the other class count is unchanged, and account/origin remain exact before continuing.
- Stop without retry acceleration or automated solving on CAPTCHA/kcaptcha markers, 403/429, login redirect, IP-block text, unexpected modal, malformed/non-JSON response, or any non-success deletion result.
- Refresh gallog after each class and verify its count reaches zero before continuing.

## Verification

- `agbrowse snapshot --interactive` before and after every navigation or mutation.
- `agbrowse active-tab --json` plus parsed `new URL(...)` verifies login hosts separately and requires mutation host exactly `gallog.dcinside.com`.
- Pre-delete snapshot proves account identity and counts; any ambiguity pauses for the user.
- First five deletions are observed as one activation probe; exact `-5` count delta and ID absence gate the remaining batches.
- Final hard reload re-enumerates every post/comment page with the same ledger logic and proves both visible counts and discovered item counts are zero; otherwise report residual IDs/URLs and the blocker.

## Rollback

- No deleted item is assumed recoverable. Stop immediately on unexpected state.
- `agbrowse stop` closes the automation browser without touching the user's normal Chrome profile.
- No source, remote repository, or account credential is modified.
