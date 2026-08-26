# 010 wp1: Restart script + issue (diff level)

## NEW: scripts/restart-codex-desktop-app.ps1 (amended per audit)

PowerShell 5.1-compatible script:

- param([switch]$DryRun, [switch]$Force).
- Constants: package family OpenAI.Codex_2p2nqsd0c76g0, AUMID
  OpenAI.Codex_2p2nqsd0c76g0!App, process names ChatGPT, codex,
  codex-code-mode-host.
- Resolve $installLoc = (Get-AppxPackage -PackageFamilyName
  OpenAI.Codex_2p2nqsd0c76g0).InstallLocation at runtime; fail with an
  actionable message when empty. Wrap process Path access in try/catch
  (Access denied for other users processes).
- Select ONLY the root ChatGPT.exe whose ParentProcessId lies outside
  $installLoc (Win32_Process via Get-CimInstance). taskkill /PID <root> /T /F
  cascades to codex.exe and its codex-code-mode-host.exe child. Never list
  code-mode-host as an independent target.
- Self-kill guard: walk $PID ancestry; abort with a clear message when any
  selected target is in it.
- Warn: active Codex turns are interrupted; run from an external terminal.
- Graceful pass: CloseMainWindow() on the process with a MainWindowHandle,
  wait up to 15 s in 1 s polls for all targets to exit. If the process
  survives past the timeout, print that close-to-tray behavior is suspected
  before escalating.
- Forced pass (remaining targets, or immediately with -Force):
  taskkill /PID <id> /T /F per remaining PID (/T covers child tree so
  codex.exe is not orphaned).
- Relaunch: Start-Process "shell:AppsFolder\<AUMID>" unless -DryRun.
- -DryRun: print planned actions (targets, method, relaunch command), touch
  nothing, exit 0.

## MODIFY: none (runtime untouched in this unit)

## Verification

## Cycle 2 addendum (2026-08-21, provider verification + push)

- command-code stealth/ox-alpha re-probed after credit purchase: /v1/chat/completions
  and /v1/responses both return 200 with valid completions. No code change needed.
- opencode-go upstream (https://opencode.ai/zen/go/v1) returns 500 Internal server
  error for every model probed directly (kimi-k2.7-code, ox-alpha-free); the proxy
  502 "upstream stream ended" is an upstream outage, not an adapter defect.
  ox-alpha-free is also absent from models.dev opencode-go roster and from
  scripts/model-metadata.source.json, so the opencode-go/ox-alpha-free slug was
  never a registered catalog model; opencode-free/x-preview-f-free is the working
  free-tier route (verified 200 on both endpoints).
- Direct push to origin/dev rejected by ruleset 20763889 (pull_request rule, admin
  bypass = pull_requests_only). Fallback per user intent: branch
  codex/windows-restart-helper pushed, PR #2293 opened targeting dev (MERGEABLE).

- powershell -File scripts/restart-codex-desktop-app.ps1 -DryRun -> exit 0
  AND output names the live root PID (e.g. 9928) and its child codex.exe;
  nothing stopped. Record $PSVersionTable.PSVersion.
- bun x tsc --noEmit -> exit 0.
- gh issue create with bug_report.yml headings: Client or integration = Codex
  App; Area = Platform (Windows / macOS / Linux); Version = installed
  @bitkyc08/opencodex version (package.json); Operating system = Windows 11
  (build from systeminfo); Reproduction includes the 20:57 sync / 20:59 fresh
  codex.exe vs stale UI start-time evidence; upstream issues
  19694/26308/32349/34487 cited as related-unverified; beta-channel caveat
  stated. After creation, re-read state with gh issue view until the
  enforce-issue-quality workflow settles (creation alone can auto-close).
