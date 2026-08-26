# 000 Plan: Windows model-picker full-restart path

## Problem

ocx sync --restart-codex rewrites the Codex catalog JSON and restarts the Codex
app-server (codex.exe app-server). Observed behavior:

- macOS: the desktop app model picker reflects the new catalog right away.
- Windows (stable/beta, MSIX package OpenAI.Codex_26.818.3698.0): the picker
  keeps the stale list until the whole desktop app is quit and relaunched.

Local evidence (2026-08-21):

- Desktop UI processes are ChatGPT.exe (Electron shell), installed as MSIX
  package family OpenAI.Codex_2p2nqsd0c76g0, start app id (AUMID)
  OpenAI.Codex_2p2nqsd0c76g0!App.
- ocx sync --restart-codex matches only codex.exe app-server and
  codex-code-mode-host.exe command lines
  (src/codex/app-server-processes.ts, isCodexAppServerCommandLine). The
  Electron UI is never signalled, so its cached picker survives.
- After the 20:57 sync + restart, codex.exe (PID 8592) started fresh at 20:59
  while all ChatGPT.exe UI processes kept their earlier start time, and the
  picker still showed only OpenAI models.

Research findings (subagent, bundle inspection of app.asar):

- The renderer fetches model/list and config/read over stdio JSON-RPC into a
  TanStack Query cache; there is no filesystem watcher on the catalog file.
- The UI invalidates those queries only on a codex-app-server-initialized
  event. On Windows, externally killing the codex.exe child may not produce
  that event reliably (hypothesis, untested from inside this session), which
  would explain why ocx restart alone does not refresh the picker here while
  macOS recovers.
- Official docs say to restart the desktop app after changing model_catalog_json;
  no supported refresh hook exists. Known upstream cluster: openai/codex
  issues 19694, 26308, 32349, 34487 (desktop picker vs CLI catalog divergence).
- Relaunch must go through MSIX activation (shell:AppsFolder AUMID), not the
  exe path under WindowsApps (ACL-restricted, no package identity).

## Scope

IN (audit amendments folded in):

- A supported, documented way to fully restart the Windows Codex desktop app
  after a catalog sync: graceful WM_CLOSE first, bounded taskkill /T /F
  fallback, relaunch via AUMID. Targets resolve InstallLocation at runtime
  via Get-AppxPackage -PackageFamilyName (the family string is NOT a
  substring of the install path); only the root ChatGPT.exe whose parent lies
  outside the package is selected so taskkill /T cascades to codex.exe and
  codex-code-mode-host.exe; the script refuses to kill its own ancestry.
- A GitHub issue on lidge-jun/opencodex recording the platform gap, the beta
  caveat, upstream issue links, and the requested UX (sync should offer a full
  app restart on Windows). The issue MUST include Version (installed
  @bitkyc08/opencodex version) and Operating system fields, which
  enforce-issue-quality hard-requires once Client or integration is present;
  Reproduction carries the PID/start-time evidence; upstream issues are cited
  as related-but-unverified.

OUT:

- Changing ocx sync runtime behavior in this unit (the issue proposes it;
  implementation is a later unit).
- Killing processes outside the OpenAI.Codex_2p2nqsd0c76g0 package family.
- Testing the unverified stdio-respawn hypothesis by killing codex.exe from
  inside this session (would kill our own host); recorded as an open question
  for an external terminal test.

## Work phases

- wp1 (010): add scripts/restart-codex-desktop-app.ps1 with -DryRun/-Force,
  graceful-close then bounded forced fallback, relaunch via AUMID; file the
  templated GitHub issue; record evidence.

## Accept criteria

- Script -DryRun exits 0 AND lists the specific live root PID(s) it would
  stop and the relaunch command, without stopping anything (an exit-0 no-op
  does not pass). Focused probe evidence per scripts/AGENTS.md is the real
  gate (tsconfig includes only src/); bun x tsc --noEmit still runs as a
  no-regression check.
- Issue exists on origin with bug_report template headings.

## Safety notes

- Running the restart from inside a Codex conversation kills that conversation
  host app; the script warns and docs say to run it from an external terminal.
- Forced kill is limited to processes whose Path is under the runtime-resolved
  InstallLocation. Close-to-tray behavior is explicitly checked: if
  CloseMainWindow() only hides the window, the wait expires and the forced
  path runs; record observed behavior. Record the PowerShell edition the
  probe ran under (Get-AppxPackage differs between 5.1 and 7).
