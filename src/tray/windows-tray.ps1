param(
  [Parameter(Mandatory = $true)][string]$BunPath,
  [Parameter(Mandatory = $true)][string]$CliPath,
  [Parameter(Mandatory = $true)][string]$CodexHome,
  [Parameter(Mandatory = $true)][string]$OpenCodexHome,
  # Provenance of $BunPath, chosen when the tray entry was built. Optional so an
  # already-installed launcher command from an older version still starts.
  [ValidateSet("", "override", "bundled", "process", "standalone")][string]$BunRuntimeSource = "",
  [ValidateSet("Run", "Stop")][string]$Mode = "Run",
  [int]$HostPid = 0
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try { [System.Windows.Forms.Application]::EnableVisualStyles() } catch { $null = $_ }

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
$onlineUpdateIcon = Load-TrayIcon "opencodex-tray-online-update.ico" $onlineIcon
$warningUpdateIcon = Load-TrayIcon "opencodex-tray-warning-update.ico" $warningIcon
$offlineUpdateIcon = Load-TrayIcon "opencodex-tray-offline-update.ico" $offlineIcon

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
[void]$stopEvent.Reset()

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

function Parse-StartupHealthText([string]$Text) {
  foreach ($line in ($Text -split "\r?\n")) {
    $trimmed = $line.Trim()
    if (-not $trimmed) { continue }
    try {
      $parsed = $trimmed | ConvertFrom-Json
      if ($parsed.status -in @("native", "protected", "at-risk") -and ($parsed.rebootSafe -is [bool])) {
        return $parsed
      }
    } catch {
      # A non-JSON line from the CLI (for example a diagnostic banner) is not a
      # startup-health payload; keep scanning for the actual JSON result.
      continue
    }
  }
  return $null
}

function Start-StartupHealthProbe {
  # Startup safety is machine-local diagnostic state, so the tray asks the CLI to
  # collect it directly (ocx __startup-health) instead of poking the management API,
  # which is admin-token gated. The CLI collects the diagnostic straight from the OS,
  # so it works without the proxy answering and without any credential.
  #
  # The child writes into redirected pipes that the tick reads asynchronously: only
  # the completed Task<string> is ever touched, so a slow or hung diagnostic can never
  # block the Windows Forms UI thread, and its lifetime is bounded by a kill in the
  # tick that lets the next refresh replace it instead of stacking another process.
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $BunPath
    $psi.Arguments = ((@($CliPath, "__startup-health") | ForEach-Object { ConvertTo-NativeArgument $_ }) -join " ")
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $psi.EnvironmentVariables["CODEX_HOME"] = $CodexHome
    $psi.EnvironmentVariables["OPENCODEX_HOME"] = $OpenCodexHome
    if ($BunRuntimeSource) {
      $psi.EnvironmentVariables["OCX_BUN_RUNTIME_SOURCE"] = $BunRuntimeSource
      $psi.EnvironmentVariables["OCX_BUN_RUNTIME_PATH"] = $BunPath
    }
    $process = [System.Diagnostics.Process]::Start($psi)
    $script:startupProbeProcess = $process
    # Drain both pipes asynchronously from the start so neither can fill and stall
    # the child while the tick is only watching the output task's completion.
    $script:startupProbeOutputTask = $process.StandardOutput.ReadToEndAsync()
    $script:startupProbeErrorTask = $process.StandardError.ReadToEndAsync()
    $script:startupProbeStarted = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  } catch {
    Write-ActionLog "startup-health probe launch failed: $($_.Exception.GetType().Name)"
    if ($null -ne $script:startupProbeProcess) {
      # Process.Start succeeded but the async pipe setup failed: Dispose alone
      # would leave the Bun child running, so terminate it before cleanup.
      try {
        $script:startupProbeProcess.Kill()
        [void]$script:startupProbeProcess.WaitForExit(3000)
      } catch {
        Write-ActionLog "startup-health probe launch cleanup failed: $($_.Exception.GetType().Name)"
      }
    }
    Complete-StartupHealthProbe
  }
}

function Complete-StartupHealthProbe {
  $process = $script:startupProbeProcess
  $script:startupProbeProcess = $null
  $script:startupProbeOutputTask = $null
  $script:startupProbeErrorTask = $null
  if ($null -ne $process) {
    try {
      $process.Dispose()
    } catch {
      Write-ActionLog "startup-health probe dispose failed: $($_.Exception.GetType().Name)"
    }
  }
}

function Initialize-UpdateBadgeReader {
  if (([System.Management.Automation.PSTypeName]"TrayUpdateBadgeReader").Type) { return }
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
public static class TrayUpdateBadgeReader {
  public static async Task<string> ReadAsync(Stream input, int maxBytes) {
    byte[] chunk = new byte[4096];
    using (var content = new MemoryStream()) {
      while (true) {
        int count = await input.ReadAsync(chunk, 0, chunk.Length).ConfigureAwait(false);
        if (count == 0) break;
        if (content.Length + count > maxBytes) throw new InvalidDataException("badge pipe byte cap exceeded");
        content.Write(chunk, 0, count);
      }
      return new UTF8Encoding(false, true).GetString(content.ToArray());
    }
  }
}
'@
}

function Parse-UpdateBadgeText([string]$Text) {
  $lines = @($Text -split "\r?\n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($lines.Count -ne 1) { return $null }
  try {
    $badge = $lines[0] | ConvertFrom-Json
    if (($badge.updateAvailable -isnot [bool]) -or ($badge.unknown -isnot [bool]) -or
        ($badge.canUpdate -isnot [bool])) { return $null }
    return [bool]($badge.updateAvailable -and -not $badge.unknown -and $badge.canUpdate)
  } catch { return $null }
}

function Complete-UpdateBadgeProbe {
  $process = $script:updateBadgeProcess
  $script:updateBadgeProcess = $null
  $script:updateBadgeOutputTask = $null
  $script:updateBadgeErrorTask = $null
  $script:updateBadgeTerminating = $false
  if ($null -ne $process) {
    try {
      $process.StandardOutput.Dispose()
      $process.StandardError.Dispose()
      $process.Dispose()
    } catch { Write-ActionLog "update badge probe dispose failed: $($_.Exception.GetType().Name)" }
  }
}

function Stop-UpdateBadgeProbe([switch]$Shutdown) {
  if ($null -eq $script:updateBadgeProcess) { return }
  $script:updateBadgeTerminating = $true
  try {
    if (-not $script:updateBadgeProcess.HasExited) { $script:updateBadgeProcess.Kill() }
  } catch { Write-ActionLog "update badge probe termination failed: $($_.Exception.GetType().Name)" }
  if ($Shutdown) {
    # Only shutdown may wait, and it is bounded; the UI tick never calls this branch.
    try { [void]$script:updateBadgeProcess.WaitForExit(500) } catch { $null = $_ }
    Complete-UpdateBadgeProbe
  }
}

function Start-UpdateBadgeProbe {
  try {
    Initialize-UpdateBadgeReader
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $BunPath
    $psi.Arguments = ((@($CliPath, "__update-badge") | ForEach-Object { ConvertTo-NativeArgument $_ }) -join " ")
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $psi.EnvironmentVariables["CODEX_HOME"] = $CodexHome
    $psi.EnvironmentVariables["OPENCODEX_HOME"] = $OpenCodexHome
    if ($BunRuntimeSource) {
      $psi.EnvironmentVariables["OCX_BUN_RUNTIME_SOURCE"] = $BunRuntimeSource
      $psi.EnvironmentVariables["OCX_BUN_RUNTIME_PATH"] = $BunPath
    }
    $script:updateBadgeProcess = [System.Diagnostics.Process]::Start($psi)
    if ($null -eq $script:updateBadgeProcess) { throw "Process did not start" }
    $script:updateBadgeOutputTask = [TrayUpdateBadgeReader]::ReadAsync($script:updateBadgeProcess.StandardOutput.BaseStream, $script:updateBadgeMaxBytesPerStream)
    $script:updateBadgeErrorTask = [TrayUpdateBadgeReader]::ReadAsync($script:updateBadgeProcess.StandardError.BaseStream, $script:updateBadgeMaxBytesPerStream)
    $script:updateBadgeStarted = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  } catch {
    Write-ActionLog "update badge probe launch failed: $($_.Exception.GetType().Name)"
    if ($null -ne $script:updateBadgeProcess) { Stop-UpdateBadgeProbe }
  }
}

function Maintain-UpdateBadgeProbe([long]$Now) {
  if ($null -ne $script:updateBadgeProcess) {
    $terminatingAtStart = $script:updateBadgeTerminating
    $expired = ($Now - $script:updateBadgeStarted) -gt $script:updateBadgeTimeoutMs
    $exited = $false
    try { $exited = $script:updateBadgeProcess.HasExited } catch { Stop-UpdateBadgeProbe }
    $drained = ($null -eq $script:updateBadgeOutputTask -or $script:updateBadgeOutputTask.IsCompleted) -and
      ($null -eq $script:updateBadgeErrorTask -or $script:updateBadgeErrorTask.IsCompleted)
    $failedRead = ($null -ne $script:updateBadgeOutputTask -and
      ($script:updateBadgeOutputTask.IsFaulted -or $script:updateBadgeOutputTask.IsCanceled)) -or
      ($null -ne $script:updateBadgeErrorTask -and
      ($script:updateBadgeErrorTask.IsFaulted -or $script:updateBadgeErrorTask.IsCanceled))
    if ($failedRead -and -not $script:updateBadgeTerminating) {
      Write-ActionLog "update badge probe pipe read failed or exceeded byte cap"
      Stop-UpdateBadgeProbe
    }
    if ($script:updateBadgeTerminating) {
      # Reap on a later tick after both bounded readers settle; no replacement starts meanwhile.
      if ($terminatingAtStart -and -not $exited) { Stop-UpdateBadgeProbe }
      if ($terminatingAtStart -and $exited -and $drained) { Complete-UpdateBadgeProbe }
    } elseif ($exited -and $drained -and $null -ne $script:updateBadgeOutputTask -and
        $null -ne $script:updateBadgeErrorTask) {
      $answer = $null
      try {
        if ($script:updateBadgeProcess.ExitCode -eq 0) {
          $answer = Parse-UpdateBadgeText $script:updateBadgeOutputTask.Result
        }
      } catch { Write-ActionLog "update badge probe read failed: $($_.Exception.GetType().Name)" }
      if ($null -ne $answer) {
        $script:updateAvailable = [bool]$answer
        $script:updateBadgeObservedAt = $Now
      }
      Complete-UpdateBadgeProbe
    } elseif ($expired) {
      Write-ActionLog "update badge probe timed out"
      Stop-UpdateBadgeProbe
    }
  }
  if ($script:updateBadgeObservedAt -eq 0 -or
      ($Now - $script:updateBadgeObservedAt) -gt $script:updateBadgeExpiryMs) {
    $script:updateAvailable = $false
  }
  if ($null -eq $script:updateBadgeProcess -and -not $script:updateBadgeTerminating -and
      ($script:updateBadgeAttemptAt -eq 0 -or ($Now - $script:updateBadgeAttemptAt) -ge $script:updateBadgeRefreshMs)) {
    $script:updateBadgeAttemptAt = $Now
    Start-UpdateBadgeProbe
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
$updateItem = $menu.Items.Add("Update available")
$updateItem.Visible = $false
$updateItem.Enabled = $false
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
$script:wasOnline = $false
$script:startupHealth = $null
$script:startupHealthCheckedAt = 0L
$script:startupRefreshMs = 20000L
$script:startupProbeProcess = $null
$script:startupProbeOutputTask = $null
$script:startupProbeErrorTask = $null
$script:startupProbeStarted = 0L
$script:startupProbeTimeoutMs = 30000L
$script:updateAvailable = $false
$script:updateBadgeObservedAt = 0L
$script:updateBadgeAttemptAt = 0L
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
  $cameOnline = $script:online -and -not $script:wasOnline
  $script:wasOnline = $script:online
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Maintain-UpdateBadgeProbe $now
  if ($null -ne $script:startupProbeProcess) {
    $probeExited = $false
    try {
      $probeExited = $script:startupProbeProcess.HasExited
    } catch {
      $probeExited = $true
    }
    $probeTimedOut = ($now - $script:startupProbeStarted) -gt $script:startupProbeTimeoutMs
    if ($probeExited -and $null -ne $script:startupProbeOutputTask -and $script:startupProbeOutputTask.IsCompleted) {
      $probeStartup = $null
      try {
        $probeStartup = Parse-StartupHealthText $script:startupProbeOutputTask.Result
      } catch {
        Write-ActionLog "startup-health probe read failed: $($_.Exception.GetType().Name)"
      }
      $script:startupHealth = $probeStartup
      Complete-StartupHealthProbe
      $script:startupHealthCheckedAt = $now
    } elseif ($probeTimedOut) {
      # A hung diagnostic must not survive its refresh slot: terminate it so the
      # next refresh cannot stack another orphaned Bun process behind it.
      Write-ActionLog "startup-health probe timed out; terminating it"
      try {
        $script:startupProbeProcess.Kill()
        [void]$script:startupProbeProcess.WaitForExit(3000)
      } catch {
        Write-ActionLog "startup-health probe kill failed: $($_.Exception.GetType().Name)"
      }
      $script:startupHealth = $null
      Complete-StartupHealthProbe
      $script:startupHealthCheckedAt = $now
    }
  }
  $refreshDue =
    $script:startupHealthCheckedAt -eq 0 -or
    ($now - $script:startupHealthCheckedAt -gt $script:startupRefreshMs)
  if ($script:online -and ($cameOnline -or $refreshDue) -and $null -eq $script:startupProbeProcess) {
    # Record the attempt so launch failures and invalid results remain throttled.
    $script:startupHealthCheckedAt = $now
    Start-StartupHealthProbe
  }
  if ($script:online) {
    $statusItem.Text = "Proxy: Online (port $($script:port))"
    $notify.Text = "opencodex: Online"
    $startItem.Enabled = $false
    $stopItem.Enabled = $true
    $restartItem.Enabled = $true
    # The management API is admin-token gated, so the tray must not poke
    # /api/startup-health for the icon. The probe lifecycle maintenance and the
    # refresh gate above run on every tick (even while offline) so a hung
    # diagnostic is cleaned up outside the online-only UI branch.
    $startup = $script:startupHealth
    if ($null -ne $startup) {
      $label = if ($startup.status -eq "at-risk") { "At risk" } elseif ($startup.status -eq "protected") { "Protected" } else { "Native routing" }
      $safetyItem.Text = "Restart safety: $label"
      $notify.Icon = if ($startup.status -eq "at-risk") {
        if ($script:updateAvailable) { $warningUpdateIcon } else { $warningIcon }
      } else {
        if ($script:updateAvailable) { $onlineUpdateIcon } else { $onlineIcon }
      }
    } else {
      $safetyItem.Text = "Restart safety: unavailable"
      $notify.Icon = if ($script:updateAvailable) { $warningUpdateIcon } else { $warningIcon }
    }
  } else {
    $statusItem.Text = "Proxy: Offline"
    $safetyItem.Text = "Restart safety: start the proxy to inspect"
    $notify.Text = "opencodex: Offline"
    $notify.Icon = if ($script:updateAvailable) { $offlineUpdateIcon } else { $offlineIcon }
    $startItem.Enabled = $true
    $stopItem.Enabled = $false
    $restartItem.Enabled = $false
  }
  $updateItem.Visible = $script:updateAvailable
  $updateItem.Enabled = $script:updateAvailable
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
$updateItem.add_Click({ Start-OcxCommand @("gui") })
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
  try {
    if ($stopEvent.WaitOne(0)) {
      [System.Windows.Forms.Application]::Exit()
      return
    }
    Update-TrayState
  } catch {
    try { Write-ActionLog "timer tick failed: $($_.Exception.GetType().Name)" } catch { $null = $_ }
  }
})
$notify.ContextMenuStrip = $menu
$notify.Icon = $offlineIcon
$notify.Visible = $true
$notify.Text = "opencodex: Checking..."

try {
  Initialize-UpdateBadgeReader
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
  if ($null -ne $script:startupProbeProcess) {
    # A probe still running when the tray shuts down would outlive it: Dispose()
    # releases the handle but does not terminate the child, so kill the active
    # probe, wait briefly for exit, then release the probe state.
    try {
      Write-ActionLog "terminating active startup-health probe on tray shutdown"
      $script:startupProbeProcess.Kill()
      [void]$script:startupProbeProcess.WaitForExit(3000)
    } catch {
      Write-ActionLog "startup-health probe shutdown kill failed: $($_.Exception.GetType().Name)"
    }
    Complete-StartupHealthProbe
  }
  Stop-UpdateBadgeProbe -Shutdown
  $notify.Dispose()
  foreach ($icon in $script:ownedIcons) { $icon.Dispose() }
  $menu.Dispose()
  try { Remove-Item -LiteralPath $heartbeatPath -Force -ErrorAction SilentlyContinue } catch { }
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
  $stopEvent.Dispose()
}
