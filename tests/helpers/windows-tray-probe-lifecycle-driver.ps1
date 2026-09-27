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
  [ValidateSet("Offline", "Online", "BadgeOffline", "BadgeOverflowStdout", "BadgeOverflowStderr", "BadgeStaleFailure")][string]$Scenario = "Offline"
)
$ErrorActionPreference = "Stop"

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($TrayScriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "tray script parse failed: $($parseErrors[0].Message)" }
$wanted = @(
  "Write-ActionLog",
  "Get-TrayText",
  "Normalize-HomePath",
  "ConvertTo-NativeArgument",
  "Set-OcxChildEnvironment",
  "Parse-StartupHealthText",
  "Start-StartupHealthProbe",
  "Complete-StartupHealthProbe",
  "Initialize-UpdateBadgeReader",
  "Parse-UpdateBadgeText",
  "Complete-UpdateBadgeProbe",
  "Stop-UpdateBadgeProbe",
  "Start-UpdateBadgeProbe",
  "Maintain-UpdateBadgeProbe",
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

# Badge scenarios assert that the UPDATE-BADGE maintenance never blocks the UI tick. The
# tick also starts with the pre-existing /healthz request (Read-JsonUrl, 700 ms timeout),
# which on an offline Windows runner can spend most of a second on a refused loopback
# connect. That cost predates the badge and is not what these scenarios measure, so they
# answer offline instantly; the Offline/Online scenarios keep the real request.
if ($Scenario.StartsWith("Badge")) {
  function Read-JsonUrl([string]$Url) { throw "offline (badge scenario stub)" }
}

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
$onlineIcon = "online-base"
$warningIcon = "warning-base"
$offlineIcon = "offline-base"
$onlineUpdateIcon = "online-update"
$warningUpdateIcon = "warning-update"
$offlineUpdateIcon = "offline-update"
$updateItem = [PSCustomObject]@{ Visible = $false; Enabled = $false }

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
$script:updateAvailable = $false
$script:updateBadgeObservedAt = 0L
$script:updateBadgeAttemptAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$script:updateBadgeRefreshMs = 60000L
$script:updateBadgeExpiryMs = 180000L
$script:updateBadgeTimeoutMs = 12000L
$script:updateBadgeMaxBytesPerStream = 16384
$script:updateBadgeProcess = $null
$script:updateBadgeOutputTask = $null
$script:updateBadgeErrorTask = $null
$script:updateBadgeStarted = 0L
$script:updateBadgeTerminating = $false
$script:pendingAction = $null
$script:pendingStarted = 0
$script:pendingDeadline = 0
$script:pendingOldProxyPid = $null
$script:pendingProcess = $null

$childPid = 0
if ($Scenario -eq "BadgeStaleFailure") {
  $script:updateAvailable = $true
  $script:updateBadgeObservedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $script:updateBadgeExpiryMs - 1000L
  $notify.Icon = $offlineUpdateIcon
  $updateItem.Visible = $true
  $updateItem.Enabled = $true
  if ($notify.Icon -ne "offline-update" -or -not $updateItem.Visible -or -not $updateItem.Enabled) {
    throw "stale case did not start from a dotted icon and available menu"
  }
}
try {
  $badgeCase = $Scenario.StartsWith("Badge")
  if ($badgeCase) {
    $script:updateBadgeAttemptAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Start-UpdateBadgeProbe
    if ($null -eq $script:updateBadgeProcess) { throw "badge probe did not start" }
  } elseif ($Scenario -eq "Online") {
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
  $probe = if ($badgeCase) { $script:updateBadgeProcess } else { $script:startupProbeProcess }
  $childPid = $probe.Id
  $iconBeforeMaintenance = $notify.Icon
  $updateAvailableBeforeMaintenance = $script:updateAvailable
  $observedAtBeforeMaintenance = $script:updateBadgeObservedAt
  $failedProbeExitCode = $null
  if ($Scenario -eq "BadgeStaleFailure") {
    $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 5000
    while ((-not $probe.HasExited -or -not $script:updateBadgeOutputTask.IsCompleted -or
            -not $script:updateBadgeErrorTask.IsCompleted) -and
           [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline) {
      Start-Sleep -Milliseconds 20
    }
    if (-not $probe.HasExited -or -not $script:updateBadgeOutputTask.IsCompleted -or
        -not $script:updateBadgeErrorTask.IsCompleted) { throw "failed badge probe did not settle" }
    $failedProbeExitCode = $probe.ExitCode
    if ($failedProbeExitCode -ne 1) { throw "stale badge probe did not fail with exit 1" }
  } elseif ($Scenario -like "BadgeOverflow*") {
    $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 5000
    $task = if ($Scenario -eq "BadgeOverflowStdout") { $script:updateBadgeOutputTask } else { $script:updateBadgeErrorTask }
    while (-not $task.IsFaulted -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline) {
      Start-Sleep -Milliseconds 20
    }
    if (-not $task.IsFaulted) { throw "badge overflow reader did not enforce the byte cap" }
  } else {
    Start-Sleep -Milliseconds 500
  }
  if ($Scenario -ne "BadgeStaleFailure" -and $probe.HasExited) { throw "probe child exited before maintenance" }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($Scenario -eq "BadgeOffline") {
    $script:updateBadgeStarted = $now - $script:updateBadgeTimeoutMs - 5000
  } elseif (-not $badgeCase) {
    $script:startupProbeStarted = $now - $script:startupProbeTimeoutMs - 5000
  }
  $observedAgeMsAtMaintenance = $now - $observedAtBeforeMaintenance

  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  Update-TrayState
  $maintenanceMs = $watch.ElapsedMilliseconds
  $onlineObserved = $script:online
  $iconAfterMaintenance = $notify.Icon
  $updateAvailableAfterMaintenance = $script:updateAvailable
  $observedAtAfterMaintenance = $script:updateBadgeObservedAt
  $updateItemVisibleAfterMaintenance = $updateItem.Visible
  $updateItemEnabledAfterMaintenance = $updateItem.Enabled
  $terminatingAfterMaintenance = if ($badgeCase) { $script:updateBadgeTerminating } else { $false }
  $trackedAfterMaintenance = if ($badgeCase) { $null -ne $script:updateBadgeProcess } else { $false }
  $maxTickMs = $maintenanceMs
  $reapDeadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 2000
  do {
    Start-Sleep -Milliseconds 20
    $tick = [System.Diagnostics.Stopwatch]::StartNew()
    Update-TrayState
    $tick.Stop()
    if ($tick.ElapsedMilliseconds -gt $maxTickMs) { $maxTickMs = $tick.ElapsedMilliseconds }
    $cleared = if ($badgeCase) { $null -eq $script:updateBadgeProcess } else { $null -eq $script:startupProbeProcess }
  } until ($cleared -or [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $reapDeadline)
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
    probeCleared = [bool]$cleared
    launches = $launches
    terminatingAfterMaintenance = [bool]$terminatingAfterMaintenance
    trackedAfterMaintenance = [bool]$trackedAfterMaintenance
    maxTickMs = $maxTickMs
    failedProbeExitCode = $failedProbeExitCode
    iconBeforeMaintenance = $iconBeforeMaintenance
    updateAvailableBeforeMaintenance = [bool]$updateAvailableBeforeMaintenance
    iconAfterMaintenance = $iconAfterMaintenance
    updateAvailableAfterMaintenance = [bool]$updateAvailableAfterMaintenance
    observedAtBeforeMaintenance = $observedAtBeforeMaintenance
    observedAgeMsAtMaintenance = $observedAgeMsAtMaintenance
    observedAtAfterMaintenance = $observedAtAfterMaintenance
    updateItemVisibleAfterMaintenance = [bool]$updateItemVisibleAfterMaintenance
    updateItemEnabledAfterMaintenance = [bool]$updateItemEnabledAfterMaintenance
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
