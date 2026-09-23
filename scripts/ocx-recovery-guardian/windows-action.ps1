[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Inspect', 'Recover')]
    [string]$Mode,
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][string]$OpenCodexHome,
    [Parameter(Mandatory)][string]$CodexHome,
    [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
    [ValidateRange(0, [int]::MaxValue)][int]$ExpectedPid = 0,
    [string]$ExpectedStart = '',
    [ValidateRange(0, [int]::MaxValue)][int]$ExpectedLauncherPid = 0,
    [string]$ExpectedLauncherStart = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RuntimePortMaxBytes = 32768
$IntentMaxBytes = 16384
$StopTimeoutMs = 120000
$OutputCounterCapBytes = 65536

function New-ActionResult {
    param(
        [string]$Action = 'inspect',
        [string]$Reason = 'inspect',
        [bool]$Owned = $false,
        [bool]$Alive = $false,
        [int]$ListenerPid = 0,
        [int]$ProcessId = $ExpectedPid,
        [string]$Start = '',
        [int]$LauncherPid = $ExpectedLauncherPid,
        [string]$LauncherStart = '',
        [bool]$LauncherAlive = $false,
        [string]$StopStatus = 'not-attempted'
    )
    # This is intentionally a scalar-only envelope. Process command lines,
    # environment values, paths, CLI output, request data, and error text are
    # never returned to the guardian or an external diagnostic channel.
    return [ordered]@{
        action = $Action; reason = $Reason; owned = $Owned; alive = $Alive
        listenerPid = $ListenerPid; pid = $ProcessId; start = $Start
        launcherPid = $LauncherPid; launcherStart = $LauncherStart
        launcherAlive = $LauncherAlive; stopStatus = $StopStatus
    }
}

function Write-ActionResult {
    param([System.Collections.IDictionary]$Result)
    # Bypass the PowerShell success-output pipeline: this helper's contract is
    # exactly one JSON record and a caller may be draining it with a bounded
    # pipe while deciding whether a recovery is safe.
    [Console]::Out.WriteLine(($Result | ConvertTo-Json -Compress))
}

function Get-FullPath {
    param([Parameter(Mandatory)][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [System.IO.Path]::IsPathRooted($Path)) {
        throw 'invalid-path'
    }
    return [System.IO.Path]::GetFullPath($Path)
}

function Assert-NonReparsePath {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][bool]$Leaf)
    $full = Get-FullPath $Path
    if ($Leaf) {
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw 'missing-file' }
    } elseif (-not (Test-Path -LiteralPath $full -PathType Container)) {
        throw 'missing-directory'
    }
    $root = [System.IO.Path]::GetPathRoot($full)
    $relative = $full.Substring($root.Length).TrimStart([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $current = $root
    foreach ($part in $relative.Split(@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar), [System.StringSplitOptions]::RemoveEmptyEntries)) {
        $current = Join-Path $current $part
        $entry = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (([int]$entry.Attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse-path' }
    }
    return $full
}

function Initialize-CanonicalDirectoryType {
    if ($null -ne ('OcxGuardianCanonicalDirectory' -as [type])) { return }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class OcxGuardianCanonicalDirectory {
  const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, FILE_SHARE_DELETE = 4;
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, System.Text.StringBuilder text, uint size, uint flags);
  public static string Resolve(string path) {
    using (var handle = CreateFile(path, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero, 3, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      var text = new System.Text.StringBuilder(32768); var length = GetFinalPathNameByHandle(handle, text, (uint)text.Capacity, 0);
      if (length == 0 || length >= text.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
      var result = text.ToString(); return result.StartsWith("\\\\?\\") ? result.Substring(4) : result;
    }
  }
}
'@ | Out-Null
}

function Get-StableCodexHome {
    param([Parameter(Mandatory)][string]$Path)
    $configured = Get-FullPath $Path
    if (-not (Test-Path -LiteralPath $configured -PathType Container)) { throw 'missing-directory' }
    # A normal directory needs no Win32 handle-resolution call. That keeps
    # Inspect bounded even on hosts where the WMI provider is contended; only
    # the explicitly supported user junction/symlink route needs canonicality.
    $configuredEntry = Get-Item -LiteralPath $configured -Force -ErrorAction Stop
    if ((([int]$configuredEntry.Attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -eq 0) -and $configuredEntry.PSIsContainer) {
        return [pscustomobject]@{ configured = $configured; canonical = $configured }
    }
    Initialize-CanonicalDirectoryType
    $canonical = [OcxGuardianCanonicalDirectory]::Resolve($configured)
    $entry = Get-Item -LiteralPath $canonical -Force -ErrorAction Stop
    if (-not $entry.PSIsContainer -or (([int]$entry.Attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'unsafe-codex-home' }
    return [pscustomobject]@{ configured = $configured; canonical = $canonical }
}

function Test-ExactPath {
    param([AllowNull()][string]$Left, [Parameter(Mandatory)][string]$Right)
    if ([string]::IsNullOrWhiteSpace($Left)) { return $false }
    try {
        return [string]::Equals([System.IO.Path]::GetFullPath($Left), $Right, [System.StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function Convert-ToTicksString {
    param([AllowNull()]$CreationDate)
    if ($null -eq $CreationDate) { return '' }
    try {
        if ($CreationDate -is [DateTime]) { return $CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) }
        if ($CreationDate -is [DateTimeOffset]) { return $CreationDate.UtcDateTime.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) }
        if ($CreationDate -isnot [string] -or [string]::IsNullOrWhiteSpace($CreationDate)) { return '' }
        return [System.Management.ManagementDateTimeConverter]::ToDateTime($CreationDate).ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
    } catch { return '' }
}

function Test-TicksString {
    param([AllowNull()][string]$Value)
    [long]$parsed = 0
    return [long]::TryParse($Value, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed) -and $parsed -gt 0
}

function Test-ExpectedIdentity {
    param([AllowNull()]$Process, [int]$ProcessId, [string]$Start)
    if ($null -eq $Process -or $Process.ProcessId -ne $ProcessId -or [string]::IsNullOrWhiteSpace($Start)) { return $false }
    return (Convert-ToTicksString $Process.CreationDate) -ceq $Start
}

function Get-ProcessExact {
    param([int]$ProcessId)
    try { return Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $ProcessId) -OperationTimeoutSec 3 -ErrorAction Stop } catch { return $null }
}

function Test-ArgumentToken {
    param([AllowNull()][string]$Text, [Parameter(Mandatory)][AllowEmptyString()][string]$Flag, [Parameter(Mandatory)][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
    # Win32_Process commonly escapes every backslash in CommandLine. Collapse
    # only that representation before comparing fixed local paths; no parsed
    # command line is ever emitted.
    while ($Text.Contains('\\')) { $Text = $Text.Replace('\\', '\') }
    $quoted = [regex]::Escape($Value)
    $flag = [regex]::Escape($Flag)
    # Launcher and Bun are both started with these exact, bounded argument
    # pairs. The quote forms cover Windows' normal ProcessStartInfo rendering.
    if ([string]::IsNullOrWhiteSpace($Flag)) {
        return [regex]::IsMatch($Text, ('(?i)(?:^|\s)(?:"{0}"|''{0}''|{0})(?=\s|$)' -f $quoted))
    }
    return [regex]::IsMatch($Text, ('(?i)(?:^|\s){0}\s+(?:"{1}"|''{1}''|{1})(?=\s|$)' -f $flag, $quoted))
}

function Test-OptionalPathArgument {
    param([AllowNull()][string]$Text, [string]$Flag, [string]$Configured, [string]$Canonical)
    if ([string]::IsNullOrWhiteSpace($Text) -or $Text -notmatch ("(?i)(?:^|\\s)" + [regex]::Escape($Flag) + "(?=\\s|$)")) { return $true }
    return (Test-ArgumentToken -Text $Text -Flag $Flag -Value $Configured) -or (Test-ArgumentToken -Text $Text -Flag $Flag -Value $Canonical)
}

function Test-VisibleLauncherParent {
    param([AllowNull()]$Parent, [int]$ProcessId, [string]$Start, [string]$ScriptPath, [string]$Root, [string]$OpenHome, [string]$CodexConfigured, [string]$CodexCanonical)
    if (-not (Test-ExpectedIdentity -Process $Parent -ProcessId $ProcessId -Start $Start)) { return $false }
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-ExactPath -Left $Parent.ExecutablePath -Right $powershell)) { return $false }
    if (-not (Test-ArgumentToken -Text $Parent.CommandLine -Flag '-File' -Value $ScriptPath)) { return $false }
    if (-not (Test-ArgumentToken -Text $Parent.CommandLine -Flag '-ProjectRoot' -Value $Root)) { return $false }
    if (-not (Test-OptionalPathArgument -Text $Parent.CommandLine -Flag '-OpenCodexHome' -Configured $OpenHome -Canonical $OpenHome)) { return $false }
    return Test-OptionalPathArgument -Text $Parent.CommandLine -Flag '-CodexHome' -Configured $CodexConfigured -Canonical $CodexCanonical
}

function Test-VisibleLauncherCandidate {
    param([AllowNull()]$Parent, [string]$ScriptPath, [string]$Root, [string]$OpenHome, [string]$CodexConfigured, [string]$CodexCanonical)
    if ($null -eq $Parent) { return $false }
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-ExactPath -Left $Parent.ExecutablePath -Right $powershell)) { return $false }
    if (-not (Test-ArgumentToken -Text $Parent.CommandLine -Flag '-File' -Value $ScriptPath)) { return $false }
    if (-not (Test-ArgumentToken -Text $Parent.CommandLine -Flag '-ProjectRoot' -Value $Root)) { return $false }
    if (-not (Test-OptionalPathArgument -Text $Parent.CommandLine -Flag '-OpenCodexHome' -Configured $OpenHome -Canonical $OpenHome)) { return $false }
    return Test-OptionalPathArgument -Text $Parent.CommandLine -Flag '-CodexHome' -Configured $CodexConfigured -Canonical $CodexCanonical
}

function Test-ExpectedBunChild {
    param([AllowNull()]$Child, [string]$BunPath, [string]$CliPath, [int]$ListenPort)
    if ($null -eq $Child -or $Child.ParentProcessId -ne $ExpectedLauncherPid -or -not (Test-ExactPath -Left $Child.ExecutablePath -Right $BunPath)) { return $false }
    if (-not (Test-ProjectCliArgument -Text $Child.CommandLine -CliPath $CliPath)) { return $false }
    if ($Child.CommandLine -notmatch '(?i)(?:^|\s)start(?=\s|$)') { return $false }
    return Test-ArgumentToken -Text $Child.CommandLine -Flag '--port' -Value ([string]$ListenPort)
}

function Test-InspectBunChild {
    param([AllowNull()]$Child, [string]$BunPath, [string]$CliPath, [int]$ListenPort)
    if ($null -eq $Child -or -not (Test-ExactPath -Left $Child.ExecutablePath -Right $BunPath)) { return $false }
    if (-not (Test-ProjectCliArgument -Text $Child.CommandLine -CliPath $CliPath)) { return $false }
    if ($Child.CommandLine -notmatch '(?i)(?:^|\s)start(?=\s|$)') { return $false }
    return Test-ArgumentToken -Text $Child.CommandLine -Flag '--port' -Value ([string]$ListenPort)
}

function Test-ProjectCliArgument {
    param([AllowNull()][string]$Text, [string]$CliPath)
    if (Test-ArgumentToken -Text $Text -Flag '' -Value $CliPath) { return $true }
    # Bun can retain the visible launcher's known-repository CLI as a relative
    # token. Its verified parent fixes the working directory to ProjectRoot,
    # so admit only this one relative spelling, never an arbitrary script.
    return [regex]::IsMatch($Text, '(?i)(?:^|\s)(?:"|''|)?(?:.*\\)?src\\cli\\index\.ts(?:"|'')?(?=\s|$)')
}

function Get-ListenerPid {
    param([int]$ListenPort)
    try {
        $listeners = @(Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
        if ($listeners.Count -ne 1) { return 0 }
        return [int]$listeners[0]
    } catch {
        # Get-NetTCPConnection reports an absent port as an error on some
        # Windows builds. Distinguish that ordinary absence from a failed port
        # query without ever treating an unknown occupied port as closed.
        try {
            $present = @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $ListenPort })
            if ($present.Count -eq 0) { return 0 }
        } catch { }
        return -1
    }
}

function Read-BoundedJson {
    param([Parameter(Mandatory)][string]$Path, [int]$MaximumBytes)
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if (([int]$item.Attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt $MaximumBytes) { return $null }
        return (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop)
    } catch { return $null }
}

function Read-RuntimePortSnapshot {
    param([string]$OpenCodexDirectory)
    $record = Read-BoundedJson -Path (Join-Path $OpenCodexDirectory 'runtime-port.json') -MaximumBytes $RuntimePortMaxBytes
    if ($null -eq $record) { return [pscustomobject]@{ port = 0; pid = 0 } }
    $port = if ($record.port -is [int] -or $record.port -is [long]) { [int]$record.port } else { 0 }
    $runtimePid = if ($record.pid -is [int] -or $record.pid -is [long]) { [int]$record.pid } else { 0 }
    return [pscustomobject]@{ port = $port; pid = $runtimePid }
}

function Get-OwnershipSnapshot {
    param([string]$BunPath, [string]$CliPath, [string]$ScriptPath, [string]$Root, [string]$OpenCodexDirectory, [string]$CodexConfigured, [string]$CodexCanonical)
    $target = Get-ProcessExact $ExpectedPid
    $parent = if ($ExpectedLauncherPid -gt 0) { Get-ProcessExact $ExpectedLauncherPid } else { $null }
    $listenerPid = Get-ListenerPid $Port
    $targetAlive = $null -ne $target
    $launcherAlive = $null -ne $parent
    $targetStart = if ($targetAlive) { Convert-ToTicksString $target.CreationDate } else { '' }
    $launcherStart = if ($launcherAlive) { Convert-ToTicksString $parent.CreationDate } else { '' }
    $expectedChild = (Test-ExpectedIdentity -Process $target -ProcessId $ExpectedPid -Start $ExpectedStart) -and
        (Test-ExpectedBunChild -Child $target -BunPath $BunPath -CliPath $CliPath -ListenPort $Port)
    $expectedParent = Test-VisibleLauncherParent -Parent $parent -ProcessId $ExpectedLauncherPid -Start $ExpectedLauncherStart -ScriptPath $ScriptPath -Root $Root -OpenHome $OpenCodexDirectory -CodexConfigured $CodexConfigured -CodexCanonical $CodexCanonical
    $runtime = Read-RuntimePortSnapshot -OpenCodexDirectory $OpenCodexDirectory
    # A present runtime record must agree with the same exact identity. An
    # absent record is diagnostic absence, not evidence for an arbitrary PID.
    $runtimeAgrees = (($runtime.port -eq 0 -or $runtime.port -eq $Port) -and ($runtime.pid -eq 0 -or $runtime.pid -eq $ExpectedPid))
    $owned = $expectedChild -and $expectedParent -and $runtimeAgrees -and ($listenerPid -eq 0 -or $listenerPid -eq $ExpectedPid)
    return [pscustomobject]@{
        owned = $owned; alive = $targetAlive; listenerPid = $listenerPid; pid = $ExpectedPid; start = $targetStart
        launcherPid = $ExpectedLauncherPid; launcherStart = $launcherStart; launcherAlive = $launcherAlive; launcherOwned = $expectedParent
    }
}

function Get-InspectSnapshot {
    param([string]$BunPath, [string]$CliPath, [string]$ScriptPath, [string]$Root, [string]$OpenCodexDirectory, [string]$CodexConfigured, [string]$CodexCanonical)
    $runtime = Read-RuntimePortSnapshot -OpenCodexDirectory $OpenCodexDirectory
    $listenerPid = Get-ListenerPid $Port
    $candidateIds = @(@($runtime.pid, $listenerPid) | Where-Object { $_ -gt 0 } | Select-Object -Unique)
    if ($candidateIds.Count -ne 1 -or ($runtime.port -ne 0 -and $runtime.port -ne $Port)) {
        return [pscustomobject]@{ owned = $false; alive = $false; listenerPid = $listenerPid; pid = 0; start = ''; launcherPid = 0; launcherStart = ''; launcherAlive = $false; launcherOwned = $false }
    }
    $target = Get-ProcessExact ([int]$candidateIds[0])
    $targetAlive = $null -ne $target
    $targetStart = if ($targetAlive) { Convert-ToTicksString $target.CreationDate } else { '' }
    $parent = if ($targetAlive -and $target.ParentProcessId -gt 0) { Get-ProcessExact ([int]$target.ParentProcessId) } else { $null }
    $launcherAlive = $null -ne $parent
    $launcherStart = if ($launcherAlive) { Convert-ToTicksString $parent.CreationDate } else { '' }
    $launcherPid = if ($launcherAlive) { [int]$parent.ProcessId } else { 0 }
    $launcherOwned = Test-VisibleLauncherCandidate -Parent $parent -ScriptPath $ScriptPath -Root $Root -OpenHome $OpenCodexDirectory -CodexConfigured $CodexConfigured -CodexCanonical $CodexCanonical
    $childOwned = Test-InspectBunChild -Child $target -BunPath $BunPath -CliPath $CliPath -ListenPort $Port
    $runtimeAgrees = (($runtime.port -eq 0 -or $runtime.port -eq $Port) -and ($runtime.pid -eq 0 -or $runtime.pid -eq $target.ProcessId))
    $owned = $targetAlive -and $childOwned -and $launcherOwned -and $runtimeAgrees -and ($listenerPid -eq 0 -or $listenerPid -eq $target.ProcessId)
    return [pscustomobject]@{ owned = $owned; alive = $targetAlive; listenerPid = $listenerPid; pid = if ($targetAlive) { [int]$target.ProcessId } else { [int]$candidateIds[0] }; start = $targetStart; launcherPid = $launcherPid; launcherStart = $launcherStart; launcherAlive = $launcherAlive; launcherOwned = $launcherOwned }
}

function Same-Snapshot {
    param($Left, $Right)
    return $Left.owned -eq $Right.owned -and $Left.alive -eq $Right.alive -and $Left.listenerPid -eq $Right.listenerPid -and
        $Left.start -ceq $Right.start -and $Left.launcherAlive -eq $Right.launcherAlive -and $Left.launcherOwned -eq $Right.launcherOwned -and $Left.launcherStart -ceq $Right.launcherStart
}

function Read-RecoveryIntent {
    param([string]$OpenCodexDirectory)
    $path = Join-Path $OpenCodexDirectory 'recovery-intent.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return [pscustomobject]@{ valid = $false; reason = 'missing-intent'; mode = ''; at = 0L } }
    $intent = Read-BoundedJson -Path $path -MaximumBytes $IntentMaxBytes
    if ($null -eq $intent -or -not ($intent.version -is [int] -or $intent.version -is [long]) -or $intent.version -ne 1 -or $intent.mode -isnot [string] -or -not ($intent.at -is [int] -or $intent.at -is [long]) -or $intent.at -lt 0) {
        return [pscustomobject]@{ valid = $false; reason = 'invalid-intent'; mode = ''; at = 0L }
    }
    if ($intent.mode -notin @('stopped', 'running', 'maintenance')) { return [pscustomobject]@{ valid = $false; reason = 'invalid-intent'; mode = ''; at = 0L } }
    if ($intent.mode -eq 'stopped') { return [pscustomobject]@{ valid = $false; reason = 'manual-stop'; mode = 'stopped'; at = [long]$intent.at } }
    if ($intent.mode -eq 'maintenance') {
        try {
            if (-not ($intent.until -is [int] -or $intent.until -is [long]) -or $intent.until -le $intent.at) { throw 'invalid' }
            $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            if ($intent.until -le $nowMs) { throw 'expired' }
        } catch { return [pscustomobject]@{ valid = $false; reason = 'maintenance-expired'; mode = 'maintenance'; at = [long]$intent.at } }
    } elseif ($null -ne $intent.PSObject.Properties['until']) {
        return [pscustomobject]@{ valid = $false; reason = 'invalid-intent'; mode = ''; at = 0L }
    }
    return [pscustomobject]@{ valid = $true; reason = 'allowed'; mode = [string]$intent.mode; at = [long]$intent.at }
}

function Test-CurrentRunningIntent {
    param([string]$OpenCodexDirectory, [long]$ExpectedAt)
    $current = Read-RecoveryIntent -OpenCodexDirectory $OpenCodexDirectory
    if (-not $current.valid) { return $current }
    if ($current.mode -ne 'running') { return [pscustomobject]@{ valid = $false; reason = 'intent-not-running'; mode = $current.mode; at = $current.at } }
    if ($current.at -ne $ExpectedAt) { return [pscustomobject]@{ valid = $false; reason = 'intent-changed'; mode = $current.mode; at = $current.at } }
    return $current
}

function New-RecoveryBoundaryResult {
    param([bool]$Valid, [string]$Reason, $Snapshot)
    return [pscustomobject]@{ valid = $Valid; reason = $Reason; snapshot = $Snapshot }
}

function Test-RecoveryBoundary {
    param(
        [Parameter(Mandatory)][ValidateSet('before-stop', 'after-stop', 'before-start')][string]$Boundary,
        [Parameter(Mandatory)]$ExpectedSnapshot,
        [Parameter(Mandatory)][string]$BunPath,
        [Parameter(Mandatory)][string]$CliPath,
        [Parameter(Mandatory)][string]$ScriptPath,
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$OpenCodexDirectory,
        [Parameter(Mandatory)][string]$CodexConfigured,
        [Parameter(Mandatory)][string]$CodexCanonical,
        [Parameter(Mandatory)][long]$ExpectedIntentAt
    )
    # Intent is read on both sides of each process/port observation.  This does
    # not claim a cross-process lock, but it makes a user stop/maintenance
    # transition during a long CLI stop or its post-stop checks terminal before
    # this helper can dispatch a replacement.
    $intentBefore = Test-CurrentRunningIntent -OpenCodexDirectory $OpenCodexDirectory -ExpectedAt $ExpectedIntentAt
    if (-not $intentBefore.valid) { return New-RecoveryBoundaryResult -Valid $false -Reason $intentBefore.reason -Snapshot $ExpectedSnapshot }
    $current = Get-OwnershipSnapshot -BunPath $BunPath -CliPath $CliPath -ScriptPath $ScriptPath -Root $Root -OpenCodexDirectory $OpenCodexDirectory -CodexConfigured $CodexConfigured -CodexCanonical $CodexCanonical
    if ($Boundary -eq 'before-stop') {
        if (-not (Same-Snapshot $ExpectedSnapshot $current) -or -not $current.alive -or -not $current.owned) {
            return New-RecoveryBoundaryResult -Valid $false -Reason 'snapshot-changed' -Snapshot $current
        }
    } else {
        # The old child must remain dead and the old, exact visible launcher
        # generation must remain present. A new listener, a PID reuse, or a
        # manually closed owner window is never authorization to start another.
        if ($current.alive -or $current.listenerPid -ne 0) {
            return New-RecoveryBoundaryResult -Valid $false -Reason 'stop-not-confirmed' -Snapshot $current
        }
        if (-not $current.launcherAlive -or -not $current.launcherOwned) {
            return New-RecoveryBoundaryResult -Valid $false -Reason 'launcher-generation-changed' -Snapshot $current
        }
        if (-not (Test-PortClosedTwice)) {
            return New-RecoveryBoundaryResult -Valid $false -Reason 'port-closed-check-failed' -Snapshot $current
        }
    }
    $intentAfter = Test-CurrentRunningIntent -OpenCodexDirectory $OpenCodexDirectory -ExpectedAt $ExpectedIntentAt
    if (-not $intentAfter.valid) { return New-RecoveryBoundaryResult -Valid $false -Reason $intentAfter.reason -Snapshot $current }
    return New-RecoveryBoundaryResult -Valid $true -Reason 'allowed' -Snapshot $current
}

function Initialize-DiscardDrainType {
    if ($null -ne ('OcxGuardianDiscardDrain' -as [type])) { return }
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading.Tasks;
public sealed class OcxGuardianDrainResult { public long Count; public bool Capped; }
public static class OcxGuardianDiscardDrain {
  public static async Task<OcxGuardianDrainResult> DrainAsync(Stream stream, long cap) {
    var result = new OcxGuardianDrainResult(); var buffer = new byte[4096]; int read;
    while ((read = await stream.ReadAsync(buffer, 0, buffer.Length)) > 0) {
      if (result.Count < cap) result.Count = Math.Min(cap, result.Count + read);
      if (read > 0 && result.Count >= cap) result.Capped = true;
    }
    return result;
  }
}
'@ | Out-Null
}

function Invoke-GracefulProjectStop {
    param([string]$BunPath, [string]$CliPath, [string]$OpenCodexDirectory, [string]$CodexDirectory)
    Initialize-DiscardDrainType
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $BunPath
    $info.Arguments = ('"{0}" stop' -f $CliPath.Replace('"', '""'))
    $info.WorkingDirectory = $ProjectRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables['OPENCODEX_HOME'] = $OpenCodexDirectory
    $info.EnvironmentVariables['CODEX_HOME'] = $CodexDirectory
    $info.EnvironmentVariables['OPENCODEX_GUARDIAN_RECOVERY'] = '1'
    $child = New-Object System.Diagnostics.Process
    $child.StartInfo = $info
    if (-not $child.Start()) { return 'stop-start-failed' }
    $stdout = [OcxGuardianDiscardDrain]::DrainAsync($child.StandardOutput.BaseStream, $OutputCounterCapBytes)
    $stderr = [OcxGuardianDiscardDrain]::DrainAsync($child.StandardError.BaseStream, $OutputCounterCapBytes)
    try {
        if (-not $child.WaitForExit($StopTimeoutMs)) { return 'stop-timeout' }
        [Threading.Tasks.Task]::WaitAll(@($stdout, $stderr), 5000)
        if ($child.ExitCode -ne 0) { return 'stop-exit-nonzero' }
        return 'stop-exit-zero'
    } finally { $child.Dispose() }
}

function Test-PortClosedTwice {
    if ((Get-ListenerPid $Port) -ne 0) { return $false }
    Start-Sleep -Milliseconds 250
    return (Get-ListenerPid $Port) -eq 0
}

function Start-VisibleLauncher {
    param([string]$ScriptPath, [string]$CodexHomeArgument)
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $powershell -PathType Leaf)) { return $false }
    function ConvertTo-NativeArgument([string]$Value) { return '"' + $Value.Replace('"', '\"') + '"' }
    $launchArguments = @('-NoProfile', '-File', (ConvertTo-NativeArgument $ScriptPath), '-ProjectRoot', (ConvertTo-NativeArgument $ProjectRoot), '-OpenCodexHome', (ConvertTo-NativeArgument $OpenCodexHome), '-CodexHome', (ConvertTo-NativeArgument $CodexHomeArgument), '-Port', ([string]$Port), '-ConsoleLevel', 'Warn')
    $launcher = Start-Process -FilePath $powershell -ArgumentList ($launchArguments -join ' ') -WorkingDirectory $ProjectRoot -WindowStyle Normal -PassThru
    return $null -ne $launcher
}

# A malformed/missing durable intent is a pure refusal. Check it before any
# project inspection so this boundary remains harmless for isolated fixtures.
if ($Mode -eq 'Recover') {
    if ($ExpectedPid -le 0 -or $ExpectedLauncherPid -le 0 -or -not (Test-TicksString $ExpectedStart) -or -not (Test-TicksString $ExpectedLauncherStart)) {
        Write-ActionResult (New-ActionResult -Action 'refused' -Reason 'invalid-expected-identity' -ProcessId $ExpectedPid -LauncherPid $ExpectedLauncherPid)
        exit 0
    }
    try { $intentHome = Assert-NonReparsePath -Path $OpenCodexHome -Leaf $false } catch {
        Write-ActionResult (New-ActionResult -Action 'refused' -Reason 'invalid-input' -ProcessId $ExpectedPid -LauncherPid $ExpectedLauncherPid)
        exit 0
    }
    $earlyIntent = Read-RecoveryIntent -OpenCodexDirectory $intentHome
    if (-not $earlyIntent.valid) {
        Write-ActionResult (New-ActionResult -Action 'refused' -Reason $earlyIntent.reason -ProcessId $ExpectedPid -LauncherPid $ExpectedLauncherPid)
        exit 0
    }
}

try {
    $ProjectRoot = Assert-NonReparsePath -Path $ProjectRoot -Leaf $false
    $OpenCodexHome = Assert-NonReparsePath -Path $OpenCodexHome -Leaf $false
    $codexHomePaths = Get-StableCodexHome -Path $CodexHome
    $CodexHome = $codexHomePaths.configured
    # Re-read after trusted path validation: a valid intent must remain valid
    # at the point where it could authorize an action.
    $intent = if ($Mode -eq 'Recover') { Read-RecoveryIntent -OpenCodexDirectory $OpenCodexHome } else { $null }
    if ($Mode -eq 'Recover' -and -not $intent.valid) {
        Write-ActionResult (New-ActionResult -Action 'refused' -Reason $intent.reason -ProcessId $ExpectedPid -LauncherPid $ExpectedLauncherPid)
        exit 0
    }
    if ($Mode -eq 'Recover' -and $intent.mode -ne 'running') {
        Write-ActionResult (New-ActionResult -Action 'refused' -Reason 'intent-not-running' -ProcessId $ExpectedPid -LauncherPid $ExpectedLauncherPid)
        exit 0
    }
    $intentAt = if ($Mode -eq 'Recover') { [long]$intent.at } else { 0L }
    $repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    if (-not [string]::Equals($ProjectRoot, $repositoryRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'unexpected-project-root' }
    $bunPath = Assert-NonReparsePath -Path (Join-Path $ProjectRoot 'node_modules\bun\bin\bun.exe') -Leaf $true
    $cliPath = Assert-NonReparsePath -Path (Join-Path $ProjectRoot 'src\cli\index.ts') -Leaf $true
    $visibleScriptPath = Assert-NonReparsePath -Path (Join-Path $ProjectRoot 'scripts\windows-visible-proxy.ps1') -Leaf $true

    if ($Mode -eq 'Inspect') {
        $inspect = Get-InspectSnapshot -BunPath $bunPath -CliPath $cliPath -ScriptPath $visibleScriptPath -Root $ProjectRoot -OpenCodexDirectory $OpenCodexHome -CodexConfigured $codexHomePaths.configured -CodexCanonical $codexHomePaths.canonical
        Write-ActionResult (New-ActionResult -Action 'inspect' -Reason 'inspect' -Owned $inspect.owned -Alive $inspect.alive -ListenerPid $inspect.listenerPid -ProcessId $inspect.pid -Start $inspect.start -LauncherPid $inspect.launcherPid -LauncherStart $inspect.launcherStart -LauncherAlive $inspect.launcherAlive)
        exit 0
    }

    $first = Get-OwnershipSnapshot -BunPath $bunPath -CliPath $cliPath -ScriptPath $visibleScriptPath -Root $ProjectRoot -OpenCodexDirectory $OpenCodexHome -CodexConfigured $codexHomePaths.configured -CodexCanonical $codexHomePaths.canonical

    Start-Sleep -Milliseconds 200
    $second = Get-OwnershipSnapshot -BunPath $bunPath -CliPath $cliPath -ScriptPath $visibleScriptPath -Root $ProjectRoot -OpenCodexDirectory $OpenCodexHome -CodexConfigured $codexHomePaths.configured -CodexCanonical $codexHomePaths.canonical
    if (-not (Same-Snapshot $first $second)) {
        Write-ActionResult (New-ActionResult -Action 'refused' -Reason 'snapshot-changed' -Owned $second.owned -Alive $second.alive -ListenerPid $second.listenerPid -ProcessId $second.pid -Start $second.start -LauncherPid $second.launcherPid -LauncherStart $second.launcherStart -LauncherAlive $second.launcherAlive)
        exit 0
    }

    if ($second.alive) {
        if (-not $second.owned) {
            Write-ActionResult (New-ActionResult -Action 'refused' -Reason 'ownership-lost' -Owned $second.owned -Alive $second.alive -ListenerPid $second.listenerPid -ProcessId $second.pid -Start $second.start -LauncherPid $second.launcherPid -LauncherStart $second.launcherStart -LauncherAlive $second.launcherAlive)
            exit 0
        }
        $beforeStopBoundary = Test-RecoveryBoundary -Boundary 'before-stop' -ExpectedSnapshot $second -BunPath $bunPath -CliPath $cliPath -ScriptPath $visibleScriptPath -Root $ProjectRoot -OpenCodexDirectory $OpenCodexHome -CodexConfigured $codexHomePaths.configured -CodexCanonical $codexHomePaths.canonical -ExpectedIntentAt $intentAt
        if (-not $beforeStopBoundary.valid) {
            $failed = $beforeStopBoundary.snapshot
            Write-ActionResult (New-ActionResult -Action 'refused' -Reason $beforeStopBoundary.reason -Owned $failed.owned -Alive $failed.alive -ListenerPid $failed.listenerPid -ProcessId $failed.pid -Start $failed.start -LauncherPid $failed.launcherPid -LauncherStart $failed.launcherStart -LauncherAlive $failed.launcherAlive)
            exit 0
        }
        $stopStatus = Invoke-GracefulProjectStop -BunPath $bunPath -CliPath $cliPath -OpenCodexDirectory $OpenCodexHome -CodexDirectory $codexHomePaths.canonical
        if ($stopStatus -ne 'stop-exit-zero') {
            Write-ActionResult (New-ActionResult -Action 'refused' -Reason 'stop-uncertain' -Owned $second.owned -Alive $second.alive -ListenerPid $second.listenerPid -ProcessId $second.pid -Start $second.start -LauncherPid $second.launcherPid -LauncherStart $second.launcherStart -LauncherAlive $second.launcherAlive -StopStatus $stopStatus)
            exit 0
        }
        $afterStopBoundary = Test-RecoveryBoundary -Boundary 'after-stop' -ExpectedSnapshot $second -BunPath $bunPath -CliPath $cliPath -ScriptPath $visibleScriptPath -Root $ProjectRoot -OpenCodexDirectory $OpenCodexHome -CodexConfigured $codexHomePaths.configured -CodexCanonical $codexHomePaths.canonical -ExpectedIntentAt $intentAt
        if (-not $afterStopBoundary.valid) {
            $failed = $afterStopBoundary.snapshot
            Write-ActionResult (New-ActionResult -Action 'refused' -Reason $afterStopBoundary.reason -Owned $failed.owned -Alive $failed.alive -ListenerPid $failed.listenerPid -ProcessId $failed.pid -Start $failed.start -LauncherPid $failed.launcherPid -LauncherStart $failed.launcherStart -LauncherAlive $failed.launcherAlive -StopStatus $stopStatus)
            exit 0
        }
    } else {
        if ($intent.mode -ne 'running') {
            Write-ActionResult (New-ActionResult -Action 'refused' -Reason 'dead-pid-requires-running-intent' -Owned $second.owned -Alive $second.alive -ListenerPid $second.listenerPid -ProcessId $second.pid -Start $second.start -LauncherPid $second.launcherPid -LauncherStart $second.launcherStart -LauncherAlive $second.launcherAlive)
            exit 0
        }
        if (-not $second.launcherAlive -or -not $second.launcherOwned) {
            Write-ActionResult (New-ActionResult -Action 'refused' -Reason 'launcher-not-alive' -Owned $second.owned -Alive $second.alive -ListenerPid $second.listenerPid -ProcessId $second.pid -Start $second.start -LauncherPid $second.launcherPid -LauncherStart $second.launcherStart -LauncherAlive $second.launcherAlive)
            exit 0
        }
        if ($second.listenerPid -ne 0 -or -not (Test-PortClosedTwice)) {
            Write-ActionResult (New-ActionResult -Action 'refused' -Reason 'foreign-listener' -Owned $second.owned -Alive $second.alive -ListenerPid $second.listenerPid -ProcessId $second.pid -Start $second.start -LauncherPid $second.launcherPid -LauncherStart $second.launcherStart -LauncherAlive $second.launcherAlive)
            exit 0
        }
    }

    $codexHomeAfter = Get-StableCodexHome -Path $CodexHome
    if (-not [string]::Equals($codexHomePaths.canonical, $codexHomeAfter.canonical, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-ActionResult (New-ActionResult -Action 'refused' -Reason 'codex-home-changed' -Owned $false -Alive $false -ListenerPid (Get-ListenerPid $Port) -ProcessId $ExpectedPid -LauncherPid $ExpectedLauncherPid)
        exit 0
    }
    # Configuration canonicality is another mutation boundary. Re-validate the
    # old process generation and the unchanged running intent immediately
    # before dispatching a new visible launcher.
    $beforeStartBoundary = Test-RecoveryBoundary -Boundary 'before-start' -ExpectedSnapshot $second -BunPath $bunPath -CliPath $cliPath -ScriptPath $visibleScriptPath -Root $ProjectRoot -OpenCodexDirectory $OpenCodexHome -CodexConfigured $codexHomePaths.configured -CodexCanonical $codexHomePaths.canonical -ExpectedIntentAt $intentAt
    if (-not $beforeStartBoundary.valid) {
        $failed = $beforeStartBoundary.snapshot
        Write-ActionResult (New-ActionResult -Action 'refused' -Reason $beforeStartBoundary.reason -Owned $failed.owned -Alive $failed.alive -ListenerPid $failed.listenerPid -ProcessId $failed.pid -Start $failed.start -LauncherPid $failed.launcherPid -LauncherStart $failed.launcherStart -LauncherAlive $failed.launcherAlive)
        exit 0
    }
    if (-not (Start-VisibleLauncher -ScriptPath $visibleScriptPath -CodexHomeArgument $codexHomePaths.configured)) {
        Write-ActionResult (New-ActionResult -Action 'refused' -Reason 'visible-launch-failed' -Owned $false -Alive $false -ListenerPid 0 -ProcessId $ExpectedPid -LauncherPid $ExpectedLauncherPid)
        exit 0
    }
    Write-ActionResult (New-ActionResult -Action 'started' -Reason 'visible-launcher-dispatched' -Owned $false -Alive $false -ListenerPid 0 -ProcessId $ExpectedPid -LauncherPid $ExpectedLauncherPid -StopStatus 'confirmed')
    exit 0
} catch {
    Write-ActionResult (New-ActionResult -Action 'refused' -Reason 'invalid-input' -ProcessId $ExpectedPid -LauncherPid $ExpectedLauncherPid)
    exit 0
}
