import { Buffer } from "node:buffer";
import { deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * cmd.exe, Windows OpenSSH's default shell, caps its command line at 8191 characters. The encoded
 * script leaves room for the fixed powershell.exe prefix and cmd.exe's own wrapper.
 */
export const POWERSHELL_ENCODED_MAX = 8_000;

/** The encoded command would not fit cmd.exe's command line; callers that build gated commands rename it. */
export class PowerShellCommandTooLongError extends Error {
  constructor(readonly encodedLength: number) {
    super(`Remote PowerShell command exceeds the cmd.exe-compatible command-line budget (${encodedLength})`);
    this.name = "PowerShellCommandTooLongError";
  }
}

export function powershellArgv(script: string): string[] {
  // Module preparation otherwise writes a CLIXML progress record to stderr, which Home would see.
  const encoded = Buffer.from("$ProgressPreference='SilentlyContinue'\n" + script, "utf16le").toString("base64");
  if (encoded.length > POWERSHELL_ENCODED_MAX) throw new PowerShellCommandTooLongError(encoded.length);
  return ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
}

/** Exit status when the remote ocx cannot be contained; nothing ran. */
export const WINDOWS_CONTAINMENT_EXIT = 126;

const SCRIPT_PACKED_PREFIX = "$ocxPacked='";
/**
 * The whole script travels deflated and is inflated on the Child before anything in it exists,
 * including Fail. A session that cannot inflate it (Constrained Language Mode blocks the stream
 * types) must still exit 126, so only the inflate is guarded: Invoke-Expression stays outside the
 * try, and the inflated script's own errors and exit status are never relabelled as containment.
 */
export function packedPowerShellArgv(script: string): string[] {
  const bytes = deflateRawSync(Buffer.from(script, "utf8"), { level: 9 });
  const packed = Array.from(bytes, byte => String.fromCharCode(byte + 256)).join("");
  return powershellArgv(`${SCRIPT_PACKED_PREFIX}${packed}'\n` + String.raw`$ErrorActionPreference='Stop';try{$b=[byte[]]@($ocxPacked.ToCharArray()|%{[int]$_-256});$r=[IO.StreamReader]::new([IO.Compression.DeflateStream]::new([IO.MemoryStream]::new($b),[IO.Compression.CompressionMode]::Decompress));$s=$r.ReadToEnd()}catch{try{[Console]::Error.WriteLine('Refusing to run ocx.exe outside a kill-on-close job.')}catch{$null=$_};exit ${WINDOWS_CONTAINMENT_EXIT}};Invoke-Expression $s`);
}
function unpackPowerShell(script: string): string {
  const match = /\$ocxPacked='([^']+)'/.exec(script);
  return match ? inflateRawSync(Buffer.from(Array.from(match[1]!, ch => ch.charCodeAt(0) - 256))).toString("utf8") : script;
}

/**
 * OcxJob, compiled on the Child with Add-Type, contains the remote ocx. Run creates the process
 * with PROC_THREAD_ATTRIBUTE_JOB_LIST (STARTUPINFOEX, EXTENDED_STARTUPINFO_PRESENT), so it is a
 * member of a kill-on-close, silent-breakaway Job from the moment it exists: when the SSH server
 * ends a dropped channel by terminating this PowerShell host, the Job's last handle closes and
 * ocx.exe dies with it, while a runtime ocx starts on its own breaks away and survives. Standard
 * handles are inherited, so stdin bytes reach ocx untouched, and its exit status becomes the
 * host's. One finally block releases the attribute list, its value buffer and the thread, process
 * and Job handles on every path, and terminates the child through its own handle if anything
 * fails after creation. If Add-Type or any step fails, the host exits 126; there is no
 * uncontained fallback. Ok is the bounded --version probe for discovery. Layouts are x64:
 * STARTUPINFOEXW is 112 bytes with the attribute list at byte 104, and LimitFlags sits at byte 16
 * of the 144-byte JOBOBJECT_EXTENDED_LIMIT_INFORMATION. Warnings fail Add-Type in Windows
 * PowerShell, so this source must compile without any.
 */
export const OCX_JOB_SOURCE = [
  "using System;using System.Text;using System.Diagnostics;using System.Runtime.InteropServices;",
  "public static class OcxJob{",
  "[DllImport(\"kernel32\")]static extern IntPtr CreateJobObjectW(IntPtr a,IntPtr n);",
  "[DllImport(\"kernel32\")]static extern bool SetInformationJobObject(IntPtr j,int c,byte[] i,int l);",
  "[DllImport(\"kernel32\")]static extern bool InitializeProcThreadAttributeList(IntPtr l,int c,int f,ref IntPtr n);",
  "[DllImport(\"kernel32\")]static extern bool UpdateProcThreadAttribute(IntPtr l,int f,IntPtr a,IntPtr v,IntPtr n,IntPtr p,IntPtr r);",
  "[DllImport(\"kernel32\")]static extern void DeleteProcThreadAttributeList(IntPtr l);",
  "[DllImport(\"kernel32\",CharSet=CharSet.Unicode)]static extern bool CreateProcessW(string a,StringBuilder c,IntPtr p,IntPtr t,bool h,int f,IntPtr e,string d,long[] s,long[] i);",
  "[DllImport(\"kernel32\")]static extern int WaitForSingleObject(IntPtr h,int m);",
  "[DllImport(\"kernel32\")]static extern bool GetExitCodeProcess(IntPtr p,out int c);",
  "[DllImport(\"kernel32\")]static extern bool TerminateProcess(IntPtr p,int c);",
  "[DllImport(\"kernel32\")]static extern bool CloseHandle(IntPtr h);",
  "static void F(bool k){if(!k)throw new Exception();}",
  "public static bool Ok(string x){try{",
  "var q=Process.Start(new ProcessStartInfo(x,\"--version\"){UseShellExecute=false,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true});",
  "q.StandardInput.Close();q.StandardOutput.ReadToEndAsync();q.StandardError.ReadToEndAsync();",
  "if(q.WaitForExit(10000))return q.ExitCode==0;q.Kill();}catch{return false;}return false;}",
  "public static string V(string x){Process q=null;try{",
  "q=Process.Start(new ProcessStartInfo(x,\"--version\"){UseShellExecute=false,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true});q.StandardInput.Close();",
  "var p=q;var read=System.Threading.Tasks.Task.Run(()=>{var b=new char[257];int n=0,k;while(n<257&&(k=p.StandardOutput.Read(b,n,257-n))>0)n+=k;return n>256?null:new string(b,0,n);});",
  "System.Threading.Tasks.Task.Run(()=>{var b=new char[1024];while(p.StandardError.Read(b,0,b.Length)>0){} });",
  "var clock=Stopwatch.StartNew();var done=System.Threading.Tasks.Task.Run(()=>p.WaitForExit());if(!read.Wait(10000)||read.Result==null||!done.Wait(Math.Max(0,10000-(int)clock.ElapsedMilliseconds))){q.Kill();q.WaitForExit();return null;}return q.ExitCode==0?read.Result:null;",
  "}catch{try{if(q!=null&&!q.HasExited){q.Kill();q.WaitForExit();}}catch{return null;}return null;}finally{if(q!=null)q.Dispose();}}",
  "public static int Run(string x,string c){",
  "IntPtr z=IntPtr.Zero,j=z,l=z,v=z,h=z,t=z;bool listed=false,done=false;",
  "try{",
  // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x3000 at LimitFlags.
  "j=CreateJobObjectW(z,z);var limits=new byte[144];limits[17]=0x30;F(j!=z&&SetInformationJobObject(j,9,limits,144));",
  "var n=z;InitializeProcThreadAttributeList(z,1,0,ref n);l=Marshal.AllocHGlobal(n);F(listed=InitializeProcThreadAttributeList(l,1,0,ref n));",
  // PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x2000D; the value is an array holding this one Job handle.
  "v=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(v,j);F(UpdateProcThreadAttribute(l,0,(IntPtr)0x2000D,v,(IntPtr)IntPtr.Size,z,z));",
  "var s=new long[14];s[0]=112;s[13]=(long)l;var i=new long[3];",
  // EXTENDED_STARTUPINFO_PRESENT; inherit handles so stdin reaches the child untouched.
  "F(CreateProcessW(x,new StringBuilder(c),z,z,true,0x80000,z,null,s,i));h=(IntPtr)i[0];t=(IntPtr)i[1];",
  "F(WaitForSingleObject(h,-1)==0);int e;F(GetExitCodeProcess(h,out e));done=true;return e;",
  "}finally{",
  "if(!done&&h!=z)TerminateProcess(h,1);if(t!=z)CloseHandle(t);if(h!=z)CloseHandle(h);",
  "if(listed)DeleteProcThreadAttributeList(l);if(l!=z)Marshal.FreeHGlobal(l);if(v!=z)Marshal.FreeHGlobal(v);if(j!=z)CloseHandle(j);",
  "}}}",
].join("\n");

/**
 * The helper reaches Add-Type as a quoted literal inside the packed script; it is never evaluated
 * as PowerShell.
 */
const NATIVE_PROCESS = String.raw`$ErrorActionPreference='Stop'
function Fail{try{[Console]::Error.WriteLine('Refusing to run ocx.exe outside a kill-on-close job.')}catch{$null=$_};exit 126}
try{Add-Type '` + OCX_JOB_SOURCE.replaceAll("'", "''") + String.raw`'}catch{Fail}
function Quote-Native([string]$v){'"'+[regex]::Replace([regex]::Replace($v,'(\\*)"','$1$1\"'),'(\\+)$','$1$1')+'"'}
function Invoke-Native([string]$e,[string[]]$a){try{$c=[OcxJob]::Run($e,((@($e)+$a|%{Quote-Native $_}) -join ' '))}catch{Fail};exit $c}
`;

/** The packed helper a script carries, inflated; for tests that check the transport. */
export function windowsScriptHelperSource(script: string): string | undefined {
  script = unpackPowerShell(script);
  const source = /try\{Add-Type '([\s\S]*?)'\}catch\{Fail\}/.exec(script);
  if (source) return source[1]!.replaceAll("''", "'");
  const match = /FromBase64String\('([A-Za-z0-9+/=]+)'\)\),\[IO\.Compression\.CompressionMode\]::Decompress\)\)\.ReadToEnd\(\)/.exec(script);
  if (!match) return undefined;
  return inflateRawSync(Buffer.from(match[1]!, "base64")).toString("utf8");
}

/** The one line that carries the argument object; builder and decoder share these constants. */
const DATA_OPEN = "$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('";
const DATA_CLOSE = "'))|ConvertFrom-Json\n";

function dataLine(value: { executable?: string; args: readonly string[] }): string {
  if ([value.executable ?? "", ...value.args].some(item => item.includes("\0"))) throw new Error("Remote argument contains NUL");
  // An object wrapper: Windows PowerShell 5.1 emits a top-level JSON array unenumerated.
  return DATA_OPEN + Buffer.from(JSON.stringify(value), "utf8").toString("base64") + DATA_CLOSE;
}

/**
 * The argument object a script from this module carries, read back from its decoded script text;
 * undefined for any other script. Test fixtures decode with this, never with their own pattern.
 */
export function windowsScriptData(script: string): { executable?: string; args: string[] } | undefined {
  script = unpackPowerShell(script);
  const start = script.indexOf(DATA_OPEN);
  const end = start < 0 ? -1 : script.indexOf(DATA_CLOSE, start + DATA_OPEN.length);
  if (end < 0) return undefined;
  const value: unknown = JSON.parse(Buffer.from(script.slice(start + DATA_OPEN.length, end), "base64").toString("utf8"));
  if (!value || typeof value !== "object" || !Array.isArray((value as { args?: unknown }).args)) return undefined;
  return value as { executable?: string; args: string[] };
}

export function windowsNativeArgv(executable: string, args: readonly string[]): string[] {
  return packedPowerShellArgv(NATIVE_PROCESS + dataLine({ executable, args }) + "Invoke-Native $d.executable @($d.args)\n");
}

/**
 * Desktop first, then the GOAT-managed current junction, then legacy and PATH candidates. Each
 * must answer --version within ten seconds; only the selected one runs the real command.
 */
const OCX_CANDIDATES = String.raw`$u=$env:USERPROFILE;$f=@("$u\.opencodex-desktop\bin\ocx.exe","$u\.local\share\goat\opencodex\current\ocx.exe","$u\.local\bin\ocx.exe")
if($env:LOCALAPPDATA){$f+="$env:LOCALAPPDATA\Programs\OpenCodex\ocx.exe"}
if($env:ProgramFiles){$f+="$env:ProgramFiles\OpenCodex\ocx.exe"}
$f+=@((Get-Command ocx.exe -Type Application -EA 0).Source)
$k=@("$u\.local\bin\ocx-child.exe","$u\.cache\opencodex\bin\ocx-child.exe");if($env:LOCALAPPDATA){$k+="$env:LOCALAPPDATA\opencodex\bin\ocx-child.exe"};$k+=@((Get-Command ocx-child.exe -Type Application -EA 0).Source)
$r=if($env:HOME){$env:HOME}elseif($u){$u}else{"."};$h=if($env:OPENCODEX_HOME){$env:OPENCODEX_HOME}else{"$r\.opencodex"};$c=if([IO.File]::Exists("$h\child\state.json")){$k+$f}else{$f+$k}
`;
export function windowsOcxArgv(args: readonly string[]): string[] {
  const sweep = args.includes("--purge") ? String.raw`foreach($r in @($env:LOCALAPPDATA,$env:USERPROFILE)){if($r){foreach($s in @("$r\opencodex\bin","$r\.cache\opencodex\bin")){if([IO.Directory]::Exists($s)){Get-ChildItem -LiteralPath $s -Filter '.ocx-child.purge.*.old' -Force -EA 0|%{try{[IO.File]::Delete($_.FullName)}catch{$null=$_}}}}}};` : "";
  const run = sweep ? `try{$c=[OcxJob]::Run($x,((@($x)+$d.args|%{Quote-Native $_}) -join ' '))}catch{Fail};${sweep}exit $c` : `Invoke-Native $x @($d.args)`;
  return packedPowerShellArgv(NATIVE_PROCESS + dataLine({ args }) + OCX_CANDIDATES + String.raw`
foreach($x in ($c|select -Unique)){if([IO.File]::Exists($x)-and[OcxJob]::Ok($x)){` + run + String.raw`}}
[Console]::Error.WriteLine('No runnable ocx.exe found; install the Windows standalone archive.');exit 127
`);
}

export function windowsInspectRuntimeArgv(): string[] {
  return packedPowerShellArgv(NATIVE_PROCESS + OCX_CANDIDATES + String.raw`
[Console]::Out.WriteLine('ocx-inspect:arch:'+[string]$env:PROCESSOR_ARCHITECTURE)
foreach($x in ($c|select -Unique)){if(![IO.File]::Exists($x)){continue};$v=[OcxJob]::V($x);if($null -ne $v){$k=if(([IO.Path]::GetFileName($x)).ToLowerInvariant().StartsWith('ocx-child')){'ephemeral'}else{'full'};[Console]::Out.WriteLine('ocx-inspect:kind:'+$k);[Console]::Out.WriteLine('ocx-inspect:version:'+$v.Trim());exit 0}}
[Console]::Out.WriteLine('ocx-inspect:kind:missing');exit 0
`);
}

const WINDOWS_MANAGED_BIN = String.raw`function Resolve-PlantDir{
$r=if($env:LOCALAPPDATA){$env:LOCALAPPDATA}else{$env:USERPROFILE};$subs=if($env:LOCALAPPDATA){@('opencodex','bin')}else{@('.cache','opencodex','bin')};$cur=$r
foreach($s in $subs){$cur="$cur\$s";if([IO.Directory]::Exists($cur)-or[IO.File]::Exists($cur)){if((([IO.FileSystemInfo](Get-Item -LiteralPath $cur -Force)).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse'}}else{[IO.Directory]::CreateDirectory($cur)|Out-Null}}
$dst="$cur\ocx-child.exe";if([IO.File]::Exists($dst)-or[IO.Directory]::Exists($dst)){if((([IO.FileSystemInfo](Get-Item -LiteralPath $dst -Force)).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse'}}
return $cur}
`;

export function windowsPlantChildArgv(expectedBytes: number, expectedSha256: string): string[] {
  return packedPowerShellArgv(NATIVE_PROCESS + dataLine({ args: [String(expectedBytes), expectedSha256] }) + WINDOWS_MANAGED_BIN + String.raw`
$tmp=$null;try{$dir=Resolve-PlantDir;$dst="$dir\ocx-child.exe";$lim=[int]$d.args[0];$exp=$d.args[1]
$tmp="$dir\.ocx-child.tmp.$PID.$([Guid]::NewGuid().ToString('N').Substring(0,8)).exe"
$in=[Console]::OpenStandardInput();$fs=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$h=[Security.Cryptography.SHA256]::Create();$buf=New-Object byte[] 16384;$tot=0
try{while(($n=$in.Read($buf,0,$buf.Length)) -gt 0){$tot+=$n;if($tot -gt $lim){throw 'size'};$fs.Write($buf,0,$n);[void]$h.TransformBlock($buf,0,$n,$null,0)};[void]$h.TransformFinalBlock($buf,0,0)}finally{$fs.Dispose()}
$sha=([BitConverter]::ToString($h.Hash)).Replace('-','').ToLowerInvariant();$h.Dispose()
if($tot -ne $lim -or $sha -ne $exp){throw 'integrity'}
[IO.File]::Copy($tmp,$dst,$true);[IO.File]::Delete($tmp);$tmp=$null
$rc=[OcxJob]::Run($dst,('"'+$dst+'" --version'));if($rc -ne 0){[IO.File]::Delete($dst);exit 1};exit 0
}catch{if($tmp -and [IO.File]::Exists($tmp)){try{[IO.File]::Delete($tmp)}catch{$null=$_}};[Console]::Error.WriteLine('Windows ocx-child plant failed.');exit 1}
`);
}

export function windowsPurgePlantedChildArgv(): string[] {
  return packedPowerShellArgv(NATIVE_PROCESS + WINDOWS_MANAGED_BIN + String.raw`
$r=if($env:HOME){$env:HOME}elseif($env:USERPROFILE){$env:USERPROFILE}else{"."};$h=if($env:OPENCODEX_HOME){$env:OPENCODEX_HOME}else{"$r\.opencodex"};$cd="$h\child";$cx=if($env:CODEX_HOME){$env:CODEX_HOME}else{"$r\.codex"}
$rec=@(@("$cd\state.json","$cd\codex-journal.json","$cd\attach-rollback.json","$cx\.ocx-child-owner.json")|?{[IO.File]::Exists($_)-or[IO.Directory]::Exists($_)});$pend=$rec.Count -gt 0;if($pend){$m='ocx-child recovery record remains at '+$rec[0]+'; keeping the planted binary for detach.'}
try{$dir=Resolve-PlantDir;$dst="$dir\ocx-child.exe";if([IO.File]::Exists($dst)){if([OcxJob]::Ok($dst)){$rc=[OcxJob]::Run($dst,('"'+$dst+'" detach --purge'));if($rc -ne 0){exit $rc};try{[IO.File]::Delete($dst)}catch{$null=$_}}elseif($pend){[Console]::Error.WriteLine($m);exit 1}else{try{[IO.File]::Delete($dst)}catch{$null=$_}}}elseif($pend){[Console]::Error.WriteLine($m);exit 1};Get-ChildItem -LiteralPath $dir -Filter '.ocx-child.purge.*.old' -Force -EA 0|%{try{[IO.File]::Delete($_.FullName)}catch{$null=$_}}}catch{exit 1};exit 0
`);
}

/** Printed on stderr when the managed plant directory holds no runnable ocx-child to purge. */
export const MANAGED_PURGE_CHILD_MISSING_MARKER = "ocx-purge-error:managed_child_missing";

/** Runs `disconnect --purge --json` through the planted %LOCALAPPDATA% binary, never a PATH candidate. */
export function windowsManagedPurgeDisconnectArgv(): string[] {
  return packedPowerShellArgv(NATIVE_PROCESS + WINDOWS_MANAGED_BIN + String.raw`
try{$dir=Resolve-PlantDir}catch{[Console]::Error.WriteLine('Refusing a reparse point in the managed ocx-child directory.');exit 1}
$dst="$dir\ocx-child.exe";if(-not([IO.File]::Exists($dst)-and[OcxJob]::Ok($dst))){[Console]::Error.WriteLine('${MANAGED_PURGE_CHILD_MISSING_MARKER}');exit 1}
try{$rc=[OcxJob]::Run($dst,('"'+$dst+'" disconnect --purge --json'))}catch{exit 1}
Get-ChildItem -LiteralPath $dir -Filter '.ocx-child.purge.*.old' -Force -EA 0|%{try{[IO.File]::Delete($_.FullName)}catch{$null=$_}};exit $rc
`);
}

export interface WindowsGatedCommand {
  versionParts: readonly [string, string, string];
  lacksMarker: "child-ocx-lacks-expect-link" | "child-ocx-lacks-orchestrated-update";
  acceptEphemeral: boolean;
  /** Prints ocx-fanout:child-now:<epoch-ms> from [DateTimeOffset]::Now (Unix milliseconds do not depend on the offset). */
  reportClock: boolean;
  args: readonly string[];
}

/**
 * The gated Windows command: select a candidate, refuse below the minimum, optionally refuse ocx-child, then run it
 * contained. OCX_NO_DESKTOP_HANDOFF=1 makes a launcher answer --version and run the command itself. Windows never
 * sends a restart, so the selected-kind report is not built here. Windows reads no served-runtime census, so the
 * selected entry is always a binary: the script prints no entry marker and the Home infers "binary", which keeps the
 * plan probe inside the command-line budget for long preview Home versions.
 */
export function windowsGatedOcxArgv(cmd: WindowsGatedCommand): string[] {
  if (!cmd.versionParts.every(part => /^(0|[1-9][0-9]{0,3})$/.test(part))) throw new Error("invalid gate version");
  if (!/^child-ocx-lacks-(expect-link|orchestrated-update)$/.test(cmd.lacksMarker)) throw new Error("invalid gate marker");
  const b = cmd.versionParts.map(part => "'" + part + "'").join(",");
  // -match is case-insensitive; the pattern reads the file name the way [IO.Path]::GetFileName does (either separator).
  const ephemeral = cmd.acceptEphemeral ? "" : String.raw`if($x -match '(^|[\\/])ocx-child[^\\/]*$'){[Console]::Error.WriteLine('ocx-fanout:child-ocx-ephemeral');exit 121};`;
  const clock = cmd.reportClock ? String.raw`[Console]::Error.WriteLine('ocx-fanout:child-now:'+[DateTimeOffset]::Now.ToUnixTimeMilliseconds());` : "";
  return packedPowerShellArgv(NATIVE_PROCESS + dataLine({ args: cmd.args }) + OCX_CANDIDATES + String.raw`$env:OCX_NO_DESKTOP_HANDOFF='1'
foreach($x in ($c|select -Unique)){
 if(![IO.File]::Exists($x)){continue};$v=[OcxJob]::V($x);if($null -eq $v){continue};$v=$v.Trim();if($v.StartsWith('opencodex ')){$v=$v.Substring(10)}
 $m=[regex]::Match($v,'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$')
 $bad=(!$m.Success -or $v.Length -gt 128);if(!$bad -and $m.Groups[4].Success){foreach($p in $m.Groups[4].Value.Split('.')){if(!$p -or ($p -match '^\d+$' -and $p.Length -gt 1 -and $p[0] -eq '0')){$bad=$true}}}
 if($bad){[Console]::Error.WriteLine('ocx-fanout:child-ocx-version-unknown');exit 121}
 $a=@($m.Groups[1].Value,$m.Groups[2].Value,$m.Groups[3].Value);$b=@(` + b + String.raw`);$cmp=0
 for($i=0;$i -lt 3;$i++){if($a[$i].Length -ne $b[$i].Length){$cmp=$a[$i].Length-$b[$i].Length;break};$cmp=[string]::CompareOrdinal($a[$i],$b[$i]);if($cmp -ne 0){break}}
 if($cmp -lt 0 -or ($cmp -eq 0 -and $m.Groups[4].Success)){[Console]::Error.WriteLine('ocx-fanout:` + cmd.lacksMarker + String.raw`');exit 121}
 ` + ephemeral + String.raw`[Console]::Error.WriteLine('ocx-fanout:selected:'+$v);` + clock + String.raw`[Console]::Out.WriteLine('ocx-fanout:stdout-begin');Invoke-Native $x @($d.args)
};exit 127
`);
}

/** The 2.93.0 sync gate; kept as a named entry because discovery tests import it. */
export function windowsPinnedSyncArgv(linkId: string): string[] {
  return windowsGatedOcxArgv({ versionParts: ["2", "93", "0"], lacksMarker: "child-ocx-lacks-expect-link", acceptEphemeral: true,
    reportClock: false, args: ["sync", "--expect-link", linkId, "--json"] });
}

/** Credential-free loopback probe of the Child; no proxy, no redirect, bounded body and deadline. */
export function windowsChildHttpArgv(port: number, path: "healthz" | "v1/catalog", timeoutMs: number, routeProofId?: string): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid Child port");
  if (path !== "healthz" && path !== "v1/catalog") throw new Error("invalid Child HTTP path");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid Child HTTP deadline");
  // 32 lowercase hex characters only, so it is a plain literal inside the script.
  if (routeProofId !== undefined && !/^[0-9a-f]{32}$/.test(routeProofId)) throw new Error("invalid route proof");
  const proofHeader = routeProofId === undefined ? "" : `;$q.Headers.Add('x-opencodex-link-route-proof','${routeProofId}')`;
  const budget = Math.max(1, Math.min(15_000, Math.ceil(timeoutMs)));
  return powershellArgv(`$ErrorActionPreference='Stop';$r=$null
try{$w=[Diagnostics.Stopwatch]::StartNew()
$q=[Net.HttpWebRequest]::Create('http://127.0.0.1:${port}/${path}');$q.Proxy=$null;$q.AllowAutoRedirect=$false;$q.Timeout=${budget};$q.ReadWriteTimeout=${budget}${proofHeader}
$r=$q.GetResponse();if([int]$r.StatusCode -ne 200){throw 'status'}
$t=$r.GetResponseStream();$o=New-Object IO.MemoryStream;$b=New-Object byte[] 8192
while($true){$left=${budget}-[int]$w.ElapsedMilliseconds;if($left -le 0){throw 'deadline'}
$t.ReadTimeout=$left;$n=$t.Read($b,0,$b.Length);if($n -eq 0){break}
if($o.Length+$n -gt 4194304){throw 'size'};$o.Write($b,0,$n)}
$e=New-Object Text.UTF8Encoding($false,$true);[Console]::OutputEncoding=$e
[Console]::Write($e.GetString($o.ToArray())+[char]10+'200');exit 0
}catch{[Console]::Error.WriteLine('Child loopback HTTP probe failed.');exit 1}finally{if($r){$r.Dispose()}}
`);
}
