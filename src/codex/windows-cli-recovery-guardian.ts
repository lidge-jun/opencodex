import { dirname, basename } from "node:path";
import { ptr } from "bun:ffi";
import { resolveTrustedWindowsPowerShellExe } from "../lib/windows-elevation";
import { withWindowsCliRecoveryStore } from "./cli-update-job-store-windows";
import type { CodexCliUpdateNativeRecoveryProof } from "./cli-update-recovery";
import { wide, WindowsChildNative } from "./windows-cli-child-native";

// This separate process owns only query access to the installer's Job and a
// pre-opened private receipt. Failure/early death leaves armed evidence fenced.
// It starts after assignment, while the primary is still suspended: zero Job
// members can then mean only that every assigned process has terminated.
const SCRIPT = String.raw`
$ErrorActionPreference='Stop'
try {
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Threading;
public static class OcxCliRecovery {
 [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr j,int c,byte[] b,uint n,IntPtr r);
 [DllImport("kernel32.dll")] static extern bool SetFilePointerEx(IntPtr f,long p,IntPtr n,uint m);
 [DllImport("kernel32.dll")] static extern bool SetEndOfFile(IntPtr f);
 [DllImport("kernel32.dll")] static extern bool WriteFile(IntPtr f,byte[] b,uint n,out uint w,IntPtr o);
 [DllImport("kernel32.dll")] static extern bool FlushFileBuffers(IntPtr f);
 public static bool Record(IntPtr job,IntPtr file,byte[] body) {
  byte[] accounting=new byte[48];
  for (;;) {
   if(!QueryInformationJobObject(job,1,accounting,48,IntPtr.Zero))return false;
   if(BitConverter.ToUInt32(accounting,40)==0)break;
   Thread.Sleep(50);
  }
  uint written;
  return SetFilePointerEx(file,0,IntPtr.Zero,0) && SetEndOfFile(file)
   && WriteFile(file,body,(uint)body.Length,out written,IntPtr.Zero)
   && written==body.Length && FlushFileBuffers(file);
 }
}
'@
  if (![OcxCliRecovery]::Record([IntPtr]::new([long]@JOB@),[IntPtr]::new([long]@FILE@),[Convert]::FromBase64String('@BODY@'))) { exit 3 }
  exit 0
} catch { exit 4 }
`;

/** No installer start/resume until the scoped receipt observer was created. */
export function startWindowsCliRecoveryGuardian(native: WindowsChildNative, job: bigint,
  proof: CodexCliUpdateNativeRecoveryProof, temporaryRoot: string): bigint {
  return withWindowsCliRecoveryStore(dirname(dirname(proof.path)), false, io => io.withProofHandle(basename(proof.path), file => {
    const k = native.k, handles = Buffer.alloc(16), size = Buffer.alloc(8);
    const output = Buffer.alloc(8), current = k.GetCurrentProcess!();
    if (!k.DuplicateHandle!(current, job, current, ptr(output), 4, 1, 0)) throw new Error("recovery_job_query_handle");
    const queryJob = native.keep(output.readBigUInt64LE());
    handles.writeBigUInt64LE(queryJob); handles.writeBigUInt64LE(file, 8);
    let attributes: Buffer | undefined, initialized = false;
    try {
      if (!k.SetHandleInformation!(file, 1, 1)) throw new Error("recovery_inheritance");
      k.InitializeProcThreadAttributeList!(null, 1, 0, ptr(size));
      const length = Number(size.readBigUInt64LE());
      if (length < 24 || length > 1048576) throw new Error("recovery_attribute_size");
      attributes = Buffer.alloc(length);
      native.borrowedMemory.add(attributes); native.borrowedMemory.add(handles);
      if (!k.InitializeProcThreadAttributeList!(ptr(attributes), 1, 0, ptr(size))) throw new Error("recovery_attributes");
      initialized = true;
      if (!k.UpdateProcThreadAttribute!(ptr(attributes), 0, 0x20002n, ptr(handles), 16n, null, null)) throw new Error("recovery_handle_list");
      const script = SCRIPT.replace('@JOB@', queryJob.toString()).replace('@FILE@', file.toString())
        .replace('@BODY@', Buffer.from(proof.terminal).toString('base64'));
      const executable = resolveTrustedWindowsPowerShellExe();
      const args = [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
      const command = wide(args.map(arg => '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"').join(' '));
      const exe = wide(executable), cwd = wide(temporaryRoot);
      const systemRoot = dirname(dirname(dirname(dirname(executable))));
      const env = wide(['APPDATA=' + temporaryRoot, 'HOME=' + temporaryRoot, 'LOCALAPPDATA=' + temporaryRoot,
        'PATH=' + systemRoot + '\\System32', 'PSModuleAnalysisCachePath=' + temporaryRoot + '\\guardian-module-analysis-cache',
        'PSModulePath=' + systemRoot + '\\System32\\WindowsPowerShell\\v1.0\\Modules', 'SystemRoot=' + systemRoot,
        'TEMP=' + temporaryRoot, 'TMP=' + temporaryRoot, 'USERPROFILE=' + temporaryRoot, 'WINDIR=' + systemRoot].join('\0') + '\0');
      const startup = Buffer.alloc(112), info = Buffer.alloc(24);
      startup.writeUInt32LE(112); startup.writeBigUInt64LE(BigInt(ptr(attributes)), 104);
      if (!k.CreateProcessW!(ptr(exe), ptr(command), null, null, 1, 0x08080400, ptr(env), ptr(cwd), ptr(startup), ptr(info))) {
        throw new Error("recovery_observer_spawn");
      }
      const processHandle = native.keep(info.readBigUInt64LE());
      native.close(native.keep(info.readBigUInt64LE(8)));
      return processHandle;
    } finally {
      k.SetHandleInformation!(file, 1, 0); native.close(queryJob);
      if (initialized) k.DeleteProcThreadAttributeList!(ptr(attributes!));
      if (attributes) native.borrowedMemory.delete(attributes);
      native.borrowedMemory.delete(handles);
    }
  }));
}
