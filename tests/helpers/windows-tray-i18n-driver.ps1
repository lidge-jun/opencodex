# Behavioral driver for the tray's locale selection.
#
# Loads the REAL Test-TrayChineseCulture / Get-TrayText / Complete-PendingAction out of
# src/tray/windows-tray.ps1 via the PowerShell AST (function definitions only - the top-level tray
# UI never runs) and reports what each culture actually renders and notifies. A selector or a
# notification that always answered English would pass a source-text check and fail here.
param(
  [Parameter(Mandatory = $true)][string]$TrayScriptPath,
  [Parameter(Mandatory = $true)][string]$ResultPath
)
$ErrorActionPreference = "Stop"

# Complete-PendingAction names ToolTipIcon in its balloon call. The tray script loads WinForms at
# its top level, which this driver never runs, so load it here for the enum to resolve.
Add-Type -AssemblyName System.Windows.Forms

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($TrayScriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "tray script parse failed: $($parseErrors[0].Message)" }
$wanted = @(
  "Test-TrayChineseCulture",
  "Get-TrayText",
  "Complete-PendingAction"
)
$definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
$loaded = @()
foreach ($fn in $definitions) {
  if ($wanted -contains $fn.Name) {
    # Dot-source the full definition extent so each function is defined exactly as the tray
    # script declares it, params included.
    . ([ScriptBlock]::Create($fn.Extent.Text))
    $loaded += $fn.Name
  }
}
$missing = @($wanted | Where-Object { $loaded -notcontains $_ })
if ($missing.Count -gt 0) { throw "tray script is missing functions: $($missing -join ', ')" }

# The action log is a file append the driver has no use for; the notification is what it asserts.
function Write-ActionLog([string]$Message) { }

$cultureDecisions = [ordered]@{}
foreach ($name in @("zh-CN", "zh-TW", "zh-Hans", "en-US", "ja-JP", "")) {
  $cultureDecisions[$name] = [bool](Test-TrayChineseCulture $name)
}

$rendered = [ordered]@{}
foreach ($isZh in @($false, $true)) {
  $script:isZh = $isZh
  $rendered[$(if ($isZh) { "zh" } else { "en" })] = [ordered]@{
    open = Get-TrayText "Open Dashboard" "打开面板"
    start = Get-TrayText "Start Proxy" "启动代理"
    restart = Get-TrayText "Restart Proxy" "重启代理"
    exit = Get-TrayText "Exit Tray" "退出托盘"
    status = Get-TrayText "opencodex: Online" "opencodex: 在线"
  }
}

# Capture what Complete-PendingAction actually shows. The WinForms NotifyIcon is replaced by a
# stub that records each balloon tip, so both completion branches are asserted as rendered text
# rather than as script source.
$global:trayNotifications = New-Object System.Collections.ArrayList
$notify = New-Object PSObject
$notify | Add-Member -MemberType ScriptMethod -Name ShowBalloonTip -Value {
  param($timeout, $title, $text, $icon)
  [void]$global:trayNotifications.Add([ordered]@{ title = $title; text = $text })
}

$notifications = [ordered]@{}
foreach ($isZh in @($false, $true)) {
  $script:isZh = $isZh
  $script:port = 10100
  $script:proxyPid = 4242
  $script:pendingProcess = $null
  $perAction = [ordered]@{}
  foreach ($action in @("Start Proxy", "Stop Proxy", "Restart Proxy")) {
    $branch = [ordered]@{}
    foreach ($success in @($true, $false)) {
      $global:trayNotifications.Clear()
      $script:pendingAction = $action
      Complete-PendingAction $success
      $tip = $global:trayNotifications[0]
      $branch[$(if ($success) { "ok" } else { "fail" })] = [ordered]@{
        title = $tip.title
        text = $tip.text
      }
    }
    $perAction[$action] = $branch
  }
  $notifications[$(if ($isZh) { "zh" } else { "en" })] = $perAction
}

$result = [ordered]@{
  cultureDecisions = $cultureDecisions
  rendered = $rendered
  notifications = $notifications
}
[System.IO.File]::WriteAllText($ResultPath, ($result | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding($false)))
