import { TASK } from "./state";
import { windowsTaskRegistrationMatchesForStop } from "./windows-taskxml";

const MAX_TASK_ENGINES = 32;

/**
 * Keep the registered task and captured IRunningTask objects in one COM session.
 * Send the Unicode XML and caller identity to the existing validator through an ASCII
 * line, then wait for its decision. Only the captured instances can receive Stop().
 */
const TASK_INSTANCE_STOP_BODY = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSModuleAutoLoadingPreference = 'None'
$attempted = $false
function Get-EngineCreationTicks([int]$enginePid) {
  $process = [Diagnostics.Process]::GetProcessById($enginePid)
  try { $process.StartTime.ToUniversalTime().Ticks } finally { $process.Dispose() }
}
try {
  [Console]::OutputEncoding = [Text.Encoding]::ASCII
  Import-Module ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -Force
  $name = '${TASK}'
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User.Value
  if (!$sid) { 'unverified-registration'; return }
  $account = $null
  try { $account = $identity.Name } catch { $account = $null } # optional: proof falls back to the SID alone
  $service = Microsoft.PowerShell.Utility\New-Object -ComObject Schedule.Service
  $service.Connect()
  $folder = $service.GetFolder('\')
  $task = $folder.GetTask($name)
  $xml = [string]$task.Xml
  $instances = $task.GetInstances(0)
  if ($null -eq $instances) { 'unverified-registration'; return }
  $verified = @()
  $engines = @()
  $count = $instances.Count
  if ($null -eq $count) { 'unverified-registration'; return }
  if ($nativeOwners -and ($count -lt 0 -or $count -gt ${MAX_TASK_ENGINES})) { 'unverified-registration'; return }
  if (!$nativeOwners -and $count -gt 0) {
    Import-Module ([IO.Path]::Combine($PSHOME,'Modules','CimCmdlets','CimCmdlets.psd1')) -Force
  }
  for ($index = 1; $index -le $count; $index++) {
    $instance = $instances.Item($index)
    $instance.Refresh()
    $id = [Guid]$instance.InstanceGuid
    $enginePid = [uint32]$instance.EnginePID
    if ($id -eq [Guid]::Empty -or !$enginePid -or $instance.State -ne 4) { 'unverified-registration'; return }
    $target = @{ Instance = $instance; Id = $id; EnginePid = $enginePid }
    if ($nativeOwners) {
      $ticks = Get-EngineCreationTicks $enginePid
      if ($ticks -le 0) { 'unverified-registration'; return }
      $target.CreationTicks = $ticks
      $cimTicks = ($ticks - ($ticks % 10)).ToString([Globalization.CultureInfo]::InvariantCulture)
      $engines += @{ id = $id.ToString('D'); pid = $enginePid; ticks = $cimTicks }
    } else {
      $engine = CimCmdlets\Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $enginePid) -OperationTimeoutSec 1
      if (!$engine.CreationDate) { 'unverified-registration'; return }
      $owner = CimCmdlets\Invoke-CimMethod -InputObject $engine -MethodName GetOwnerSid -OperationTimeoutSec 1
      $after = CimCmdlets\Get-CimInstance -InputObject $engine -OperationTimeoutSec 1
      if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $sid -or $after.CreationDate -ne $engine.CreationDate) {
        'unverified-registration'; return
      }
    }
    $verified += $target
  }

  $evidence = @{ xml = $xml; sid = $sid; name = $account }
  if ($nativeOwners) {
    $evidence.count = $count
    if ($count -eq 0) { $evidence.state = [int]$task.State }
    $evidence.engines = $engines
  }
  $proof = Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 4 -Compress -InputObject $evidence
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
    if ($nativeOwners -and (Get-EngineCreationTicks $target.EnginePid) -ne $target.CreationTicks) {
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

export function windowsTaskInstanceStopScript(nativeOwners: boolean): string {
  return (nativeOwners ? "$nativeOwners = $true\n" : "$nativeOwners = $false\n") + TASK_INSTANCE_STOP_BODY;
}

export const WINDOWS_TASK_INSTANCE_STOP_SCRIPT = windowsTaskInstanceStopScript(false);

interface TaskStopProof {
  sid: string;
  count?: number;
  state?: number;
  engines?: unknown[];
}

function readTaskStopProof(line: string, launcher: string): TaskStopProof | null {
  try {
    const bytes = Buffer.from(line, "base64");
    if (bytes.toString("base64") !== line) return null;
    const proof = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof proof.xml !== "string" || typeof proof.sid !== "string"
      || !/^S-1-(?:5-21|12-1)(?:-\d{1,10}){4}$/i.test(proof.sid)
      || proof.sid.split("-").slice(-4).some((part: string) => Number(part) > 0xffff_ffff)) return null;
    const userIds = typeof proof.name === "string" && proof.name.trim() ? [proof.sid, proof.name] : [proof.sid];
    return windowsTaskRegistrationMatchesForStop(proof.xml, launcher, userIds) ? proof : null;
  } catch {
    return null;
  }
}

/** The legacy helper has already checked the engine owner through CIM. */
export function verifyWindowsTaskStopProof(line: string, launcher: string): boolean {
  const proof = readTaskStopProof(line, launcher);
  return proof !== null && proof.count === undefined && proof.engines === undefined;
}

type EngineIdentity = (pid: number, withCommandLine: false, expectedSid: string) => { ticks: bigint } | null;

/** On x64 every captured engine needs positive same-token and creation-time evidence. */
export function verifyWindowsTaskEngineProof(line: string, launcher: string, identity: EngineIdentity,
  withinDeadline: () => boolean): "ended" | "not-running" | null {
  const proof = readTaskStopProof(line, launcher);
  if (!proof || !Array.isArray(proof.engines) || proof.engines.length !== proof.count || proof.count > MAX_TASK_ENGINES) return null;
  if (!proof.count) return proof.state === 1 || proof.state === 3 ? "not-running" : null;
  const ids = new Set<string>();
  try {
    for (const engine of proof.engines) {
      if (!engine || typeof engine !== "object") return null;
      const { id, pid, ticks } = engine as Record<string, unknown>;
      if (typeof id !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)
        || id === "00000000-0000-0000-0000-000000000000" || ids.has(id.toLowerCase())
        || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fff_ffff
        || typeof ticks !== "string" || !/^[1-9]\d{0,17}0$/.test(ticks) || !withinDeadline()) return null;
      ids.add(id.toLowerCase());
      if (identity(pid, false, proof.sid)?.ticks.toString() !== ticks) return null;
    }
  } catch { return null; }
  return "ended";
}
