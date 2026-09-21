# Behavioral driver for the tray startup-health probe lifecycle.
#
# Loads the REAL probe functions out of src/tray/windows-tray.ps1 via the
# PowerShell AST (function definitions only - the top-level tray UI never runs),
# stubs the WinForms controls with plain objects, stages a real hung child
# process through the real Start-StartupHealthProbe, backdates its start past
# the real timeout, then invokes the real Update-TrayState ticks and reports
# observable process facts as JSON.
#
# Backdating the clock instead of sleeping 30s is deliberate: elapsed time is an
# input to the maintenance branch, not the logic under test. What IS under test
# is that the branch observes a timed-out child and terminates it.
#
# Scenarios:
#   Offline - nothing answers /healthz, so the tray must stay offline AND still
#     terminate the hung probe outside the online-only UI branch.
#   Online  - the caller serves a fake /healthz and points runtime-port.json at
#     it, so the first tick launches the probe through the real cameOnline gate;
#     later ticks must kill the hung child and must not stack a replacement
#     before the refresh interval (the pid file proves launches == 1).

param(
  [Parameter(Mandatory = $true)][string]$TrayScriptPath,
  [Parameter(Mandatory = $true)][string]$ChildEnginePath,
  [Parameter(Mandatory = $true)][string]$HangChildPath,
  [Parameter(Mandatory = $true)][string]$CodexHome,
  [Parameter(Mandatory = $true)][string]$OpenCodexHome,
  [Parameter(Mandatory = $true)][string]$ResultPath,
  [ValidateSet("Offline", "Online")][string]$Scenario = "Offline"
)
$ErrorActionPreference = "Stop"

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($TrayScriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "tray script parse failed: $($parseErrors[0].Message)" }
$wanted = @(
  "Write-ActionLog",
  "ConvertTo-NativeArgument",
  "Parse-StartupHealthText",
  "Start-StartupHealthProbe",
  "Complete-StartupHealthProbe",
  "Read-ListenTarget",
  "Read-JsonUrl",
  "Update-TrayState"
)
$definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
$loaded = @()
foreach ($fn in $definitions) {
  if ($wanted -contains $fn.Name) {
    # Dot-source the full definition extent: several probe functions declare
    # parentheses-style params (function F([string]$X) {...}), which live on
    # the definition AST rather than the body. Installing only the body would
    # silently drop those params ($X binds $null and the call misbehaves),
    # while installing the raw extent as a body would make every call a
    # silent no-op that merely redefines the function. Dot-sourcing defines
    # each function exactly as the tray script declares it.
    . ([ScriptBlock]::Create($fn.Extent.Text))
    $loaded += $fn.Name
  }
}
$missing = @($wanted | Where-Object { $loaded -notcontains $_ })
if ($missing.Count -gt 0) { throw "tray script is missing functions: $($missing -join ', ')" }

# Production-shaped inputs (normally the script params and top-level state).
$BunPath = $ChildEnginePath
$CliPath = $HangChildPath
$BunRuntimeSource = "process"
$CodexHome = $CodexHome
$OpenCodexHome = $OpenCodexHome
$HostPid = 0
$heartbeatPath = Join-Path $OpenCodexHome "tray-heartbeat.json"
$actionLogPath = Join-Path $OpenCodexHome "tray-actions.log"

# WinForms stand-ins: Update-TrayState only sets plain properties on these.
$statusItem = [PSCustomObject]@{ Text = ""; Enabled = $false }
$safetyItem = [PSCustomObject]@{ Text = "" }
$notify = [PSCustomObject]@{ Text = ""; Icon = $null }
$startItem = [PSCustomObject]@{ Enabled = $true }
$stopItem = [PSCustomObject]@{ Enabled = $false }
$restartItem = [PSCustomObject]@{ Enabled = $false }
$onlineIcon = $null
$warningIcon = $null
$offlineIcon = $null

# Mirror the tray's script-state initialization.
$script:online = $false
$script:port = 10100
$script:proxyPid = $null
$script:wasOnline = $false
$script:startupHealth = $null
$script:startupHealthCheckedAt = 0
$script:startupRefreshMs = 20000
$script:startupProbeProcess = $null
$script:startupProbeOutputTask = $null
$script:startupProbeErrorTask = $null
$script:startupProbeStarted = 0
$script:startupProbeTimeoutMs = 30000
$script:pendingAction = $null
$script:pendingStarted = 0
$script:pendingDeadline = 0
$script:pendingOldProxyPid = $null
$script:pendingProcess = $null

$childPid = 0
try {
  if ($Scenario -eq "Online") {
    # First tick settles wasOnline and launches the probe through the real
    # cameOnline gate against the fake /healthz the caller serves.
    Update-TrayState
    if (-not $script:online) { throw "online scenario never came online" }
    if ($null -eq $script:startupProbeProcess) { throw "cameOnline gate did not launch a probe" }
  } else {
    # Stage the exact state the maintenance branch must handle: a probe in flight
    # while the proxy is down.
    Start-StartupHealthProbe
    if ($null -eq $script:startupProbeProcess) { throw "probe did not start" }
  }
  $childPid = $script:startupProbeProcess.Id
  Start-Sleep -Milliseconds 500
  # The timeout branch is only proven while the child is still alive here: an
  # already-exited child would take the exited-probe path and every assertion
  # below would pass without the Kill() ever running.
  if ($script:startupProbeProcess.HasExited) { throw "probe child exited before maintenance; the timeout path was not exercised" }
  $script:startupProbeStarted = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $script:startupProbeTimeoutMs - 5000

  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  Update-TrayState
  $maintenanceMs = $watch.ElapsedMilliseconds
  $onlineObserved = $script:online
  $probeAfterMaintenance = $script:startupProbeProcess
  Update-TrayState
  $watch.Stop()

  # Liveness is evaluated BEFORE the safety cleanup in finally, so the verdict
  # reports what the maintenance branch did, not what the driver cleaned up.
  $childGone = $false
  try {
    $live = Get-Process -Id $childPid -ErrorAction Stop
    $childGone = $live.HasExited
  } catch {
    $childGone = $true
  }

  $pidFile = $env:OCX_PROBE_TEST_PID_FILE
  $launches = 0
  if ($pidFile -and (Test-Path -LiteralPath $pidFile)) {
    $launches = @((Get-Content -LiteralPath $pidFile | Where-Object { $_.Trim() -ne "" })).Count
  }

  $verdict = [PSCustomObject]@{
    scenario = $Scenario
    onlineObserved = [bool]$onlineObserved
    maintenanceMs = $maintenanceMs
    totalMs = $watch.ElapsedMilliseconds
    childPid = $childPid
    childTerminated = [bool]$childGone
    probeCleared = ($null -eq $probeAfterMaintenance) -and ($null -eq $script:startupProbeProcess)
    launches = $launches
  }
  $verdictJson = $verdict | ConvertTo-Json -Compress
  # Set-Content -Encoding UTF8 emits a BOM on Windows PowerShell 5.1; write raw
  # BOM-less UTF-8 the way the tray writes its heartbeat file.
  [System.IO.File]::WriteAllText($ResultPath, $verdictJson, (New-Object System.Text.UTF8Encoding($false)))
} finally {
  # Process.Start returns before the fake CLI writes its pid file, so a throw
  # above (before that write) would leave the outer cleanup with no pid and a
  # 120s sleeper behind. The in-hand pid closes that race.
  if ($childPid -gt 0) {
    try {
      $leftover = Get-Process -Id $childPid -ErrorAction Stop
      if (-not $leftover.HasExited) { Stop-Process -Id $childPid -Force -ErrorAction Stop }
    } catch {
      # Already exited or reaped; the verdict above already recorded the outcome.
      $null = $_
    }
  }
}
