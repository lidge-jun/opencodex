param(
  [Parameter(Mandatory = $true)][string]$OpenCodexHome,
  [Parameter(Mandatory = $true)][ValidateSet('running', 'stopped', 'maintenance')][string]$Mode,
  [long]$Until = 0
)

$ErrorActionPreference = 'Stop'
$maxBytes = 16KB

function Assert-RecoveryIntentPath([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  # Windows PowerShell binds -or and -and left-to-right at equal precedence, so
  # the reparse test must be parenthesised or a small symlink fails open.
  if ((([int]$item.Attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0) -or ((-not $item.PSIsContainer) -and ($item.Length -gt $maxBytes))) {
    throw 'Recovery guardian marker is malformed; manual lifecycle action was not dispatched.'
  }
  return $item
}

function Test-RecoveryGuardianEnabled([string]$OcHome) {
  $homeItem = Assert-RecoveryIntentPath $OcHome
  if (-not $homeItem.PSIsContainer) { throw 'Recovery guardian marker is malformed; manual lifecycle action was not dispatched.' }
  $markerPath = Join-Path $OcHome 'recovery-guardian.json'
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { return $false }
  $markerItem = Assert-RecoveryIntentPath $markerPath
  try { $marker = [System.IO.File]::ReadAllText($markerItem.FullName, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Recovery guardian marker is malformed; manual lifecycle action was not dispatched.' }
  if ($marker.version -eq 1 -and $marker.enabled -is [bool] -and -not $marker.enabled) { return $false }
  if ($marker.version -ne 1 -or -not ($marker.enabled -is [bool]) -or -not $marker.enabled) { throw 'Recovery guardian marker is malformed; manual lifecycle action was not dispatched.' }
  return $true
}

if (Test-RecoveryGuardianEnabled $OpenCodexHome) {
  $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($Mode -ne 'maintenance') {
    if ($Until -ne 0) { throw 'Recovery intent maintenance deadline is invalid.' }
  } elseif ($Until -le $at -or $Until -gt ($at + 180000)) {
    # Same contract as parseIntent in main.cjs: at < until <= at + 180000. A
    # reader decodes any other maintenance intent as 'stopped', which fences all
    # gateway traffic and refuses recovery, so an out-of-window deadline must
    # never be persisted.
    throw 'Recovery intent maintenance deadline is invalid.'
  }

  $intentPath = Join-Path $OpenCodexHome 'recovery-intent.json'
  if (Test-Path -LiteralPath $intentPath) { $null = Assert-RecoveryIntentPath $intentPath }
  $intent = [ordered]@{ version = 1; mode = $Mode; at = $at }
  if ($Mode -eq 'maintenance') { $intent.until = $Until }
  $tmpPath = Join-Path $OpenCodexHome ('.recovery-intent.' + $PID + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [System.IO.File]::WriteAllText($tmpPath, ($intent | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $intentPath) {
      # PowerShell converts a literal $null here to an empty String for the
      # overloaded .NET call, which Windows rejects as an invalid backup path.
      # NullString preserves the native optional-backup sentinel and keeps the
      # replacement atomic when a prior intent already exists.
      [System.IO.File]::Replace($tmpPath, $intentPath, [System.Management.Automation.Language.NullString]::Value, $true)
    } else {
      [System.IO.File]::Move($tmpPath, $intentPath)
    }
  } finally {
    if (Test-Path -LiteralPath $tmpPath) { Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue }
  }
}
