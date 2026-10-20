# Swap a SignPath-signed Windows release file into place, or leave the unsigned original (#7207).
#
# Signing improves a release; it must never cost one. Everything that can fail runs against a
# staged copy first: the SignPath outcome, the returned file, the Authenticode verification, the
# signed binary's own start-up, and (for the installer) the Tauri updater signature over the
# signed bytes. Only when all of that succeeded are the files swapped in, and a failure during the
# swap restores the originals. The updater signature is regenerated because Authenticode signing
# rewrites the installer: a .sig over the unsigned bytes would fail verify-release and the updater.
#
#   -Target            The file in place (ocx.exe or the .msi in the Tauri bundle directory).
#   -SignedDirectory   Where the SignPath action extracted the signed artifact.
#   -SubmitOutcome     steps.<id>.outcome of the SignPath step; anything but success keeps the original.
#   -Trust             release or test; passed to verify-authenticode.ps1.
#   -Installer         Verify as an MSI, including every executable it installs.
#   -UpdaterSignature  Regenerate <msi>.sig with "tauri signer sign" when TAURI_SIGNING_PRIVATE_KEY is set.
#   -FailOnError       Throw instead of warning (the non-publishing signing test wants a red run).
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][string]$SignedDirectory,
  [string]$SubmitOutcome = "success",
  [Parameter(Mandatory = $true)][ValidateSet("release", "test")][string]$Trust,
  [switch]$Installer,
  [switch]$UpdaterSignature,
  [string]$TauriDirectory = "desktop",
  [switch]$FailOnError
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Outcome([string]$Line) {
  Write-Host $Line
  if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value "- $Line" }
}

$verifier = Join-Path $PSScriptRoot "verify-authenticode.ps1"
$targetPath = (Resolve-Path -LiteralPath $Target).Path
$name = Split-Path -Leaf $targetPath
$signaturePath = "$targetPath.sig"
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("ocx-signed-" + [guid]::NewGuid().ToString("N"))
$backup = Join-Path $stage "original"
$swapStarted = $false

try {
  if ($SubmitOutcome -ne "success") {
    throw "the SignPath signing request did not complete (outcome: $SubmitOutcome)"
  }
  $signed = Join-Path $SignedDirectory $name
  if (-not (Test-Path -LiteralPath $signed -PathType Leaf)) {
    throw "SignPath returned no $name at the artifact root"
  }
  $unsignedHash = (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash
  if ((Get-FileHash -LiteralPath $signed -Algorithm SHA256).Hash -eq $unsignedHash) {
    throw "the file SignPath returned is byte-identical to the unsigned one"
  }

  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  $staged = Join-Path $stage $name
  Copy-Item -LiteralPath $signed -Destination $staged

  if ($Installer) {
    & $verifier -Msi $staged -RequireInnerExe "ocx.exe" -MinimumInnerExe 2 -Trust $Trust
  } else {
    & $verifier -Path $staged -Trust $Trust
    & $staged --version
    if ($LASTEXITCODE -ne 0) { throw "the signed $name failed to run (exit code $LASTEXITCODE)" }
  }

  $stagedSignature = "$staged.sig"
  if ($UpdaterSignature -and $env:TAURI_SIGNING_PRIVATE_KEY) {
    Push-Location -LiteralPath $TauriDirectory
    try {
      & bunx tauri signer sign "$staged"
      if ($LASTEXITCODE -ne 0) { throw "tauri signer sign failed (exit code $LASTEXITCODE)" }
    } finally {
      Pop-Location
    }
    if (-not (Test-Path -LiteralPath $stagedSignature -PathType Leaf)) {
      throw "tauri signer sign wrote no $name.sig"
    }
  }

  Copy-Item -LiteralPath $targetPath -Destination (Join-Path $backup $name)
  if (Test-Path -LiteralPath $signaturePath) {
    Copy-Item -LiteralPath $signaturePath -Destination (Join-Path $backup "$name.sig")
  }
  $swapStarted = $true
  Copy-Item -LiteralPath $staged -Destination $targetPath -Force
  if (Test-Path -LiteralPath $signaturePath) { Remove-Item -LiteralPath $signaturePath -Force }
  if (Test-Path -LiteralPath $stagedSignature) {
    Copy-Item -LiteralPath $stagedSignature -Destination $signaturePath
  }
  Write-Outcome "$name is Authenticode-signed ($Trust trust)."
} catch {
  $reason = $_.Exception.Message
  if ($swapStarted) {
    Copy-Item -LiteralPath (Join-Path $backup $name) -Destination $targetPath -Force
    if (Test-Path -LiteralPath $signaturePath) { Remove-Item -LiteralPath $signaturePath -Force }
    $originalSignature = Join-Path $backup "$name.sig"
    if (Test-Path -LiteralPath $originalSignature) {
      Copy-Item -LiteralPath $originalSignature -Destination $signaturePath
    }
  }
  if ($FailOnError) { throw }
  Write-Host "::warning::$name ships unsigned: $reason"
  Write-Outcome "$name ships unsigned: $reason"
}
