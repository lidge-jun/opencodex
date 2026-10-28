# ASCII-only Windows PowerShell 5.1 supervisor. Arguments arrive as JSON on stdin.
# The child is born in our private job; no installer can outlive its supervisor.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8, $false)
$request = $reader.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class NpmInstallJob {
    [StructLayout(LayoutKind.Sequential)] struct Startup {
        public int cb; public IntPtr reserved, desktop, title;
        public int x, y, width, height, charsX, charsY, fill, flags;
        public short show, reservedSize; public IntPtr reservedData, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr process, thread; public uint pid, tid;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx {
        public Startup startup; public IntPtr attributes;
    }
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public long processTime, jobTime; public uint flags;
        public UIntPtr minWorkingSet, maxWorkingSet; public uint activeLimit;
        public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public Limits basic;
        public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long userTime, kernelTime, periodUserTime, periodKernelTime;
        public uint faults, total, active, terminated;
    }
    public sealed class Result {
        public object status; public bool processTreeExited; public object error;
    }
    public sealed class InstallError {
        public string code, message;
        public InstallError(string c, string m) { code = c; message = m; }
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int info, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool QueryInformationJobObject(IntPtr job, int info, out Accounting data, uint size, IntPtr returned);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateProcess(string file, StringBuilder args, IntPtr pa, IntPtr ta, bool inherit, uint flags,
        IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value,
        IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int number);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Require(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void RequireAttribute(bool ok) {
        if (!ok) {
            int code = Marshal.GetLastWin32Error();
            throw new Win32Exception(code,
                "Atomic npm supervision requires Windows 10 or later with Job List and handle-list process attributes; installer was not started: "
                + new Win32Exception(code).Message);
        }
    }
    static uint Active(IntPtr job) {
        Accounting data;
        Require(QueryInformationJobObject(job, 1, out data, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        return data.active;
    }
    public static Result Run(string file, string args, string cwd, int timeoutMs, int joinMs) {
        IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, jobList = IntPtr.Zero, handles = IntPtr.Zero;
        ProcessInfo process = new ProcessInfo();
        bool started = false, attributesInitialized = false, timedOut = false;
        Result result = new Result { status = null, processTreeExited = true };
        try {
            job = CreateJobObject(IntPtr.Zero, null); Require(job != IntPtr.Zero);
            ExtendedLimits limits = new ExtendedLimits();
            limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
            Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
            StartupEx startup = new StartupEx(); startup.startup.cb = Marshal.SizeOf(typeof(StartupEx)); startup.startup.flags = 0x100;
            startup.startup.stdin = GetStdHandle(-10);
            // Keep stdout exclusively for the one supervisor result. npm logs inherit stderr.
            startup.startup.stdout = startup.startup.stderr = GetStdHandle(-12);
            Require(SetHandleInformation(startup.startup.stdin, 1, 1));
            Require(SetHandleInformation(startup.startup.stderr, 1, 1));
            Require(SetHandleInformation(GetStdHandle(-11), 1, 0)); // Result pipe is supervisor-only.
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            RequireAttribute(size != IntPtr.Zero);
            attributes = Marshal.AllocHGlobal(size);
            RequireAttribute(InitializeProcThreadAttributeList(attributes, 2, 0, ref size));
            attributesInitialized = true; startup.attributes = attributes;
            jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
            // PROC_THREAD_ATTRIBUTE_JOB_LIST: membership is atomic with creation (Windows 10+).
            RequireAttribute(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000D), jobList,
                new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            handles = Marshal.AllocHGlobal(2 * IntPtr.Size);
            Marshal.WriteIntPtr(handles, 0, startup.startup.stdin);
            Marshal.WriteIntPtr(handles, IntPtr.Size, startup.startup.stderr);
            // PROC_THREAD_ATTRIBUTE_HANDLE_LIST: never inherit the Job or result pipe.
            RequireAttribute(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020002), handles,
                new IntPtr(2 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            // Fail closed on unsupported attributes/creation: never retry without the Job list.
            RequireAttribute(CreateProcess(file, new StringBuilder(args), IntPtr.Zero, IntPtr.Zero, true,
                0x08080004, IntPtr.Zero, cwd, ref startup, out process)); // NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | SUSPENDED
            started = true; result.processTreeExited = false;
            // Keep suspension until local exit-proof/error handling is armed.
            Require(ResumeThread(process.thread) != UInt32.MaxValue);
            Stopwatch clock = Stopwatch.StartNew();
            while (Active(job) != 0 && clock.ElapsedMilliseconds < timeoutMs) Thread.Sleep(20);
            if (Active(job) != 0) {
                timedOut = true;
                result.error = new InstallError("ETIMEDOUT", "npm install exceeded " + timeoutMs + " ms");
                Require(TerminateJobObject(job, 1));
                clock.Restart();
                while (Active(job) != 0 && clock.ElapsedMilliseconds < joinMs) Thread.Sleep(10);
            } else clock.Restart();
            uint remainingJoinMs = (uint)Math.Max(0L, joinMs - clock.ElapsedMilliseconds);
            result.processTreeExited = Active(job) == 0 && WaitForSingleObject(process.process, remainingJoinMs) == 0;
            if (result.processTreeExited && result.error == null) {
                uint code; Require(GetExitCodeProcess(process.process, out code)); result.status = (long)code;
            } else if (!result.processTreeExited) {
                result.error = new InstallError(timedOut ? "ETIMEDOUT" : "EINSTALLJOIN",
                    (timedOut ? "npm install exceeded " + timeoutMs + " ms; " : "") + "process-tree exit could not be confirmed; stage retained");
            }
        } catch (Exception error) {
            if (started) {
                TerminateJobObject(job, 1);
                Stopwatch clock = Stopwatch.StartNew();
                while (clock.ElapsedMilliseconds < joinMs) {
                    try {
                        if (WaitForSingleObject(process.process, 0) == 0 && Active(job) == 0) {
                            result.processTreeExited = true; break;
                        }
                    } catch { break; }
                    Thread.Sleep(10);
                }
            }
            InstallError timeout = result.error as InstallError;
            result.error = new InstallError(timeout == null ? "EINSTALLJOIN" : timeout.code,
                (timeout == null ? "" : timeout.message + "; ") + "npm supervision failed: " + error.Message);
        } finally {
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
            if (process.process != IntPtr.Zero) CloseHandle(process.process);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
        return result;
    }
}
'@
$result = [NpmInstallJob]::Run([string]$request.file, [string]$request.commandLine, [string]$request.cwd,
    [int]$request.timeoutMs, [int]$request.joinMs) | ConvertTo-Json -Compress -Depth 4
$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$writer.Write($result)
$writer.Flush()
