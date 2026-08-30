# Start PaohupByPaoZa from this folder. Uses the same ~/.opencodex config as the original dashboard.
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Error "bun is required. Install from https://bun.sh then retry."
}
Write-Host "Starting PaohupByPaoZa on http://localhost:10100 ..."
bun run src/cli/index.ts start --port 10100
