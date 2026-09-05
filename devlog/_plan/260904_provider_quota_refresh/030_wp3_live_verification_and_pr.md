# wp3 — live verification, screenshots, push and PR

Neither defect is provable by unit test alone: both were reported against a running
dashboard, and `enforce-target` requires a screenshot for any GUI-mentioning PR. This
phase is the evidence phase.

## Build and load order

1. `bun run build:gui` — the service serves `gui/dist`, so an unbuilt change is
   invisible no matter how green the tests are.
2. `ocx service restart` — picks up the server-side `observed` flag. Confirm a new
   pid and fresh uptime on `/healthz`, and that the port is still 10100. The service
   is the user's own; restart it, never repoint or reconfigure it.
3. `curl /api/provider-quotas` with the admin token — the meta-muse row must now
   carry `"observed": true`. This is the wire-level proof, checked before the UI so a
   blank screen can be attributed correctly.

## Browser verification (`aside-jun`, CLI repl on the signed-in profile)

The dashboard is loopback and needs no login, so `aside repl` is the right surface:
one invocation is one session, it throws on a bad path instead of skipping, and the
screenshots land as real files. A whole inspect-act-verify flow must fit in a single
invocation because bindings do not persist between calls.

Shots to capture into `devlog/_plan/260904_provider_quota_refresh/assets/`:

| File | Content |
|------|---------|
| `010_meta_usage_quota.png` | meta-muse → Usage tab with both windows and the observation age |
| `020_usage_refresh_button.png` | the Usage rate-limits header with its refresh control |
| `030_accounts_refresh_button.png` | the Accounts tab refresh control for an OAuth provider |
| `040_refresh_result.png` | the post-click success status |

Aside writes under `~/.aside/u/0/`; Codex copies the files into the repository. Every
`aside` invocation runs under `perl -e 'alarm shift; exec @ARGV' 300` because macOS
has no `timeout` and the bare spelling exits 127 without ever starting the run.

## Push and PR

- Branch `codex/260904-provider-quota-refresh`, commits as the phases close.
- `git push --no-verify` — explicitly authorized by the requester.
- PR against `dev` with the full template: Summary, Verification, Checklist, and the
  screenshots inline. `enforce-target` rejects a thin description and a GUI PR with
  no screenshot.
- The suite line in Verification must state plainly which focused files were run and
  that the repository-wide suite was withheld at the requester's instruction, rather
  than implying a full green run.

## Criteria closed here

c-1 (Meta renders), c-2 (Accounts refresh), c-3 (Usage refresh), c-5 (push + PR).
c-4 closes at the end of wp2 with the command output.
