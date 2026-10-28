# Verify the Authenticode signatures of the Windows release binaries (#7207). Built-in tools only:
# Get-AuthenticodeSignature, msiexec administrative extraction, and the Windows SDK signtool that
# the GitHub-hosted Windows image already carries.
#
#   -Path             PE files (or MSIs) to verify directly.
#   -Msi              An installer to verify, together with every .exe it installs. The MSI's own
#                     signature must pass before "msiexec /a" expands it (an administrative
#                     image, nothing is installed).
#   -RequireInnerExe  File names that must be among the executables inside -Msi; a sweep that
#                     finds fewer files than expected must not pass by inspecting nothing.
#   -MinimumInnerExe  The fewest executables -Msi may contain (default 1).
#   -Trust release    A production signature: Status Valid, a SignPath Foundation signer, an RFC
#                     3161 timestamp, and "signtool verify /pa" succeeding. Fails closed.
#   -Trust test       A test-signing run: the self-signed test root is untrusted on the runner, so
#                     the chain cannot validate. Every file must still carry a signature whose hash
#                     matches, and all of them must share one signer.
[CmdletBinding()]
param(
  [string[]]$Path = @(),
  [string]$Msi = "",
  [string[]]$RequireInnerExe = @(),
  [int]$MinimumInnerExe = 1,
  [Parameter(Mandatory = $true)][ValidateSet("release", "test")][string]$Trust
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$targets = [System.Collections.Generic.List[string]]::new()
foreach ($candidate in $Path) {
  $targets.Add((Resolve-Path -LiteralPath $candidate).Path)
}

$msiPath = ""
if ($Msi) {
  $msiPath = (Resolve-Path -LiteralPath $Msi).Path
}

if ($targets.Count -eq 0 -and -not $msiPath) {
  throw "Nothing to verify: pass -Path and/or -Msi."
}

$signtool = $null
if ($Trust -eq "release") {
  $signtool = Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $signtool) { throw "signtool.exe was not found in the Windows SDK on this runner." }
  Write-Host "Using $($signtool.FullName)"
}

# Statuses a test-signing signature may legitimately report on a runner that does not trust the
# self-signed test root. HashMismatch, NotSigned and every other status fail in both modes.
$testStatuses = @("Valid", "UnknownError", "NotTrusted")
$thumbprints = [System.Collections.Generic.HashSet[string]]::new()
$failures = [System.Collections.Generic.List[string]]::new()
$verified = 0

# Record the signature outcome for one file. A certificate is always required; everything else
# depends on the trust mode. Failures accumulate so one run reports every bad file.
function Test-AuthenticodeFile {
  param([string]$Target)
  $signature = Get-AuthenticodeSignature -LiteralPath $Target
  $certificate = $signature.SignerCertificate
  $status = [string]$signature.Status
  if (-not $certificate) {
    $failures.Add("$Target carries no Authenticode signature (status $status)")
    return
  }
  $stamp = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { "none" }
  Write-Host "$Target"
  Write-Host "  status: $status; signer: $($certificate.Subject); thumbprint: $($certificate.Thumbprint); timestamp: $stamp"
  [void]$thumbprints.Add($certificate.Thumbprint)

  if ($Trust -eq "release") {
    if ($status -ne "Valid") {
      $failures.Add("$Target is signed but not trusted (status ${status}: $($signature.StatusMessage))")
    }
    if ($certificate.Subject -notmatch '(^|,\s*)CN="?SignPath Foundation"?(,|$)') {
      $failures.Add("$Target is signed by '$($certificate.Subject)', not SignPath Foundation")
    }
    if (-not $signature.TimeStamperCertificate) {
      $failures.Add("$Target has no timestamp, so its signature expires with the certificate")
    }
    & $signtool.FullName verify /pa /v "$Target" | Write-Host
    if ($LASTEXITCODE -ne 0) {
      $failures.Add("signtool verify /pa rejected $Target (exit code $LASTEXITCODE)")
    }
  } elseif ($testStatuses -notcontains $status) {
    $failures.Add("$Target has an unusable test signature (status ${status}: $($signature.StatusMessage))")
  }
  $script:verified += 1
}

# Stop before any further work once a recorded file failed. Callers see the throw and keep the
# unsigned original; an MSI that failed is never handed to msiexec below.
function Assert-AuthenticodeVerified {
  if ($failures.Count -gt 0) {
    foreach ($failure in $failures) { Write-Host "FAILED: $failure" }
    # throw, not exit: a caller that runs this script and then another command would otherwise see
    # the second command's exit code and carry on. No annotation here; the caller decides whether a
    # failure is a warning (a release that ships unsigned) or an error (the signing test).
    throw "Authenticode verification failed: $($failures -join '; ')"
  }
}

if ($msiPath) {
  # "msiexec /a" makes the Windows Installer engine parse the package, so the installer itself
  # must pass the same signature contract as the files it carries before extraction may run.
  Test-AuthenticodeFile $msiPath
  Assert-AuthenticodeVerified

  $scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("ocx-msi-" + [guid]::NewGuid().ToString("N"))
  $image = Join-Path $scratch "image"
  $log = Join-Path $scratch "administrative-image.log"
  New-Item -ItemType Directory -Path $image -Force | Out-Null
  $arguments = @("/a", "`"$msiPath`"", "/qn", "TARGETDIR=`"$image`"", "/l*v", "`"$log`"")
  $process = Start-Process -FilePath "msiexec.exe" -ArgumentList $arguments -Wait -PassThru -NoNewWindow
  if ($process.ExitCode -ne 0) {
    if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 40 | Write-Host }
    throw "msiexec /a could not expand $msiPath (exit code $($process.ExitCode))"
  }
  $inner = @(Get-ChildItem -LiteralPath $image -Recurse -File -Filter "*.exe")
  Write-Host "The installer carries $($inner.Count) executable(s): $(($inner | ForEach-Object Name) -join ', ')"
  if ($inner.Count -lt [Math]::Max(1, $MinimumInnerExe)) {
    throw "Found $($inner.Count) executable(s) inside $msiPath, expected at least $MinimumInnerExe; the sweep would miss files."
  }
  foreach ($name in $RequireInnerExe) {
    if (-not ($inner | Where-Object { $_.Name -ieq $name })) {
      throw "$name is missing from the administrative image of $msiPath"
    }
  }
  foreach ($file in $inner) { $targets.Add($file.FullName) }
}

foreach ($target in $targets) {
  Test-AuthenticodeFile $target
}

# One signing request per artifact signs every file with the same certificate. A second signer
# means a file arrived already signed by somebody else, which the policy forbids re-signing.
if ($thumbprints.Count -gt 1) {
  $failures.Add("Expected one signer across every file, found $($thumbprints.Count): $($thumbprints -join ', ')")
}

Assert-AuthenticodeVerified
Write-Host "Verified $verified file(s) with $Trust trust."
