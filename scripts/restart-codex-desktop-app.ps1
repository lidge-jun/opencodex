#Requires -Version 5.1
<#
.SYNOPSIS
  Fully restarts the Windows Codex desktop app (MSIX package) so the model
  picker re-reads the on-disk catalog after ocx sync.
.NOTES
  Run this from an external terminal. Running it from inside a Codex
  conversation kills the app hosting that conversation.
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$PackageFamily = "OpenAI.Codex_2p2nqsd0c76g0"
$Aumid = "OpenAI.Codex_2p2nqsd0c76g0!App"

Import-Module Appx -ErrorAction SilentlyContinue
$pkg = Get-AppxPackage -Name OpenAI.Codex | Where-Object { $_.PackageFamilyName -eq $PackageFamily }
if (-not $pkg -or -not $pkg.InstallLocation) {
  Write-Error "MSIX package $PackageFamily was not found; nothing to restart."
  exit 1
}
$InstallLoc = $pkg.InstallLocation

$nameFilter = "Name='ChatGPT.exe' OR Name='codex.exe' OR Name='codex-code-mode-host.exe'"
$all = @(Get-CimInstance -ClassName Win32_Process -Filter $nameFilter)
$targets = @($all | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.StartsWith($InstallLoc, [System.StringComparison]::OrdinalIgnoreCase)
})

if ($targets.Count -eq 0) {
  Write-Host "Codex desktop app is not running."
  exit 0
}

$targetIds = @{}
foreach ($t in $targets) { $targetIds[[uint32]$t.ProcessId] = $t }

# Roots are targets whose parent is outside the package tree; killing each
# root with taskkill /T cascades to codex.exe and its code-mode-host child.
$roots = @($targets | Where-Object { -not $targetIds.ContainsKey([uint32]$_.ParentProcessId) })

# Self-kill guard: never target our own ancestry. Skipped under -DryRun so the
# report stays useful when Codex itself launched this script.
$ancestry = @{}
if (-not $DryRun) {
  $cursor = $PID
  while ($cursor) {
    $ancestry[[uint32]$cursor] = $true
    $parent = (Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$cursor").ParentProcessId
    if ($parent -and -not $ancestry.ContainsKey([uint32]$parent)) { $cursor = $parent } else { break }
  }
  foreach ($r in $roots) {
    if ($ancestry.ContainsKey([uint32]$r.ProcessId)) {
      Write-Error "Refusing to restart: selected root PID $($r.ProcessId) is an ancestor of this script."
      exit 1
    }
  }
}

Write-Host ("Targets ({0}):" -f $targets.Count)
foreach ($t in $targets) {
  Write-Host ("  PID {0}  {1}  parent={2}" -f $t.ProcessId, $t.Name, $t.ParentProcessId)
}
Write-Host ("Root(s) to stop: {0}" -f (($roots | ForEach-Object { $_.ProcessId }) -join ", "))
Write-Host ('Relaunch command: Start-Process "shell:AppsFolder\{0}"' -f $Aumid)

if ($DryRun) {
  Write-Host "Dry run: nothing was stopped or launched."
  exit 0
}

foreach ($r in $roots) {
  $rootPid = [uint32]$r.ProcessId
  $stopped = $false
  if (-not $Force) {
    $proc = Get-Process -Id $rootPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne 0) {
      Write-Host "Sending graceful close to PID $rootPid..."
      [void]$proc.CloseMainWindow()
      for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        if (-not (Get-Process -Id $rootPid -ErrorAction SilentlyContinue)) { $stopped = $true; break }
      }
      if (-not $stopped) {
        Write-Host "PID $rootPid survived graceful close (close-to-tray suspected); forcing."
      }
    }
  }
  if (-not $stopped) {
    Write-Host "Force-stopping process tree at PID $rootPid..."
    & "$env:SystemRoot\System32\taskkill.exe" /PID $rootPid /T /F | Out-Null
  }
}

Start-Sleep -Seconds 1
Start-Process "shell:AppsFolder\$Aumid"
Write-Host "Codex desktop app restarted."
