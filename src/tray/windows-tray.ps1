param(
  [Parameter(Mandatory = $true)][string]$BunPath,
  [Parameter(Mandatory = $true)][string]$CliPath,
  [Parameter(Mandatory = $true)][string]$CodexHome,
  [Parameter(Mandatory = $true)][string]$OpenCodexHome,
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

function Start-OcxCommand([string[]]$CommandArgs) {
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
    $process = [System.Diagnostics.Process]::Start($psi)
    if ($null -ne $process) { $process.Dispose() }
    Write-ActionLog "dispatched $($CommandArgs -join ' ')"
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

function Set-PendingAction([string]$Action, [int]$TimeoutSeconds) {
  $script:pendingAction = $Action
  $script:pendingStarted = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $script:pendingDeadline = $script:pendingStarted + ($TimeoutSeconds * 1000)
  $script:pendingOldProxyPid = $script:proxyPid
}

function Complete-PendingAction([bool]$Success) {
  if ($null -eq $script:pendingAction) { return }
  $action = $script:pendingAction
  $script:pendingAction = $null
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
      $notify.Icon = if ($startup.status -eq "at-risk") { [System.Drawing.SystemIcons]::Warning } else { [System.Drawing.SystemIcons]::Information }
    } catch {
      $safetyItem.Text = "Restart safety: unavailable"
      $notify.Icon = [System.Drawing.SystemIcons]::Information
    }
  } else {
    $statusItem.Text = "Proxy: Offline"
    $safetyItem.Text = "Restart safety: start the proxy to inspect"
    $notify.Text = "opencodex: Offline"
    $notify.Icon = [System.Drawing.SystemIcons]::Error
    $startItem.Enabled = $true
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
    if ($reached) { Complete-PendingAction $true }
    elseif ($now -gt $script:pendingDeadline) { Complete-PendingAction $false }
  }
}

$openItem.add_Click({ Start-OcxCommand @("gui") })
$startItem.add_Click({
  $statusItem.Text = "Proxy: Starting..."
  Set-PendingAction "Start Proxy" 15
  if (-not (Start-OcxCommand @("__tray-start"))) { $script:pendingAction = $null }
})
$stopItem.add_Click({
  $statusItem.Text = "Proxy: Stopping..."
  Set-PendingAction "Stop Proxy" 15
  if (-not (Start-OcxCommand @("stop"))) { $script:pendingAction = $null }
})
$restartItem.add_Click({
  $statusItem.Text = "Proxy: Restarting..."
  Set-PendingAction "Restart Proxy" 20
  if (-not (Start-OcxCommand @("__tray-restart"))) { $script:pendingAction = $null }
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
  $notify.Dispose()
  $menu.Dispose()
  try { Remove-Item -LiteralPath $heartbeatPath -Force -ErrorAction SilentlyContinue } catch { }
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
  $stopEvent.Dispose()
}
