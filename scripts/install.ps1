#Requires -Version 5.1
$ErrorActionPreference = "Stop"

Write-Host "Installing opencodex..." -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js 18+ is required. Install Node from https://nodejs.org/ and rerun this script."
    exit 1
}

$nodeVersion = & node -p "process.versions.node"
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt 18) {
    Write-Error "Node.js 18+ is required. Current version: v$nodeVersion"
    exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "npm is required to install the published opencodex package."
    exit 1
}

Write-Host "Using Node v$nodeVersion"

# Install opencodex globally
# If npm reports "install scripts blocked" for bun, rerun as:
#   npm install -g --allow-scripts=bun @bitkyc08/opencodex
# (use an elevated PowerShell if the original install was elevated)
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
    $npm = Get-Command npm -ErrorAction Stop
}
& $npm.Source install -g @bitkyc08/opencodex
if ($LASTEXITCODE -ne 0) {
    Write-Error "npm install failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

$ocx = Get-Command ocx.cmd -ErrorAction SilentlyContinue
if (-not $ocx) {
    $ocx = Get-Command ocx -ErrorAction SilentlyContinue
}
if (-not $ocx) {
    $npmPrefix = & $npm.Source prefix -g
    Write-Error "opencodex installed, but 'ocx' is not on PATH. Add your npm global bin directory to PATH, then reopen PowerShell: $npmPrefix"
    exit 1
}

& $ocx.Source help *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Error "opencodex installed, but 'ocx.cmd help' failed with exit code $LASTEXITCODE. Check your npm global install and PATH."
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "opencodex installed! Run 'ocx init' to set up." -ForegroundColor Green
