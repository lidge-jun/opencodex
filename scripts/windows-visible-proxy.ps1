[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [string]$OpenCodexHome,
    [string]$CodexHome,
    [ValidateRange(1, 65535)]
    [int]$Port = 10100,
    [switch]$CheckOnly,
    [switch]$Restart,
    [ValidateSet('Warn', 'Error', 'All')]
    [string]$ConsoleLevel = 'Warn',
    # Keeps automated, isolated checks from waiting for keyboard input after the fake child exits.
    [switch]$NoPause
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($OpenCodexHome)) {
    $OpenCodexHome = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".opencodex"
}
if ([string]::IsNullOrWhiteSpace($CodexHome)) {
    $CodexHome = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".codex"
}

$LogFileName = "windows-visible-proxy.log"
$MaxLogBytes = 2MB
$MaxChildLineCharacters = 16384
$StopCommandWaitMs = 120000
$script:VisibleProxyMutex = $null
$script:OwnsVisibleProxyMutex = $false
$script:RestartMutex = $null
$script:OwnsRestartMutex = $false
$script:LauncherExitCode = 1
$script:LauncherFailurePhase = 'initialization'
$script:LastConsoleLevel = @{ stdout = 'INFO'; stderr = 'ERROR'; launcher = 'INFO' }

function Get-VisibleLogRecord {
    param([string]$Channel, [AllowEmptyString()][string]$Message)
    # The preload tags console methods before Bun merges warn/error into stderr.
    # Remove child ANSI controls: the viewer, not arbitrary output, owns the colors.
    $clean = [regex]::Replace($Message, "\x1B\[[0-?]*[ -/]*[@-~]", '')
    $level = if ($Channel -eq 'stderr') { 'ERROR' } else { 'INFO' }
    if ($clean -match '^\[OCX:(INFO|WARN|ERROR)\]\s?(.*)$') {
        $level = $Matches[1]
        $clean = $Matches[2]
    } elseif ($clean -match '^\s+\S' -and $script:LastConsoleLevel.ContainsKey($Channel)) {
        $level = $script:LastConsoleLevel[$Channel]
    } elseif ($clean -match '^\s*\[(WARN|WARNING|ERROR|FATAL)\]') {
        $level = if ($Matches[1] -in @('WARN','WARNING')) { 'WARN' } else { 'ERROR' }
    }
    $script:LastConsoleLevel[$Channel] = $level
    return [pscustomobject]@{ Level = $level; Message = $clean }
}

function Write-VisibleConsole {
    param([string]$Channel, [AllowEmptyString()][string]$Message, [string]$Timestamp = (Get-Date -Format 'HH:mm:ss'))
    $record = Get-VisibleLogRecord -Channel $Channel -Message $Message
    if ($ConsoleLevel -eq 'Error' -and $record.Level -ne 'ERROR') { return }
    if ($ConsoleLevel -eq 'Warn' -and $record.Level -eq 'INFO') { return }
    if ([string]::IsNullOrWhiteSpace($record.Message)) { return }
    $color = switch ($record.Level) { 'ERROR' { 'Red' }; 'WARN' { 'Yellow' }; default { 'Gray' } }
    Write-Host (" {0}  " -f $Timestamp) -ForegroundColor DarkGray -NoNewline
    Write-Host ("{0,-5} " -f $record.Level) -ForegroundColor $color -NoNewline
    Write-Host $record.Message -ForegroundColor $color
}

function Show-VisibleHeader {
    param([string]$Mode, [int]$ListenPort)
    try { $Host.UI.RawUI.WindowTitle = "OpenCodex | $Mode | :$ListenPort | $ConsoleLevel" } catch { }
    Write-Host ''
    Write-Host '  OPENCODEX  /  PROJECT CONSOLE' -ForegroundColor Cyan
    Write-Host ("  {0}  |  http://127.0.0.1:{1}  |  display: {2}" -f $Mode, $ListenPort, $ConsoleLevel) -ForegroundColor Gray
    Write-Host '  WARN = yellow    ERROR = red    Full output is retained in the rotating log.' -ForegroundColor DarkGray
    Write-Host '  Quiet output means no matching messages, not a health/readiness verdict.' -ForegroundColor DarkGray
    Write-Host ('  ' + ('-' * 76)) -ForegroundColor DarkGray
}

function Disable-ConsoleQuickEdit {
    # Classic conhost pauses synchronous Write-Host while selecting text. If the
    # reader then stops draining Bun's pipes, a busy proxy can block on logging.
    # Only alter this console's input mode; never change global console settings.
    try {
        if ($null -eq ('OcxVisibleConsoleMode' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OcxVisibleConsoleMode {
    [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr handle, out uint mode);
    [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr handle, uint mode);
}
'@
        }
        $inputHandle = [OcxVisibleConsoleMode]::GetStdHandle(-10)
        [uint32]$mode = 0
        if ([OcxVisibleConsoleMode]::GetConsoleMode($inputHandle, [ref]$mode)) {
            [void][OcxVisibleConsoleMode]::SetConsoleMode($inputHandle, (($mode -bor 0x80) -band (-bnot 0x40)))
        }
    } catch { } # redirected/test hosts need no console mode
}

function Resolve-AbsolutePath {
    param([Parameter(Mandatory)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path)
}

function Set-RecoveryIntent {
    param(
        [Parameter(Mandatory)][string]$OpenCodexDirectory,
        [Parameter(Mandatory)][ValidateSet('running', 'stopped', 'maintenance')][string]$Mode,
        [long]$Until = 0
    )
    $helper = Join-Path $ProjectRoot 'scripts\ocx-recovery-guardian\intent.ps1'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
        throw 'Recovery intent helper is missing; visible launcher did not dispatch a lifecycle action.'
    }
    # Do not splat an array here: Windows PowerShell treats it as positional
    # arguments, so the home path can bind to the helper's -Mode parameter.
    $intentArgs = @{ OpenCodexHome = $OpenCodexDirectory; Mode = $Mode }
    if ($Mode -eq 'maintenance') { $intentArgs.Until = $Until }
    & $helper @intentArgs
}

function Get-VisibleProxyMutexName {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][int]$ListenPort
    )

    $identity = "{0}|{1}" -f $Root.TrimEnd("\").ToUpperInvariant(), $ListenPort
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($identity)
        $hash = $sha256.ComputeHash($bytes)
        return "Local\OpenCodex.VisibleProxy." + ([System.BitConverter]::ToString($hash).Replace("-", ""))
    } finally {
        $sha256.Dispose()
    }
}

function Test-OpenCodexHealth {
    param([Parameter(Mandatory)][int]$ListenPort)

    $request = $null
    $response = $null
    $reader = $null
    try {
        $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$ListenPort/healthz")
        $request.Method = "GET"
        $request.Timeout = 1500
        $request.ReadWriteTimeout = 1500
        $request.AllowAutoRedirect = $false
        $request.Proxy = $null
        $response = [System.Net.HttpWebResponse]$request.GetResponse()
        if ($response.StatusCode -ne [System.Net.HttpStatusCode]::OK) { return $false }

        $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [System.Text.Encoding]::UTF8, $true, 4096, $false)
        $body = $reader.ReadToEnd() | ConvertFrom-Json
        return $body.service -ceq "opencodex"
    } catch {
        return $false
    } finally {
        if ($null -ne $reader) { $reader.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
    }
}

function Get-RecoveryGatewayState {
    param([Parameter(Mandatory)][int]$ListenPort)
    $request = $null
    $response = $null
    $reader = $null
    try {
        $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$ListenPort/healthz")
        $request.Method = 'GET'
        $request.Timeout = 1200
        $request.ReadWriteTimeout = 1200
        $request.AllowAutoRedirect = $false
        $request.Proxy = $null
        $response = [System.Net.HttpWebResponse]$request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [System.Text.Encoding]::UTF8, $true, 8192, $false)
        $body = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
        if ($response.StatusCode -eq [System.Net.HttpStatusCode]::OK -and $body.service -ceq 'ocx-recovery-gateway') { return 'running' }
        return 'foreign'
    } catch [System.Net.WebException] {
        if ($null -ne $_.Exception.Response) { return 'foreign' }
        return 'absent'
    } catch {
        return 'foreign'
    } finally {
        if ($null -ne $reader) { $reader.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
    }
}

function Test-RecoveryGuardianProcessIdentity {
    param(
        [Parameter(Mandatory)][int]$ListenPort,
        [Parameter(Mandatory)][string]$ExpectedNode,
        [Parameter(Mandatory)][string]$MainPath,
        [Parameter(Mandatory)][string]$MarkerPath
    )
    try {
        $owners = @(
            Get-NetTCPConnection -State Listen -LocalPort $ListenPort -ErrorAction Stop |
                Select-Object -ExpandProperty OwningProcess -Unique
        )
        if ($owners.Count -ne 1 -or [int]$owners[0] -le 0) { return $false }
        $process = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f [int]$owners[0]) -OperationTimeoutSec 3 -ErrorAction Stop
        if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.ExecutablePath) -or [string]::IsNullOrWhiteSpace($process.CommandLine)) { return $false }
        if ([System.IO.Path]::GetFullPath($process.ExecutablePath) -cne $ExpectedNode) { return $false }
        # WMI can render native argument backslashes escaped. Normalize that
        # representation before matching the fixed local argv contract.
        $commandLine = $process.CommandLine
        while ($commandLine.Contains('\\')) { $commandLine = $commandLine.Replace('\\', '\') }
        $main = [regex]::Escape($MainPath)
        $marker = [regex]::Escape($MarkerPath)
        if (-not [regex]::IsMatch($commandLine, ('(?i)(?:^|\s)(?:"{0}"|''{0}''|{0})(?=\s|$)' -f $main))) { return $false }
        return [regex]::IsMatch($commandLine, ('(?i)(?:^|\s)--config\s+(?:"{0}"|''{0}''|{0})(?=\s|$)' -f $marker))
    } catch { return $false }
}

function ConvertTo-RecoveryGuardianArgument {
    param([Parameter(Mandatory)][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.IndexOf('"') -ge 0 -or $Value -match '[\x00-\x1F]') {
        throw 'Recovery guardian launch path contains an unsafe quote or control character.'
    }

    # Windows PowerShell combines ArgumentList elements into a native command
    # line. Quote every path and double trailing backslashes so the closing
    # quote cannot be consumed by the Windows command-line parser.
    return '"' + ($Value -replace '(\\+)$', '$1$1') + '"'
}

function Ensure-RecoveryGuardian {
    param(
        [Parameter(Mandatory)][string]$OpenCodexDirectory,
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$EffectiveCodexHome,
        [Parameter(Mandatory)][int]$PrimaryPort
    )
    $markerPath = Join-Path $OpenCodexDirectory 'recovery-guardian.json'
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { return }
    try {
        $markerInfo = Get-Item -LiteralPath $markerPath -Force -ErrorAction Stop
        if ((([int]$markerInfo.Attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0) -or $markerInfo.Length -gt 16KB) { throw 'unsafe' }
        $marker = [System.IO.File]::ReadAllText($markerInfo.FullName, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw 'Recovery guardian marker is malformed; visible launcher did not start the proxy.'
    }
    if ($marker.version -eq 1 -and $marker.enabled -is [bool] -and -not $marker.enabled) { return }
    if ($marker.version -ne 1 -or -not ($marker.enabled -is [bool]) -or -not $marker.enabled) {
        throw 'Recovery guardian marker is malformed; visible launcher did not start the proxy.'
    }
    $expectedNode = Join-Path ${env:ProgramFiles} 'nodejs\node.exe'
    $mainPath = Join-Path $Root 'scripts\ocx-recovery-guardian\main.cjs'
    try {
      $approvedConfig = $marker.projectRoot -is [string] -and $marker.openCodexHome -is [string] -and $marker.codexHome -is [string] -and
        [System.IO.Path]::GetFullPath($marker.projectRoot) -ceq $Root -and
        [System.IO.Path]::GetFullPath($marker.openCodexHome) -ceq $OpenCodexDirectory -and
        [System.IO.Path]::GetFullPath($marker.codexHome) -ceq $EffectiveCodexHome -and
        $marker.nodePath -is [string] -and [System.IO.Path]::GetFullPath($marker.nodePath) -ceq $expectedNode -and
        ($marker.listenPort -is [int] -or $marker.listenPort -is [long]) -and $marker.listenPort -ge 1 -and $marker.listenPort -le 65535 -and
        ($marker.primaryPort -is [int] -or $marker.primaryPort -is [long]) -and $marker.primaryPort -eq $PrimaryPort -and
        $marker.primaryPort -ne $marker.listenPort -and $null -ne $marker.fallback -and $null -ne $marker.fallback.models -and $null -ne $marker.repair -and
        (Test-Path -LiteralPath $expectedNode -PathType Leaf) -and (Test-Path -LiteralPath $mainPath -PathType Leaf)
    } catch { $approvedConfig = $false }
    if (-not $approvedConfig) {
        throw 'Recovery guardian marker is not an approved local companion configuration; visible launcher did not start the proxy.'
    }
    $nodeInfo = Get-Item -LiteralPath $expectedNode -Force -ErrorAction Stop
    $mainInfo = Get-Item -LiteralPath $mainPath -Force -ErrorAction Stop
    if ((([int]$nodeInfo.Attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0) -or (([int]$mainInfo.Attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw 'Recovery guardian executable identity is unsafe; visible launcher did not start the proxy.'
    }
    $gateway = Get-RecoveryGatewayState -ListenPort ([int]$marker.listenPort)
    if ($gateway -eq 'running') {
        if (Test-RecoveryGuardianProcessIdentity -ListenPort ([int]$marker.listenPort) -ExpectedNode $expectedNode -MainPath $mainPath -MarkerPath $markerPath) { return }
        throw 'Recovery guardian port is occupied by an unrecognized listener; visible launcher did not start the proxy.'
    }
    if ($gateway -ne 'absent') { throw 'Recovery guardian port is occupied by an unrecognized listener; visible launcher did not start the proxy.' }
    $guardianArgs = @(
        (ConvertTo-RecoveryGuardianArgument -Value $mainPath),
        '--config',
        (ConvertTo-RecoveryGuardianArgument -Value $markerPath)
    )
    $guardian = Start-Process -FilePath $expectedNode -ArgumentList $guardianArgs -WindowStyle Hidden -PassThru
    if ($null -eq $guardian) { throw 'Recovery guardian did not start; visible launcher did not start the proxy.' }
    $guardian.Dispose()
}

function Write-VisibleLog {
    param(
        [Parameter(Mandatory)][string]$LogPath,
        [Parameter(Mandatory)][string]$Channel,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Message
    )

    $line = "[{0:yyyy-MM-dd HH:mm:ss.fff K}] [{1}] {2}" -f (Get-Date), $Channel, $Message
    Write-VisibleConsole -Channel $Channel -Message $Message
    $directory = Split-Path -Parent $LogPath
    [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($line + [Environment]::NewLine)

    if (Test-Path -LiteralPath $LogPath -PathType Leaf) {
        $length = (Get-Item -LiteralPath $LogPath).Length
        if ($length -gt 0 -and $length + $bytes.Length -gt $MaxLogBytes) {
            $previous = "$LogPath.1"
            if (Test-Path -LiteralPath $previous -PathType Leaf) {
                Remove-Item -LiteralPath $previous -Force
            }
            Move-Item -LiteralPath $LogPath -Destination $previous -Force
        }
    }

    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::AppendAllText($LogPath, $line + [Environment]::NewLine, $utf8)
}

function Test-LoopbackPortOccupied {
    param([Parameter(Mandatory)][int]$ListenPort)

    foreach ($endpoint in [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()) {
        if ($endpoint.Port -ne $ListenPort) { continue }
        if ($endpoint.Address.Equals([System.Net.IPAddress]::Loopback) -or
            $endpoint.Address.Equals([System.Net.IPAddress]::IPv6Loopback) -or
            $endpoint.Address.Equals([System.Net.IPAddress]::Any) -or
            $endpoint.Address.Equals([System.Net.IPAddress]::IPv6Any)) {
            return $true
        }
    }
    return $false
}

function Release-VisibleProxyMutex {
    if ($script:OwnsVisibleProxyMutex -and $null -ne $script:VisibleProxyMutex) {
        try { [void]$script:VisibleProxyMutex.ReleaseMutex() } catch { }
        $script:OwnsVisibleProxyMutex = $false
    }
}

function Release-RestartMutex {
    if ($script:OwnsRestartMutex -and $null -ne $script:RestartMutex) {
        try { [void]$script:RestartMutex.ReleaseMutex() } catch { }
        $script:OwnsRestartMutex = $false
    }
}

function Acquire-VisibleProxyMutexAfterStop {
    # The old visible window releases this owner lock before its post-exit prompt. Bound waiting
    # lets Restart hand off without requiring the user to close that window.
    for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
        try {
            $script:OwnsVisibleProxyMutex = $script:VisibleProxyMutex.WaitOne(0)
        } catch [System.Threading.AbandonedMutexException] {
            $script:OwnsVisibleProxyMutex = $true
        }
        if ($script:OwnsVisibleProxyMutex) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "The prior visible launcher did not release its owner lock within 15 seconds; no replacement was started."
}

function Follow-ExistingLog {
    param([Parameter(Mandatory)][string]$LogPath)

    if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) {
        Write-VisibleConsole -Channel stderr -Message '[OCX:WARN] A background OpenCodex instance is serving this port, but no visible console owns it. This window did not start the proxy. Stop its actual manager before switching to desktop mode.'
        if (-not $NoPause) { [void](Read-Host "Press Enter to close this window") }
        return
    }

    Show-VisibleHeader -Mode 'LOG VIEWER (does not own the proxy)' -ListenPort $Port
    Write-Host '  Close this viewer without stopping the owner window.' -ForegroundColor DarkGray
    # Poll bounded chunks with ReadWrite/Delete sharing; reopen after rotation instead
    # of following a renamed .1 forever. Only the owner writes the file.
    $offset = 0L
    $created = [DateTime]::MinValue
    $partial = ''
    do {
        if (Test-Path -LiteralPath $LogPath -PathType Leaf) {
            try {
                $file = Get-Item -LiteralPath $LogPath
                if ($file.CreationTimeUtc -ne $created -or $file.Length -lt $offset) {
                    $offset = 0L; $partial = ''; $created = $file.CreationTimeUtc
                }
                $stream = [System.IO.File]::Open($LogPath, 'Open', 'Read', ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
                try {
                    [void]$stream.Seek($offset, 'Begin')
                    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
                    try { $chunk = $reader.ReadToEnd(); $offset = $stream.Position } finally { $reader.Dispose() }
                } finally { $stream.Dispose() }
                $lines = ($partial + $chunk).Split("`n")
                $partial = $lines[-1]
                for ($i = 0; $i -lt $lines.Length - 1; $i++) {
                    if ($lines[$i] -match '^\[\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2})[^\]]*\] \[(stdout|stderr|launcher)\] (.*)') {
                        Write-VisibleConsole -Timestamp $Matches[1] -Channel $Matches[2] -Message $Matches[3].TrimEnd("`r")
                    }
                }
            } catch [System.IO.IOException] { } # owner may be rotating between open and read
        }
        if (-not $NoPause) { Start-Sleep -Milliseconds 500 }
    } while (-not $NoPause)
}

function Write-LauncherLifecycleEvent {
    param(
        [Parameter(Mandatory)][string]$OpenCodexDirectory,
        [Parameter(Mandatory)][string]$EventName,
        [int]$ChildPid = 0,
        [AllowNull()][Nullable[int]]$ExitCode = $null,
        [string]$FailureKind = '',
        [string]$Detail = ''
    )
    # Separate from the proxy owner's rotating transcript: two launchers must
    # never race to rotate that file. Record scalar lifecycle facts, not CLI
    # output, arguments, environment, request contents, or exception text.
    $eventMutex = $null
    $ownsEventMutex = $false
    try {
        $directory = Join-Path $OpenCodexDirectory 'logs'
        [void][System.IO.Directory]::CreateDirectory($directory)
        $eventPath = Join-Path $directory 'windows-visible-launcher-events.log'
        $identityBytes = [System.Text.Encoding]::UTF8.GetBytes($eventPath.ToUpperInvariant())
        $hash = [System.Security.Cryptography.SHA256]::Create()
        try { $mutexName = 'Local\OpenCodex.VisibleLauncherEvents.' + ([System.BitConverter]::ToString($hash.ComputeHash($identityBytes)).Replace('-', '')) }
        finally { $hash.Dispose() }
        $eventMutex = New-Object System.Threading.Mutex($false, $mutexName)
        try { $ownsEventMutex = $eventMutex.WaitOne(2000) }
        catch [System.Threading.AbandonedMutexException] { $ownsEventMutex = $true }
        if (-not $ownsEventMutex) { throw 'Timed out waiting to record a launcher lifecycle event.' }
        $record = [ordered]@{at=(Get-Date).ToString('o');launcherPid=$PID;event=$EventName;childPid=$ChildPid}
        if ($null -ne $ExitCode) {
            # Process.ExitCode is signed, whereas Windows crash status is commonly
            # reported as an unsigned 32-bit hexadecimal value (for example C0000005).
            # Persist both representations so a later investigation need not guess.
            $record.exitCode = [int]$ExitCode
            $record.exitCodeHex = '0x{0:X8}' -f [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$ExitCode), 0)
        }
        if (-not [string]::IsNullOrWhiteSpace($FailureKind)) {
            # A stable classifier distinguishes launcher exceptions without
            # persisting exception messages, which can carry local paths or data.
            $record.failureKind = $FailureKind
        }
        if (-not [string]::IsNullOrWhiteSpace($Detail)) {
            $record.detail = $Detail
        }
        $line = $record | ConvertTo-Json -Compress
        if ((Test-Path -LiteralPath $eventPath) -and (Get-Item -LiteralPath $eventPath).Length -gt 256KB) {
            Move-Item -LiteralPath $eventPath -Destination ($eventPath + '.1') -Force
        }
        [System.IO.File]::AppendAllText($eventPath, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        Write-VisibleConsole stderr '[OCX:WARN] Launcher lifecycle event could not be saved.'
    } finally {
        if ($ownsEventMutex -and $null -ne $eventMutex) {
            try { [void]$eventMutex.ReleaseMutex() } catch { }
        }
        if ($null -ne $eventMutex) { $eventMutex.Dispose() }
    }
}

function Invoke-ProjectCliStop {
    param(
        [Parameter(Mandatory)][string]$BunPath,
        [Parameter(Mandatory)][string]$CliPath,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][string]$OpenCodexDirectory,
        [Parameter(Mandatory)][string]$CodexDirectory
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $BunPath
    $startInfo.Arguments = ('"{0}" stop' -f $CliPath)
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $false
    $startInfo.EnvironmentVariables["OPENCODEX_HOME"] = $OpenCodexDirectory
    $startInfo.EnvironmentVariables["CODEX_HOME"] = $CodexDirectory
    $startInfo.EnvironmentVariables["HTTP_PROXY"] = "http://127.0.0.1:7890"
    $startInfo.EnvironmentVariables["HTTPS_PROXY"] = "http://127.0.0.1:7890"
    $startInfo.EnvironmentVariables["ALL_PROXY"] = "socks5://127.0.0.1:7891"
    $startInfo.EnvironmentVariables["NO_PROXY"] = "localhost,127.0.0.1,::1"
    $startInfo.EnvironmentVariables["OPENCODEX_RUNTIME_DIAGNOSTICS"] = "1"
    $startInfo.EnvironmentVariables["OPENCODEX_CODEX_UPSTREAM_TRANSPORT"] = "http-sse"
    [void]$startInfo.EnvironmentVariables.Remove("OCX_SERVICE")
    $startInfo.EnvironmentVariables["OPENCODEX_GUARDIAN_RECOVERY"] = "1"

    $stopProcess = New-Object System.Diagnostics.Process
    $stopProcess.StartInfo = $startInfo
    if (-not $stopProcess.Start()) { throw "Unable to start the project CLI stop command." }
    Write-LauncherLifecycleEvent -OpenCodexDirectory $OpenCodexDirectory -EventName 'stop-command-started' -ChildPid $stopProcess.Id
    try {
        # CLI stop includes discovery, drain, port reclamation AND shared-config
        # restoration. Abandoning it after 15s left a still-running stop command
        # that later shut down the proxy after this launcher had given up.
        $stopTimer = [System.Diagnostics.Stopwatch]::StartNew()
        $nextNoticeMs = 15000
        while (-not $stopProcess.WaitForExit(1000)) {
            if ($stopTimer.ElapsedMilliseconds -ge $StopCommandWaitMs) {
                Write-LauncherLifecycleEvent -OpenCodexDirectory $OpenCodexDirectory -EventName 'stop-command-timeout' -ChildPid $stopProcess.Id
                throw "Project CLI stop exceeded the bounded 120-second wait; it is still running and no replacement was started."
            }
            if ($stopTimer.ElapsedMilliseconds -ge $nextNoticeMs) {
                Write-VisibleConsole stderr '[OCX:WARN] Still waiting for normal stop and config restoration; replacement has not started yet.'
                $nextNoticeMs += 15000
            }
        }
        Write-LauncherLifecycleEvent -OpenCodexDirectory $OpenCodexDirectory -EventName 'stop-command-exited' -ChildPid $stopProcess.Id -ExitCode $stopProcess.ExitCode
        if ($stopProcess.ExitCode -ne 0) {
            throw "Project CLI stop exited with code $($stopProcess.ExitCode)."
        }
    } finally {
        $stopProcess.Dispose()
    }
}

function Wait-ForOpenCodexToStop {
    param([Parameter(Mandatory)][int]$ListenPort)

    # This is a bounded post-stop confirmation, not a restart loop. Do not launch while the
    # identity-checked listener still answers, because that would turn an unknown owner into a port race.
    for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
        if (-not (Test-OpenCodexHealth -ListenPort $ListenPort)) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "OpenCodex still answered /healthz 15 seconds after the project CLI stop command; no replacement was started."
}

function Wait-ForFailureAcknowledgement {
    if (-not $NoPause) {
        [void](Read-Host "The visible OpenCodex process exited. Press Enter to close this window")
    }
}

function Drain-ChildChunkToLog {
    param(
        [Parameter(Mandatory)][System.Threading.Tasks.Task[int]]$Task,
        [Parameter(Mandatory)][char[]]$Characters,
        [Parameter(Mandatory)][hashtable]$State,
        [Parameter(Mandatory)][string]$Channel,
        [Parameter(Mandatory)][string]$LogPath
    )

    $count = $Task.GetAwaiter().GetResult()
    if ($count -eq 0) {
        if ($State.Buffer.Length -gt 0 -or $State.Truncated) {
            $message = $State.Buffer.ToString()
            if ($message.EndsWith("`r")) { $message = $message.Substring(0, $message.Length - 1) }
            if ($State.Truncated) { $message += " [truncated]" }
            Write-VisibleLog -LogPath $LogPath -Channel $Channel -Message $message
        }
        return $false
    }

    for ($index = 0; $index -lt $count; $index += 1) {
        $character = $Characters[$index]
        if ($character -eq "`n") {
            $message = $State.Buffer.ToString()
            if ($message.EndsWith("`r")) { $message = $message.Substring(0, $message.Length - 1) }
            if ($State.Truncated) { $message += " [truncated]" }
            Write-VisibleLog -LogPath $LogPath -Channel $Channel -Message $message
            [void]$State.Buffer.Clear()
            $State.Truncated = $false
        } elseif ($State.Buffer.Length -lt $MaxChildLineCharacters) {
            [void]$State.Buffer.Append($character)
        } else {
            $State.Truncated = $true
        }
    }
    return $true
}

function Initialize-VisiblePipePumpType {
    # A pipe reader must never wait for a visible console or filesystem write.
    # The queues make that boundary explicit: when the disk cannot keep up we
    # preserve proxy liveness with bounded memory and emit a durable overflow
    # summary as soon as the writer recovers. A permanently unavailable disk
    # cannot simultaneously provide lossless logs, bounded memory, and a
    # non-blocking child pipe; this deliberately chooses the latter two.
    if ($null -eq ('OcxVisiblePipePump' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public sealed class OcxVisiblePipePump {
    private sealed class Row { public string Channel; public string Message; public Row(string c, string m) { Channel = c; Message = m; } }
    private const int MaxLineCharacters = 16384;
    private readonly BlockingCollection<Row> records = new BlockingCollection<Row>(512);
    private readonly BlockingCollection<Row> console = new BlockingCollection<Row>(256);
    private readonly Stream stdout;
    private readonly Stream stderr;
    private readonly string logPath;
    private readonly string displayLevel;
    private Thread stdoutReader;
    private Thread stderrReader;
    private Thread writer;
    private Thread consoleWriter;
    private long droppedRecords;
    private long firstDroppedAt;
    private long lastDroppedAt;
    private long droppedConsoleRows;
    private long consoleFailures;
    private string stdoutLevel = "INFO";
    private string stderrLevel = "ERROR";
    private string launcherLevel = "INFO";

    public OcxVisiblePipePump(Stream standardOutput, Stream standardError, string path, string level) {
        stdout = standardOutput; stderr = standardError; logPath = path; displayLevel = level;
    }

    public void Start() {
        consoleWriter = NewThread(ConsoleLoop, "ocx-visible-console");
        writer = NewThread(WriterLoop, "ocx-visible-writer");
        stdoutReader = NewThread(delegate { ReadLoop(stdout, "stdout"); }, "ocx-visible-stdout");
        stderrReader = NewThread(delegate { ReadLoop(stderr, "stderr"); }, "ocx-visible-stderr");
    }

    public void QueueLauncher(string message) { OfferRecord(new Row("launcher", message)); }

    public string StopAndDescribe(int waitMilliseconds) {
        stdoutReader.Join(waitMilliseconds);
        stderrReader.Join(waitMilliseconds);
        if (!stdoutReader.IsAlive && !stderrReader.IsAlive) records.CompleteAdding();
        writer.Join(waitMilliseconds);
        if (!writer.IsAlive) {
            console.CompleteAdding();
            // Child pipes and disk writer are already drained; boundedly wait
            // for diagnostic rows queued by the writer before PowerShell exits.
            consoleWriter.Join(waitMilliseconds);
        }
        return string.Format("recordDrops={0}; consoleDrops={1}; consoleFailures={2}; writerStopped={3}", Interlocked.Read(ref droppedRecords), Interlocked.Read(ref droppedConsoleRows), Interlocked.Read(ref consoleFailures), !writer.IsAlive);
    }

    private static Thread NewThread(ThreadStart action, string name) {
        Thread thread = new Thread(action); thread.IsBackground = true; thread.Name = name; thread.Start(); return thread;
    }

    private void ReadLoop(Stream stream, string channel) {
        try {
            StreamReader reader = new StreamReader(stream, new UTF8Encoding(false), true, 4096);
            char[] characters = new char[4096]; StringBuilder line = new StringBuilder(); bool truncated = false; int count;
            while ((count = reader.Read(characters, 0, characters.Length)) != 0) {
                for (int index = 0; index < count; index += 1) {
                    char character = characters[index];
                    if (character == '\n') { FinishLine(channel, line, truncated); line.Length = 0; truncated = false; }
                    else if (line.Length < MaxLineCharacters) line.Append(character);
                    else truncated = true;
                }
            }
            if (line.Length > 0 || truncated) FinishLine(channel, line, truncated);
        } catch (Exception error) {
            OfferRecord(new Row("launcher", "[OCX:ERROR] pipe-reader-failed kind=" + error.GetType().Name));
        }
    }

    private void FinishLine(string channel, StringBuilder line, bool truncated) {
        string message = line.ToString().TrimEnd('\r');
        if (truncated) message += " [truncated]";
        OfferRecord(new Row(channel, message));
    }

    private void OfferRecord(Row row) {
        if (records.IsAddingCompleted || !records.TryAdd(row)) {
            long now = DateTime.UtcNow.Ticks;
            if (Interlocked.Increment(ref droppedRecords) == 1) Interlocked.CompareExchange(ref firstDroppedAt, now, 0);
            Interlocked.Exchange(ref lastDroppedAt, now);
        }
    }

    private void WriterLoop() {
        try {
            foreach (Row row in records.GetConsumingEnumerable()) {
                try { WriteRecoveredOverflow(); Append(row); OfferConsole(row); }
                catch (Exception error) {
                    CountDroppedRecord();
                    OfferConsole(new Row("launcher", "[OCX:ERROR] transcript-writer-failed kind=" + error.GetType().Name));
                    Thread.Sleep(100);
                }
            }
            try { WriteRecoveredOverflow(); }
            catch (Exception error) { OfferConsole(new Row("launcher", "[OCX:ERROR] transcript-writer-failed kind=" + error.GetType().Name)); }
        } catch { }
    }

    private void CountDroppedRecord() {
        long now = DateTime.UtcNow.Ticks;
        if (Interlocked.Increment(ref droppedRecords) == 1) Interlocked.CompareExchange(ref firstDroppedAt, now, 0);
        Interlocked.Exchange(ref lastDroppedAt, now);
    }

    private void WriteRecoveredOverflow() {
        long dropped = Interlocked.Exchange(ref droppedRecords, 0);
        if (dropped == 0) return;
        long first = Interlocked.Exchange(ref firstDroppedAt, 0); long last = Interlocked.Exchange(ref lastDroppedAt, 0);
        string message = string.Format("[OCX:ERROR] transcript-overflow droppedRecords={0}; firstUtcTicks={1}; lastUtcTicks={2}; full transcript has a gap.", dropped, first, last);
        try {
            Append(new Row("launcher", message));
            OfferConsole(new Row("launcher", message));
        } catch {
            RestoreDroppedRecords(dropped, first, last);
            throw;
        }
    }

    private void RestoreDroppedRecords(long dropped, long first, long last) {
        Interlocked.Add(ref droppedRecords, dropped);
        if (first != 0) {
            long observed;
            do {
                observed = Interlocked.Read(ref firstDroppedAt);
                if (observed != 0 && observed <= first) break;
            } while (Interlocked.CompareExchange(ref firstDroppedAt, first, observed) != observed);
        }
        if (last != 0) {
            long observed;
            do { observed = Interlocked.Read(ref lastDroppedAt); if (observed >= last) break; }
            while (Interlocked.CompareExchange(ref lastDroppedAt, last, observed) != observed);
        }
    }

    private void Append(Row row) {
        string directory = Path.GetDirectoryName(logPath); if (!String.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        string line = string.Format("[{0:yyyy-MM-dd HH:mm:ss.fff K}] [{1}] {2}{3}", DateTime.Now, row.Channel, row.Message, Environment.NewLine);
        const long maxLogBytes = 2L * 1024L * 1024L;
        FileInfo file = new FileInfo(logPath);
        if (file.Exists && file.Length > 0 && file.Length + Encoding.UTF8.GetByteCount(line) > maxLogBytes) {
            string previous = logPath + ".1"; if (File.Exists(previous)) File.Delete(previous); File.Move(logPath, previous);
        }
        File.AppendAllText(logPath, line, new UTF8Encoding(false));
    }

    private void OfferConsole(Row row) {
        if (!console.TryAdd(row)) Interlocked.Increment(ref droppedConsoleRows);
    }

    private void ConsoleLoop() {
        try {
            foreach (Row row in console.GetConsumingEnumerable()) {
                string visibleMessage = StripAnsi(row.Message);
                string level = Classify(row.Channel, visibleMessage);
                long skipped = Interlocked.Exchange(ref droppedConsoleRows, 0);
                if (skipped > 0) Render("WARN", "visible-console-overflow droppedRows=" + skipped + "; full transcript remains the source of truth.");
                if ((displayLevel == "Error" && level != "ERROR") || (displayLevel == "Warn" && level == "INFO")) continue;
                if (!String.IsNullOrWhiteSpace(visibleMessage)) Render(level, StripTag(visibleMessage));
            }
        } catch { Interlocked.Increment(ref consoleFailures); }
    }

    private string Classify(string channel, string message) {
        string level = channel == "stderr" ? "ERROR" : "INFO";
        if (message.StartsWith("[OCX:INFO]")) level = "INFO";
        else if (message.StartsWith("[OCX:WARN]")) level = "WARN";
        else if (message.StartsWith("[OCX:ERROR]")) level = "ERROR";
        else if (message.TrimStart().StartsWith("[WARN") || message.TrimStart().StartsWith("[WARNING")) level = "WARN";
        else if (message.TrimStart().StartsWith("[ERROR") || message.TrimStart().StartsWith("[FATAL")) level = "ERROR";
        else if (message.Length > 0 && Char.IsWhiteSpace(message[0])) {
            if (channel == "stdout") level = stdoutLevel; else if (channel == "stderr") level = stderrLevel; else level = launcherLevel;
        }
        if (channel == "stdout") stdoutLevel = level; else if (channel == "stderr") stderrLevel = level; else launcherLevel = level;
        return level;
    }

    private static string StripTag(string message) {
        if (message.StartsWith("[OCX:INFO]")) return message.Substring(10).TrimStart();
        if (message.StartsWith("[OCX:WARN]")) return message.Substring(10).TrimStart();
        if (message.StartsWith("[OCX:ERROR]")) return message.Substring(11).TrimStart();
        return message;
    }

    private static string StripAnsi(string message) {
        return Regex.Replace(message, "\\x1B\\[[0-?]*[ -/]*[@-~]", String.Empty);
    }

    private static void Render(string level, string message) {
        ConsoleColor color = level == "ERROR" ? ConsoleColor.Red : (level == "WARN" ? ConsoleColor.Yellow : ConsoleColor.Gray);
        Console.ForegroundColor = ConsoleColor.DarkGray; Console.Write(" " + DateTime.Now.ToString("HH:mm:ss") + "  ");
        Console.ForegroundColor = color; Console.Write(level.PadRight(5) + " "); Console.WriteLine(message); Console.ResetColor();
    }
}
'@
    }
}

function Start-VisiblePipePump {
    param(
        [Parameter(Mandatory)][System.IO.Stream]$StandardOutput,
        [Parameter(Mandatory)][System.IO.Stream]$StandardError,
        [Parameter(Mandatory)][string]$LogPath,
        [Parameter(Mandatory)][string]$DisplayLevel
    )
    Initialize-VisiblePipePumpType
    $pump = New-Object OcxVisiblePipePump($StandardOutput, $StandardError, $LogPath, $DisplayLevel)
    $pump.Start()
    return $pump
}

function Invoke-VisibleProxy {
    param(
        [Parameter(Mandatory)][string]$BunPath,
        [Parameter(Mandatory)][string]$CliPath,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][string]$LogPath,
        [Parameter(Mandatory)][int]$ListenPort,
        [Parameter(Mandatory)][string]$OpenCodexDirectory,
        [Parameter(Mandatory)][string]$CodexDirectory,
        [scriptblock]$OnStarted
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $BunPath
    $preloadPath = Join-Path $WorkingDirectory 'scripts\windows-visible-log-preload.ts'
    if (-not (Test-Path -LiteralPath $preloadPath -PathType Leaf)) { throw 'Visible log preload is missing.' }
    $startInfo.Arguments = ('--preload "{0}" "{1}" start --port {2}' -f $preloadPath, $CliPath, $ListenPort)
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $startInfo.EnvironmentVariables["OPENCODEX_HOME"] = $OpenCodexDirectory
    $startInfo.EnvironmentVariables["CODEX_HOME"] = $CodexDirectory
    $startInfo.EnvironmentVariables["HTTP_PROXY"] = "http://127.0.0.1:7890"
    $startInfo.EnvironmentVariables["HTTPS_PROXY"] = "http://127.0.0.1:7890"
    $startInfo.EnvironmentVariables["ALL_PROXY"] = "socks5://127.0.0.1:7891"
    $startInfo.EnvironmentVariables["NO_PROXY"] = "localhost,127.0.0.1,::1"
    $startInfo.EnvironmentVariables["OPENCODEX_RUNTIME_DIAGNOSTICS"] = "1"
    $startInfo.EnvironmentVariables["OPENCODEX_CODEX_UPSTREAM_TRANSPORT"] = "http-sse"
    [void]$startInfo.EnvironmentVariables.Remove("OCX_SERVICE")

    $child = New-Object System.Diagnostics.Process
    $child.StartInfo = $startInfo
    # JIT-compile the reader before the child exists. Otherwise a chatty child
    # could fill its pipe while Add-Type is compiling and recreate startup
    # backpressure before the dedicated reader thread gets a chance to run.
    Initialize-VisiblePipePumpType
    if (-not $child.Start()) {
        throw "Unable to start the local Bun runtime."
    }

    $childPid = $child.Id
    # Start the reader immediately after Process.Start. It is separate from the
    # visible console and disk writer, so neither can pause pipe draining.
    $pump = Start-VisiblePipePump -StandardOutput $child.StandardOutput.BaseStream -StandardError $child.StandardError.BaseStream -LogPath $LogPath -DisplayLevel $ConsoleLevel
    Write-LauncherLifecycleEvent -OpenCodexDirectory $OpenCodexDirectory -EventName 'proxy-child-started' -ChildPid $childPid
    Show-VisibleHeader -Mode ("OWNER PID {0}" -f $childPid) -ListenPort $ListenPort
    # The pipe pump owns this transcript from here until it has drained. Never
    # append/rotate on the PowerShell thread concurrently with its writer.
    $pump.QueueLauncher(("started PID {0}; port={1}" -f $childPid, $ListenPort))
    if ($null -ne $OnStarted) { & $OnStarted }
    $child.WaitForExit()
    $exitCode = $child.ExitCode
    Write-LauncherLifecycleEvent -OpenCodexDirectory $OpenCodexDirectory -EventName 'proxy-child-exited' -ChildPid $childPid -ExitCode $exitCode
    $exitLevel = if ($exitCode -eq 0) { 'WARN' } else { 'ERROR' }
    $exitCodeHex = '0x{0:X8}' -f [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$exitCode), 0)
    $pump.QueueLauncher(("[OCX:{0}] PID {1} exited with code {2} ({3}); automatic restart is disabled." -f $exitLevel, $childPid, $exitCode, $exitCodeHex))
    # Once the child has exited, bounded flushing no longer risks its liveness.
    # Give the writer a finite grace period for ordinary slow storage; if it
    # cannot finish, say so visibly and preserve the child exit in lifecycle.
    $pumpState = $pump.StopAndDescribe(5000)
    if ($pumpState -match 'recordDrops=([1-9]\d*)') {
        Write-LauncherLifecycleEvent -OpenCodexDirectory $OpenCodexDirectory -EventName 'proxy-transcript-overflow-unflushed' -ChildPid $childPid -ExitCode $exitCode -Detail ("droppedRecords=" + $Matches[1])
    }
    if ($pumpState -match 'consoleDrops=([1-9]\d*)') {
        Write-LauncherLifecycleEvent -OpenCodexDirectory $OpenCodexDirectory -EventName 'proxy-visible-console-overflow' -ChildPid $childPid -ExitCode $exitCode -Detail ("droppedRows=" + $Matches[1])
        Write-VisibleConsole -Channel stderr -Message ("[OCX:WARN] Visible console skipped {0} rows; the transcript is the source of truth." -f $Matches[1])
    }
    if ($pumpState -match 'consoleFailures=([1-9]\d*)') {
        Write-LauncherLifecycleEvent -OpenCodexDirectory $OpenCodexDirectory -EventName 'proxy-visible-console-failed' -ChildPid $childPid -ExitCode $exitCode -Detail ("failures=" + $Matches[1])
        Write-VisibleConsole -Channel stderr -Message '[OCX:ERROR] Visible console writer failed; consult the transcript and lifecycle event log.'
    }
    if ($pumpState -match 'writerStopped=False') {
        Write-LauncherLifecycleEvent -OpenCodexDirectory $OpenCodexDirectory -EventName 'proxy-transcript-drain-timeout' -ChildPid $childPid -ExitCode $exitCode
        Write-VisibleConsole -Channel stderr -Message '[OCX:ERROR] Transcript writer did not drain within 5 seconds after child exit; on-disk transcript may be incomplete.'
    }
    $child.Dispose()
    return $exitCode
}

try {
    $script:LauncherFailurePhase = 'path-validation'
    $ProjectRoot = Resolve-AbsolutePath $ProjectRoot
    $OpenCodexHome = Resolve-AbsolutePath $OpenCodexHome
    $CodexHome = Resolve-AbsolutePath $CodexHome
    $bunPath = Join-Path $ProjectRoot "node_modules\\bun\\bin\\bun.exe"
    $cliPath = Join-Path $ProjectRoot "src\\cli\\index.ts"
    $logPath = Join-Path (Join-Path $OpenCodexHome "logs") $LogFileName

    Write-LauncherLifecycleEvent -OpenCodexDirectory $OpenCodexHome -EventName 'launcher-started'

    foreach ($path in @($ProjectRoot, $bunPath, $cliPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Container) -and -not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Required visible-launcher path is missing: $path"
        }
    }
    if (-not (Test-Path -LiteralPath $bunPath -PathType Leaf)) { throw "Bun runtime is not a file: $bunPath" }
    if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) { throw "OpenCodex CLI entry is not a file: $cliPath" }

    if ($CheckOnly) {
        Write-Host "Visible OpenCodex launcher check passed for port $Port."
        $script:LauncherExitCode = 0
        exit 0
    }

    $script:LauncherFailurePhase = 'guardian'
    Ensure-RecoveryGuardian -OpenCodexDirectory $OpenCodexHome -Root $ProjectRoot -EffectiveCodexHome $CodexHome -PrimaryPort $Port

    Disable-ConsoleQuickEdit

    $script:LauncherFailurePhase = 'ownership'
    $mutexName = Get-VisibleProxyMutexName -Root $ProjectRoot -ListenPort $Port
    $script:VisibleProxyMutex = New-Object System.Threading.Mutex($false, $mutexName)
    try {
        $script:OwnsVisibleProxyMutex = $script:VisibleProxyMutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $script:OwnsVisibleProxyMutex = $true
    }

    if ($Restart) {
        $script:RestartMutex = New-Object System.Threading.Mutex($false, "$mutexName.Restart")
        try {
            $script:OwnsRestartMutex = $script:RestartMutex.WaitOne(0)
        } catch [System.Threading.AbandonedMutexException] {
            $script:OwnsRestartMutex = $true
        }
        if (-not $script:OwnsRestartMutex) {
            throw "Another visible restart is already in progress for this project and port."
        }
    }

    $maintenanceIntentWritten = $false
    $script:LauncherFailurePhase = 'health'
    $healthyOpenCodex = Test-OpenCodexHealth -ListenPort $Port
    if ($healthyOpenCodex -and -not $Restart) {
        # An owner mutex is stronger evidence than a healthy port or an old log.
        if ($script:OwnsVisibleProxyMutex) {
            Release-VisibleProxyMutex
            Show-VisibleHeader -Mode 'BACKGROUND INSTANCE (not this window)' -ListenPort $Port
            Write-VisibleConsole -Channel stderr -Message '[OCX:WARN] Port is served outside the visible launcher. No new proxy was started. Check the existing service/manager before desktop migration.'
            if (-not $NoPause) { [void](Read-Host 'Press Enter to close this window') }
            $script:LauncherExitCode = 0
            exit 0
        }
        Release-VisibleProxyMutex
        Follow-ExistingLog -LogPath $logPath
        $script:LauncherExitCode = 0
        exit 0
    }

    if ($Restart -and $healthyOpenCodex) {
        # The maintenance fence is the final reversible preflight before a
        # real owner is stopped. Rejected foreign/mutex paths never alter it.
        $script:LauncherFailurePhase = 'recovery-intent'
        Set-RecoveryIntent -OpenCodexDirectory $OpenCodexHome -Mode "maintenance" -Until ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 180000)
        $maintenanceIntentWritten = $true
        $script:LauncherFailurePhase = 'stop'
        Write-Host "A healthy OpenCodex listener was confirmed on port $Port. Requesting a normal project CLI stop before visible restart..."
        Invoke-ProjectCliStop -BunPath $bunPath -CliPath $cliPath -WorkingDirectory $ProjectRoot -OpenCodexDirectory $OpenCodexHome -CodexDirectory $CodexHome
        Wait-ForOpenCodexToStop -ListenPort $Port
        if (-not $script:OwnsVisibleProxyMutex) {
            Acquire-VisibleProxyMutexAfterStop
        }
    } elseif (-not $healthyOpenCodex) {
        if (Test-LoopbackPortOccupied -ListenPort $Port) {
            throw "Port $Port is occupied but did not identify as OpenCodex; refusing to launch or select another port."
        }
        if (-not $script:OwnsVisibleProxyMutex) {
            throw "Another visible launcher for this project and port is still active. It did not report a healthy OpenCodex listener, so this launcher will not race it."
        }
    }

    # A listener can appear after the health probe; reject that exact race rather than relying on
    # CLI fallback behavior that could choose a different port.
    if (Test-LoopbackPortOccupied -ListenPort $Port) {
        throw "Port $Port became occupied before visible launch; no fallback port will be selected."
    }

    if ($Restart -and -not $maintenanceIntentWritten) {
        # Cold restart reaches here only after every refusal check; fence it
        # immediately before the new visible child can be started.
        $script:LauncherFailurePhase = 'recovery-intent'
        Set-RecoveryIntent -OpenCodexDirectory $OpenCodexHome -Mode "maintenance" -Until ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 180000)
    } elseif (-not $Restart) {
        $script:LauncherFailurePhase = 'recovery-intent'
        Set-RecoveryIntent -OpenCodexDirectory $OpenCodexHome -Mode "running"
    }
    $onStarted = $null
    if ($Restart) {
        $onStarted = {
            Set-RecoveryIntent -OpenCodexDirectory $OpenCodexHome -Mode "running"
            Release-RestartMutex
        }
    }
    $script:LauncherFailurePhase = 'proxy-start'
    $exitCode = Invoke-VisibleProxy -BunPath $bunPath -CliPath $cliPath -WorkingDirectory $ProjectRoot -LogPath $logPath -ListenPort $Port -OpenCodexDirectory $OpenCodexHome -CodexDirectory $CodexHome -OnStarted $onStarted
    if ($exitCode -ne 0) {
        Release-VisibleProxyMutex
        Release-RestartMutex
        Wait-ForFailureAcknowledgement
        $script:LauncherExitCode = $exitCode
        exit $exitCode
    }

    # Invoke-VisibleProxy already queued the terminal transcript record. Do not
    # race a still-draining pump with a second PowerShell append/rotation here.
    Write-VisibleConsole -Channel "launcher" -Message "OpenCodex exited normally; automatic restart is disabled."
    Release-VisibleProxyMutex
    Release-RestartMutex
    Wait-ForFailureAcknowledgement
    $script:LauncherExitCode = 0
    exit 0
} catch {
    $script:LauncherExitCode = 1
    if (-not [string]::IsNullOrWhiteSpace($OpenCodexHome)) {
        $baseType = $_.Exception.GetBaseException().GetType().Name
        if ($baseType -notmatch '^[A-Za-z0-9_.]{1,128}$') { $baseType = 'UnknownException' }
        $line = $_.InvocationInfo.ScriptLineNumber
        if ($line -lt 0 -or $line -gt 1000000) { $line = 0 }
        $phase = $script:LauncherFailurePhase
        if ($phase -notin @('initialization', 'path-validation', 'guardian', 'ownership', 'health', 'recovery-intent', 'stop', 'proxy-start')) { $phase = 'unknown' }
        $hresult = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$_.Exception.GetBaseException().HResult), 0)
        $detail = 'phase={0};base={1};hresult=0x{2:X8};line={3}' -f $phase, $baseType, $hresult, $line
        Write-LauncherLifecycleEvent -OpenCodexDirectory $OpenCodexHome -EventName 'launcher-failed' -ExitCode 1 -FailureKind ($_.Exception.GetType().Name) -Detail $detail
    }
    Write-VisibleConsole -Channel stderr -Message ("[OCX:ERROR] Visible launcher failed: {0}" -f $_.Exception.Message)
    Release-VisibleProxyMutex
    Release-RestartMutex
    Wait-ForFailureAcknowledgement
    exit 1
} finally {
    if (-not [string]::IsNullOrWhiteSpace($OpenCodexHome)) {
        Write-LauncherLifecycleEvent -OpenCodexDirectory $OpenCodexHome -EventName 'launcher-exited' -ExitCode $script:LauncherExitCode
    }
    Release-VisibleProxyMutex
    Release-RestartMutex
    if ($null -ne $script:VisibleProxyMutex) { $script:VisibleProxyMutex.Dispose() }
    if ($null -ne $script:RestartMutex) { $script:RestartMutex.Dispose() }
}
