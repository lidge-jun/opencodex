# 040 — wp5: live proof, PR, CI, squash merge

## Live proof (macOS, this machine)

The operator's service runs the `dev` checkout. The proof runs this branch as that service only
for the proof window, then returns it to `dev` if the PR does not merge.

1. Commit everything; record the branch head.
2. In `/Users/jun/Developer/new/700_projects/opencodex` (clean `dev`): `git fetch origin
   codex/claude-desktop-picker-mode` and `git switch --detach FETCH_HEAD`; `bun run build:gui`;
   `ocx service restart`; verify `/healthz`, PID path, listener.
3. `ocx claude desktop apply --first-party` (the operator's saved mode is already first-party):
   the CLI delegates to the running service; expect the risk warning and a picker status. If the
   service could not raise the keychain dialog the status is `trust_pending`: run
   `ocx claude desktop picker trust` in the terminal, where the macOS password dialog is the
   operator's step (NEEDS_HUMAN). Record which path showed the dialog (service or CLI). Then
   `ocx claude desktop picker status` → `active` or `restart_required`.
3b. Name-constraint check on the Apple path: issue an ephemeral leaf for `example.com` from the
   picker CA into `/private/tmp` (never into the config directory) and run
   `security verify-cert -q -L -c <leaf> -p ssl -n example.com -k <login keychain>`; record the
   exit code. Non-zero → the PR may state that macOS enforces the constraint; zero → the PR states
   that only the key's confidentiality protects other names on this OS. Delete the ephemeral leaf.
4. Quit and reopen Claude Desktop (Computer Use). Check `main.log` for the egress pin line pointing
   at the picker proxy port (`pickerProxyPort`, the intercept port + 1, never the Claude Code proxy
   port), record the applied profile's exact `egressProxyUrl`, and find the picker log line
   `picker GET bootstrap 200`.
5. Code tab → model picker: screenshot showing opencodex models by name next to Anthropic's.
6. Pick one (e.g. the xai Grok route), send "Reply with exactly: OCX-PICKER-PROBE. Do not use any
   tools." Screenshot the reply; `usage.jsonl` must show the routed provider on the `messages`
   ingress within the minute.
7. Connectivity: Chat tab still loads (screenshot), a claude.ai WebSocket session (Code session
   list refresh) still works.
8. Dashboard screenshots: mode selector with the gateway default badge and the first-party risk
   callout; picker card active.
9. If the operator declines the dialog: record NEEDS_HUMAN for criterion c-8, keep the rest.
10. After the proof, if the PR has not merged, roll back in this order while the branch service is
    still running: `ocx claude desktop picker off` (branch CLI), verify the `opencodex-picker` row is
    gone from `_meta.json`, `security find-certificate -a -Z -c "opencodex Claude Desktop Picker CA"`
    finds nothing in the login keychain, and `claudeCode.intercept.picker` is false; fully quit and
    reopen Desktop and confirm its log shows no egress pin; only then return the service checkout to
    `dev` (`git switch dev`, rebuild GUI, restart). Record each result as rollback proof. If the PR
    has merged, fast-forward `dev` and restart instead; picker stays under the new code's control.

## PR

- Title: `feat(claude): gateway by default, first-party risk warning, and Desktop picker mode`.
- Body per `.github/PULL_REQUEST_TEMPLATE.md`: Summary (problem, behavior before/after), screenshots
  uploaded to the `pr-assets` branch and linked by commit SHA, Verification (commands + results,
  what was not run locally and why), Checklist. No mention of third-party projects.
- Security review: an independent gpt-6-sol reviewer reads the full diff against the untracked
  threat model at `.tmp/260924_claude_desktop_picker_mode/threat_model.md`; findings are folded
  before merge and summarized in the PR.

## CI and merge

- Exact-head check-runs for the PR head (aggregate `ci` and its producers) must be completed and
  successful; skipped path-gated jobs are listed as skipped, not as passed.
- Merge-result preflight: `git merge-tree --write-tree origin/dev HEAD`, file-size preflight on that
  tree (offenders 0), typecheck and focused suites on a worktree of the merge result.
- `gh pr merge <n> --squash --admin --match-head-commit <head>` (user authorized merge).
- Verify `origin/dev` tip is the squash commit whose tree equals the verified merge-result tree.
