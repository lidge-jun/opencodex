param(
  [Parameter(Mandatory = $true)][string]$BunPath,
  [Parameter(Mandatory = $true)][string]$CliPath,
  [Parameter(Mandatory = $true)][string]$CodexHome,
  [Parameter(Mandatory = $true)][string]$OpenCodexHome,
  # Provenance of $BunPath, chosen when the tray entry was built. Optional so an
  # already-installed launcher command from an older version still starts.
  [ValidateSet("", "override", "bundled", "process")][string]$BunRuntimeSource = "",
  [ValidateSet("Run", "Stop")][string]$Mode = "Run",
  [int]$HostPid = 0
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Normalize aliases before deriving singleton/event names. Without this,
# C:\path and C:\path\. create separate tray instances for the same home.
function Normalize-HomePath([string]$Value) {
  $full = [System.IO.Path]::GetFullPath($Value)
  $root = [System.IO.Path]::GetPathRoot($full)
  if ($full -eq $root) { return $full }
  return $full.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}
$OpenCodexHome = Normalize-HomePath $OpenCodexHome
$CodexHome = Normalize-HomePath $CodexHome

$script:ownedIcons = New-Object System.Collections.Generic.List[System.Drawing.Icon]
function Load-TrayIcon([string]$Name, [System.Drawing.Icon]$Fallback) {
  $path = Join-Path $OpenCodexHome $Name
  if (-not [System.IO.File]::Exists($path)) { return $Fallback }
  try {
    $icon = New-Object System.Drawing.Icon($path)
    [void]$script:ownedIcons.Add($icon)
    return $icon
  } catch {
    return $Fallback
  }
}
$onlineIcon = Load-TrayIcon "opencodex-tray-online.ico" ([System.Drawing.SystemIcons]::Information)
$warningIcon = Load-TrayIcon "opencodex-tray-warning.ico" ([System.Drawing.SystemIcons]::Warning)
$offlineIcon = Load-TrayIcon "opencodex-tray-offline.ico" ([System.Drawing.SystemIcons]::Error)

function Get-StableHash([string]$Value) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value.ToLowerInvariant())
    $hash = [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace("-", "").Substring(0, 20)
    return $hash
  } finally {
    $sha.Dispose()
  }
}

$stableHash = Get-StableHash $OpenCodexHome
$stopEventCreated = $false
$stopEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, "Local\OpenCodexTrayStop-$stableHash", [ref]$stopEventCreated)
if ($Mode -eq "Stop") {
  [void]$stopEvent.Set()
  $stopEvent.Dispose()
  exit 0
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\OpenCodexTray-$stableHash", [ref]$createdNew)
if (-not $createdNew) {
  $stopEvent.Dispose()
  $mutex.Dispose()
  exit 0
}

$heartbeatPath = Join-Path $OpenCodexHome "tray-heartbeat.json"
$actionLogPath = Join-Path $OpenCodexHome "tray-actions.log"

function Write-ActionLog([string]$Message) {
  $line = "[$([DateTimeOffset]::Now.ToString('o'))] $Message"
  [System.IO.File]::AppendAllText($actionLogPath, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
}

function ConvertTo-NativeArgument([string]$Value) {
  if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) {
    throw "Invalid native command argument"
  }
  return '"' + $Value + '"'
}

function Start-OcxCommand([string[]]$CommandArgs, [switch]$TrackExit) {
  try {
    $allArgs = @($CliPath) + $CommandArgs
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $BunPath
    $psi.Arguments = (($allArgs | ForEach-Object { ConvertTo-NativeArgument $_ }) -join " ")
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $psi.EnvironmentVariables["CODEX_HOME"] = $CodexHome
    $psi.EnvironmentVariables["OPENCODEX_HOME"] = $OpenCodexHome
    if ($BunRuntimeSource) {
      $psi.EnvironmentVariables["OCX_BUN_RUNTIME_SOURCE"] = $BunRuntimeSource
      # Paired with the source so a later relaunch can tell the marker still describes
      # this binary rather than one it merely inherited.
      $psi.EnvironmentVariables["OCX_BUN_RUNTIME_PATH"] = $BunPath
    }
    $process = [System.Diagnostics.Process]::Start($psi)
    if ($null -eq $process) { throw "Process did not start" }
    Write-ActionLog "dispatched $($CommandArgs -join ' ')"
    if ($TrackExit) { return $process }
    $process.Dispose()
    return $true
  } catch {
    Write-ActionLog "launch failed: $($_.Exception.GetType().Name)"
    $notify.ShowBalloonTip(5000, "opencodex action failed", "The action could not start. Open the logs folder or run ocx doctor.", [System.Windows.Forms.ToolTipIcon]::Error)
    return $false
  }
}

function Read-ListenTarget {
  foreach ($path in @((Join-Path $OpenCodexHome "runtime-port.json"), (Join-Path $OpenCodexHome "config.json"))) {
    try {
      $value = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
      $candidate = [int]$value.port
      if ($candidate -gt 0 -and $candidate -le 65535) {
        $candidateHost = [string]$value.hostname
        $ip = $null
        $hostName = if ([string]::IsNullOrWhiteSpace($candidateHost) -or $candidateHost -in @("localhost", "0.0.0.0", "::", "[::]")) {
          "127.0.0.1"
        } elseif ([System.Net.IPAddress]::TryParse($candidateHost.Trim("[", "]"), [ref]$ip)) {
          if ($ip.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) { "[$($ip.ToString())]" } else { $ip.ToString() }
        } else {
          "127.0.0.1"
        }
        return @{ port = $candidate; host = $hostName; pid = $value.pid }
      }
    } catch { }
  }
  return @{ port = 10100; host = "127.0.0.1"; pid = $null }
}

function Read-JsonUrl([string]$Url) {
  $request = [System.Net.HttpWebRequest]::Create($Url)
  $request.Method = "GET"
  $request.Timeout = 700
  $request.ReadWriteTimeout = 700
  $response = $request.GetResponse()
  try {
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
  } finally {
    $response.Dispose()
  }
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Enabled = $false
$safetyItem = New-Object System.Windows.Forms.ToolStripMenuItem
$safetyItem.Enabled = $false
$openItem = $menu.Items.Add("Open Dashboard")
$startItem = $menu.Items.Add("Start Proxy")
$stopItem = $menu.Items.Add("Stop Proxy and Restore Native Routing")
$restartItem = $menu.Items.Add("Restart Proxy")
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($statusItem)
[void]$menu.Items.Add($safetyItem)
$logsItem = $menu.Items.Add("Open Logs Folder")
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$exitItem = $menu.Items.Add("Exit Tray")

$script:online = $false
$script:port = 10100
$script:proxyPid = $null
$script:pendingAction = $null
$script:pendingStarted = 0L
$script:pendingDeadline = 0L
$script:pendingOldProxyPid = $null
$script:pendingProcess = $null

function Set-PendingAction([string]$Action, [int]$TimeoutSeconds) {
  if ($null -ne $script:pendingAction) {
    Write-ActionLog "$Action ignored because $($script:pendingAction) is still pending"
    return $false
  }
  if ($null -ne $script:pendingProcess) {
    try {
      $script:pendingProcess.Dispose()
    } catch {
      Write-ActionLog "pending process dispose failed: $($_.Exception.GetType().Name)"
    }
    $script:pendingProcess = $null
  }
  $script:pendingAction = $Action
  $script:pendingStarted = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $script:pendingDeadline = $script:pendingStarted + ($TimeoutSeconds * 1000)
  $script:pendingOldProxyPid = $script:proxyPid
  return $true
}

function Complete-PendingAction([bool]$Success) {
  if ($null -eq $script:pendingAction) { return }
  $action = $script:pendingAction
  $script:pendingAction = $null
  if ($null -ne $script:pendingProcess) {
    try {
      $script:pendingProcess.Dispose()
    } catch {
      Write-ActionLog "pending process dispose failed: $($_.Exception.GetType().Name)"
    }
    $script:pendingProcess = $null
  }
  if ($Success) {
    Write-ActionLog "$action completed (port=$($script:port), pid=$($script:proxyPid))"
    $notify.ShowBalloonTip(2500, "opencodex", "$action completed.", [System.Windows.Forms.ToolTipIcon]::Info)
  } else {
    Write-ActionLog "$action failed to reach the expected state"
    $notify.ShowBalloonTip(5000, "opencodex action failed", "$action did not reach the expected state. Open the logs folder or run ocx doctor.", [System.Windows.Forms.ToolTipIcon]::Error)
  }
}

function Update-TrayState {
  $target = Read-ListenTarget
  $script:port = [int]$target.port
  $health = $null
  $origin = "http://$($target.host):$($script:port)"
  try { $health = Read-JsonUrl "$origin/healthz" } catch { }
  $pidMatches = $null -eq $target.pid -or [int]$target.pid -eq [int]$health.pid
  $script:online = $null -ne $health -and $health.status -eq "ok" -and $health.service -eq "opencodex" -and [int]$health.port -eq $script:port -and $pidMatches
  $script:proxyPid = if ($script:online) { [int]$health.pid } else { $null }
  if ($script:online) {
    $statusItem.Text = "Proxy: Online (port $($script:port))"
    $notify.Text = "opencodex: Online"
    $startItem.Enabled = $false
    $stopItem.Enabled = $true
    $restartItem.Enabled = $true
    try {
      $startup = Read-JsonUrl "$origin/api/startup-health"
      $label = if ($startup.status -eq "at-risk") { "At risk" } elseif ($startup.status -eq "protected") { "Protected" } else { "Native routing" }
      $safetyItem.Text = "Restart safety: $label"
      $notify.Icon = if ($startup.status -eq "at-risk") { $warningIcon } else { $onlineIcon }
    } catch {
      $safetyItem.Text = "Restart safety: unavailable"
      $notify.Icon = $warningIcon
    }
  } else {
    $statusItem.Text = "Proxy: Offline"
    $safetyItem.Text = "Restart safety: start the proxy to inspect"
    $notify.Text = "opencodex: Offline"
    $notify.Icon = $offlineIcon
    $startItem.Enabled = $true
    $stopItem.Enabled = $false
    $restartItem.Enabled = $false
  }
  if ($null -ne $script:pendingAction) {
    $startItem.Enabled = $false
    $stopItem.Enabled = $false
    $restartItem.Enabled = $false
  }
  $heartbeat = @{ pid = $PID; timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  if ($HostPid -gt 0) { $heartbeat.hostPid = $HostPid }
  $heartbeatJson = $heartbeat | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($heartbeatPath, $heartbeatJson, (New-Object System.Text.UTF8Encoding($false)))

  if ($null -ne $script:pendingAction) {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $elapsed = $now - $script:pendingStarted
    $reached = ($script:pendingAction -eq "Start Proxy" -and $script:online) -or
      ($script:pendingAction -eq "Stop Proxy" -and -not $script:online) -or
      ($script:pendingAction -eq "Restart Proxy" -and $elapsed -gt 3000 -and $script:online -and $script:proxyPid -ne $script:pendingOldProxyPid)
    $commandFailed = $false
    if ($null -ne $script:pendingProcess) {
      try {
        $commandFailed = $script:pendingProcess.HasExited -and $script:pendingProcess.ExitCode -ne 0
      } catch {
        Write-ActionLog "pending process result inspection failed: $($_.Exception.GetType().Name)"
        # If we cannot inspect the tracked command, we cannot prove it is still
        # healthy. Fail the pending action instead of silently waiting for a later
        # timeout and presenting an indeterminate process as success-capable.
        $commandFailed = $true
      }
    }
    if ($commandFailed) { Complete-PendingAction $false }
    elseif ($reached) { Complete-PendingAction $true }
    elseif ($now -gt $script:pendingDeadline) { Complete-PendingAction $false }
  }
}

$openItem.add_Click({ Start-OcxCommand @("gui") })
$startItem.add_Click({
  if (-not (Set-PendingAction "Start Proxy" 75)) { return }
  $statusItem.Text = "Proxy: Starting..."
  # service start can spend 20s and the CLI then observes health for another 40s.
  $startProcess = Start-OcxCommand @("__tray-start") -TrackExit
  if ($startProcess -is [System.Diagnostics.Process]) {
    $script:pendingProcess = $startProcess
  } else {
    Complete-PendingAction $false
  }
})
$stopItem.add_Click({
  if (-not (Set-PendingAction "Stop Proxy" 15)) { return }
  $statusItem.Text = "Proxy: Stopping..."
  $stopProcess = Start-OcxCommand @("stop") -TrackExit
  if ($stopProcess -is [System.Diagnostics.Process]) {
    $script:pendingProcess = $stopProcess
  } else {
    Complete-PendingAction $false
  }
})
$restartItem.add_Click({
  if (-not (Set-PendingAction "Restart Proxy" 160)) { return }
  $statusItem.Text = "Proxy: Restarting..."
  # /api/system/restart may drain active work for 60s and then spend up to 70s
  # handing off to an identity-verified replacement. The tray observes health/PID
  # rather than the detached CLI exit, so keep a watchdog margin around that shared
  # lifecycle budget. The CLI remains the lifecycle owner; the tray never kills.
  $restartProcess = Start-OcxCommand @("__tray-restart") -TrackExit
  if ($restartProcess -is [System.Diagnostics.Process]) {
    $script:pendingProcess = $restartProcess
  } else {
    Complete-PendingAction $false
  }
})
$logsItem.add_Click({
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $OpenCodexHome
  $psi.UseShellExecute = $true
  [void][System.Diagnostics.Process]::Start($psi)
})
$exitItem.add_Click({ [System.Windows.Forms.Application]::Exit() })
$notify.add_DoubleClick({ Start-OcxCommand @("gui") })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
  if ($stopEvent.WaitOne(0)) {
    [System.Windows.Forms.Application]::Exit()
    return
  }
  Update-TrayState
})
$notify.ContextMenuStrip = $menu
$notify.Icon = $offlineIcon
$notify.Visible = $true
$notify.Text = "opencodex: Checking..."

try {
  Update-TrayState
  $timer.Start()
  [System.Windows.Forms.Application]::Run()
} finally {
  $timer.Stop()
  $timer.Dispose()
  $notify.Visible = $false
  if ($null -ne $script:pendingProcess) {
    try { $script:pendingProcess.Dispose() } catch { $null = $_ }
  }
  $notify.Dispose()
  foreach ($icon in $script:ownedIcons) { $icon.Dispose() }
  $menu.Dispose()
  try { Remove-Item -LiteralPath $heartbeatPath -Force -ErrorAction SilentlyContinue } catch { }
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
  $stopEvent.Dispose()
}
