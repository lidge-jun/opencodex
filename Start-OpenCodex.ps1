[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 10100,

  [ValidateRange(1, 120)]
  [int]$StartupTimeoutSeconds = 30,

  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$repoRoot = $PSScriptRoot
$dashboardUrl = "http://127.0.0.1:$Port/"
$healthUrl = "${dashboardUrl}healthz"
$logDirectory = Join-Path $repoRoot ".tmp"
$stdoutLog = Join-Path $logDirectory "launcher.out.log"
$stderrLog = Join-Path $logDirectory "launcher.err.log"

function Get-OpenCodexHealth {
  try {
    $response = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
    if ($response.service -eq "opencodex" -and $response.status -eq "ok") {
      return $response
    }
  }
  catch {
    return $null
  }

  return $null
}

function Open-Dashboard {
  if (-not $NoBrowser) {
    Start-Process $dashboardUrl
  }
}

function Test-IsLocalCheckoutProcess {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  try {
    $runningProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
    if ($null -eq $runningProcess) {
      return $false
    }

    $checkoutPrefix = $repoRoot.TrimEnd('\', '/') + '\'
    if (-not [string]::IsNullOrWhiteSpace($runningProcess.ExecutablePath) -and
        $runningProcess.ExecutablePath.StartsWith($checkoutPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }

    if ([string]::IsNullOrWhiteSpace($runningProcess.CommandLine)) {
      return $false
    }

    $expectedEntryPoint = Join-Path $repoRoot "src\cli\index.ts"
    return $runningProcess.CommandLine.IndexOf($expectedEntryPoint, [StringComparison]::OrdinalIgnoreCase) -ge 0
  }
  catch {
    return $false
  }
}

$localBunExecutable = Join-Path $repoRoot "node_modules\bun\bin\bun.exe"
$bunApplication = Get-Command bun.exe -CommandType Application -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $localBunExecutable) {
  $bunExecutable = $localBunExecutable
}
elseif ($null -ne $bunApplication) {
  $bunExecutable = $bunApplication.Source
}
else {
  throw "Bun was not found. Install Bun from https://bun.sh, then run this launcher again."
}

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules"))) {
  throw "Dependencies are missing. Open PowerShell in '$repoRoot', run 'bun install', then try again."
}

$existingHealth = Get-OpenCodexHealth
if ($null -ne $existingHealth) {
  if (Test-IsLocalCheckoutProcess -ProcessId $existingHealth.pid) {
    Write-Host "This OpenCodex checkout is already running on port $Port (PID $($existingHealth.pid))."
    Open-Dashboard
    exit 0
  }

  Write-Host "A different OpenCodex installation is using port $Port (PID $($existingHealth.pid))."
  Write-Host "Stopping it before starting this checkout..."
  & $bunExecutable run src/cli/index.ts stop
  if ($LASTEXITCODE -ne 0) {
    throw "The existing OpenCodex instance could not be stopped safely."
  }

  $stopDeadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $existingHealth = Get-OpenCodexHealth
  } while ($null -ne $existingHealth -and (Get-Date) -lt $stopDeadline)

  if ($null -ne $existingHealth) {
    throw "The previous OpenCodex instance is still using port $Port."
  }
}

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

Write-Host "Starting OpenCodex on port $Port..."
$process = Start-Process `
  -FilePath $bunExecutable `
  -ArgumentList @("run", "src/cli/index.ts", "start", "--port", "$Port") `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
do {
  Start-Sleep -Milliseconds 250
  $process.Refresh()

  $health = Get-OpenCodexHealth
  if ($null -ne $health) {
    if (-not (Test-IsLocalCheckoutProcess -ProcessId $health.pid)) {
      throw "Port $Port became healthy, but it belongs to a different OpenCodex installation."
    }
    Write-Host "OpenCodex is ready at $dashboardUrl (PID $($health.pid))."
    Open-Dashboard
    exit 0
  }

  if ($process.HasExited) {
    throw "OpenCodex stopped during startup (exit code $($process.ExitCode)). See '$stderrLog'."
  }
} while ((Get-Date) -lt $deadline)

throw "OpenCodex did not become ready within $StartupTimeoutSeconds seconds. See '$stderrLog'."
