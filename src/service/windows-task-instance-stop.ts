import { TASK } from "./state";
import { windowsTaskRegistrationMatchesForStop } from "./windows-taskxml";

/**
 * Keep the registered task and captured IRunningTask objects in one COM session.
 * Send the Unicode XML and caller identity to the existing validator through an ASCII
 * line, then wait for its decision. Only the captured instances can receive Stop().
 */
export const WINDOWS_TASK_INSTANCE_STOP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
$attempted = $false
try {
  [Console]::OutputEncoding = [Text.Encoding]::ASCII
  Import-Module ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -Force
  $name = '${TASK}'
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User.Value
  if (!$sid) { 'unverified-registration'; return }
  $account = $null
  try { $account = $identity.Name } catch { }
  $service = Microsoft.PowerShell.Utility\New-Object -ComObject Schedule.Service
  $service.Connect()
  $folder = $service.GetFolder('\')
  $task = $folder.GetTask($name)
  $xml = [string]$task.Xml
  $instances = $task.GetInstances(0)
  if ($null -eq $instances) { 'unverified-registration'; return }
  $verified = @()
  $count = $instances.Count
  if ($null -eq $count) { 'unverified-registration'; return }
  if ($count -gt 0) {
    Import-Module ([IO.Path]::Combine($PSHOME,'Modules','CimCmdlets','CimCmdlets.psd1')) -Force
  }
  for ($index = 1; $index -le $count; $index++) {
    $instance = $instances.Item($index)
    $instance.Refresh()
    $id = [Guid]$instance.InstanceGuid
    $enginePid = [uint32]$instance.EnginePID
    if ($id -eq [Guid]::Empty -or !$enginePid -or $instance.State -ne 4) { 'unverified-registration'; return }
    $engine = CimCmdlets\Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $enginePid) -OperationTimeoutSec 1
    if (!$engine.CreationDate) { 'unverified-registration'; return }
    $owner = CimCmdlets\Invoke-CimMethod -InputObject $engine -MethodName GetOwnerSid -OperationTimeoutSec 1
    $after = CimCmdlets\Get-CimInstance -InputObject $engine -OperationTimeoutSec 1
    if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $sid -or $after.CreationDate -ne $engine.CreationDate) {
      'unverified-registration'; return
    }
    $verified += @{ Instance = $instance; Id = $id; EnginePid = $enginePid }
  }

  $proof = Microsoft.PowerShell.Utility\ConvertTo-Json -Compress -InputObject @{ xml = $xml; sid = $sid; name = $account }
  $utf8 = [Text.UTF8Encoding]::new($false, $true)
  [Console]::WriteLine([Convert]::ToBase64String($utf8.GetBytes($proof)))
  if ([Console]::ReadLine() -cne 'stop') { 'unverified-registration'; return }

  # Resolve the path afresh only to detect a changed registration. It is never a stop target.
  $current = $folder.GetTask($name)
  if (![string]::Equals($xml, [string]$current.Xml, [StringComparison]::Ordinal)) { 'unverified-registration'; return }
  if ($count -eq 0) {
    # Ready or disabled; an empty collection can also mean instances were hidden by ACLs.
    if ($current.State -in @(1, 3)) { 'not-running' } else { 'unverified-registration' }
    return
  }
  foreach ($target in $verified) {
    $target.Instance.Refresh()
    if ([Guid]$target.Instance.InstanceGuid -ne $target.Id -or
        $target.Instance.EnginePID -ne $target.EnginePid -or $target.Instance.State -ne 4) {
      'unverified-registration'; return
    }
  }
  foreach ($target in $verified) {
    $attempted = $true
    $target.Instance.Stop()
  }
  'ended'
} catch {
  for ($cause = $_.Exception; $null -ne $cause; $cause = $cause.InnerException) {
    if ($cause.HResult -eq -2147024891) { 'denied'; return } # E_ACCESSDENIED
  }
  if ($attempted) { 'failed' } else { 'unverified-registration' }
}
`;

/** Compare exactly against the existing XML policy, using the same helper's Windows token. */
export function verifyWindowsTaskStopProof(line: string, launcher: string): boolean {
  try {
    const bytes = Buffer.from(line, "base64");
    if (bytes.toString("base64") !== line) return false;
    const proof = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof proof.xml !== "string" || typeof proof.sid !== "string"
      || !/^S-1-(?:5-21|12-1)(?:-\d{1,10}){4}$/i.test(proof.sid)) return false;
    const userIds = typeof proof.name === "string" && proof.name.trim() ? [proof.sid, proof.name] : [proof.sid];
    return windowsTaskRegistrationMatchesForStop(proof.xml, launcher, userIds);
  } catch {
    return false;
  }
}
