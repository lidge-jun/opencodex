import { Buffer } from "node:buffer";
import { deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * cmd.exe, Windows OpenSSH's default shell, caps its command line at 8191 characters. The encoded
 * script leaves room for the fixed powershell.exe prefix and cmd.exe's own wrapper.
 */
export const POWERSHELL_ENCODED_MAX = 8_000;

export function powershellArgv(script: string): string[] {
  // Module preparation otherwise writes a CLIXML progress record to stderr, which Home would see.
  const encoded = Buffer.from("$ProgressPreference='SilentlyContinue'\n" + script, "utf16le").toString("base64");
  if (encoded.length > POWERSHELL_ENCODED_MAX) throw new Error("Remote PowerShell command exceeds the cmd.exe-compatible command-line budget");
  return ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
}

/** Exit status when the remote ocx cannot be contained; nothing ran. */
export const WINDOWS_CONTAINMENT_EXIT = 126;

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
 * The helper travels deflated so the whole command fits cmd.exe's line; PowerShell inflates it and
 * hands the text to Add-Type. It is never evaluated as PowerShell.
 */
const OCX_JOB_PACKED = deflateRawSync(Buffer.from(OCX_JOB_SOURCE, "utf8"), { level: 9 }).toString("base64");

const NATIVE_PROCESS = String.raw`$ErrorActionPreference='Stop'
function Fail{try{[Console]::Error.WriteLine('Refusing to run ocx.exe outside a kill-on-close job.')}catch{$null=$_};exit 126}
try{Add-Type ([IO.StreamReader]::new([IO.Compression.DeflateStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('` + OCX_JOB_PACKED + String.raw`')),[IO.Compression.CompressionMode]::Decompress)).ReadToEnd())}catch{Fail}
function Quote-Native([string]$v){'"'+[regex]::Replace([regex]::Replace($v,'(\\*)"','$1$1\"'),'(\\+)$','$1$1')+'"'}
function Invoke-Native([string]$e,[string[]]$a){try{$c=[OcxJob]::Run($e,((@($e)+$a|%{Quote-Native $_}) -join ' '))}catch{Fail};exit $c}
`;

/** The packed helper a script carries, inflated; for tests that check the transport. */
export function windowsScriptHelperSource(script: string): string | undefined {
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
  const start = script.indexOf(DATA_OPEN);
  const end = start < 0 ? -1 : script.indexOf(DATA_CLOSE, start + DATA_OPEN.length);
  if (end < 0) return undefined;
  const value: unknown = JSON.parse(Buffer.from(script.slice(start + DATA_OPEN.length, end), "base64").toString("utf8"));
  if (!value || typeof value !== "object" || !Array.isArray((value as { args?: unknown }).args)) return undefined;
  return value as { executable?: string; args: string[] };
}

export function windowsNativeArgv(executable: string, args: readonly string[]): string[] {
  return powershellArgv(NATIVE_PROCESS + dataLine({ executable, args }) + "Invoke-Native $d.executable @($d.args)\n");
}

/**
 * Desktop first, then the GOAT-managed current junction, then legacy and PATH candidates. Each
 * must answer --version within ten seconds; only the selected one runs the real command.
 */
export function windowsOcxArgv(args: readonly string[]): string[] {
  return powershellArgv(NATIVE_PROCESS + dataLine({ args }) + String.raw`$u=$env:USERPROFILE;$c=@("$u\.opencodex-desktop\bin\ocx.exe","$u\.local\share\goat\opencodex\current\ocx.exe","$u\.local\bin\ocx.exe")
if($env:LOCALAPPDATA){$c+="$env:LOCALAPPDATA\Programs\OpenCodex\ocx.exe"}
if($env:ProgramFiles){$c+="$env:ProgramFiles\OpenCodex\ocx.exe"}
$c+=@((Get-Command ocx.exe -Type Application -EA 0).Source)
foreach($x in ($c|select -Unique)){if([IO.File]::Exists($x)-and[OcxJob]::Ok($x)){Invoke-Native $x @($d.args)}}
[Console]::Error.WriteLine('No runnable ocx.exe found; install the Windows standalone archive.');exit 127
`);
}

/** Credential-free loopback probe of the Child; no proxy, no redirect, bounded body and deadline. */
export function windowsChildHttpArgv(port: number, path: "healthz" | "v1/catalog", timeoutMs: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid Child port");
  if (path !== "healthz" && path !== "v1/catalog") throw new Error("invalid Child HTTP path");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid Child HTTP deadline");
  const budget = Math.max(1, Math.min(15_000, Math.ceil(timeoutMs)));
  return powershellArgv(`$ErrorActionPreference='Stop';$r=$null
try{$w=[Diagnostics.Stopwatch]::StartNew()
$q=[Net.HttpWebRequest]::Create('http://127.0.0.1:${port}/${path}');$q.Proxy=$null;$q.AllowAutoRedirect=$false;$q.Timeout=${budget};$q.ReadWriteTimeout=${budget}
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
