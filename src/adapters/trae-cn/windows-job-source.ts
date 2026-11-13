/** Windows PowerShell 5.1 host; child membership and inherited handles are atomic. */
export const TRAE_WINDOWS_JOB_SOURCE = String.raw`
using System;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class TraeAcpJob {
    [StructLayout(LayoutKind.Sequential)] struct Startup {
        public int cb; public IntPtr reserved, desktop, title;
        public int x, y, width, height, charsX, charsY, fill, flags;
        public short show, reservedSize; public IntPtr reservedData, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr process, thread; public uint pid, tid;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
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
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static readonly object gate = new object();
    static StreamWriter status;
    static void Frame(string line) { lock (gate) { status.WriteLine(line); status.Flush(); } }
    static void Require(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static uint Active(IntPtr job) {
        Accounting data;
        Require(QueryInformationJobObject(job, 1, out data, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        return data.active;
    }
    public static int Run(string file, string args, string cwd, int joinMs) {
        status = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false));
        status.NewLine = "\n";
        IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, jobList = IntPtr.Zero, handles = IntPtr.Zero;
        ProcessInfo process = new ProcessInfo();
        bool started = false, attributesInitialized = false, stopped = false;
        string stage = "setup";
        Task outTask = null, errTask = null;
        try {
            var parent = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string first = parent.ReadLine();
            if (first == null || first == "__OCX_STOP_TRAE__") return 0;
            job = CreateJobObject(IntPtr.Zero, null); Require(job != IntPtr.Zero);
            ExtendedLimits limits = new ExtendedLimits();
            limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway.
            Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
            var input = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
            var output = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
            var errors = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
            StartupEx startup = new StartupEx(); startup.startup.cb = Marshal.SizeOf(typeof(StartupEx)); startup.startup.flags = 0x100;
            startup.startup.stdin = input.ClientSafePipeHandle.DangerousGetHandle();
            startup.startup.stdout = output.ClientSafePipeHandle.DangerousGetHandle();
            startup.startup.stderr = errors.ClientSafePipeHandle.DangerousGetHandle();
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size); Require(size != IntPtr.Zero);
            attributes = Marshal.AllocHGlobal(size);
            Require(InitializeProcThreadAttributeList(attributes, 2, 0, ref size));
            attributesInitialized = true; startup.attributes = attributes;
            jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000D), jobList,
                new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)); // Atomic Job List.
            handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
            Marshal.WriteIntPtr(handles, 0, startup.startup.stdin);
            Marshal.WriteIntPtr(handles, IntPtr.Size, startup.startup.stdout);
            Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, startup.startup.stderr);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020002), handles,
                new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)); // Only CLI pipes; never Job/status handles.
            stage = "create";
            Require(CreateProcess(file, new StringBuilder(args), IntPtr.Zero, IntPtr.Zero, true,
                0x08080004, IntPtr.Zero, cwd, ref startup, out process)); // NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | SUSPENDED
            started = true;
            input.DisposeLocalCopyOfClientHandle(); output.DisposeLocalCopyOfClientHandle(); errors.DisposeLocalCopyOfClientHandle();
            stage = "resume";
            Require(ResumeThread(process.thread) != UInt32.MaxValue);
            stage = "transport";
            var stop = new ManualResetEvent(false);
            var commands = new BlockingCollection<string>(16);
            commands.Add(first);
            // Stop/EOF remains readable even if the CLI stops reading its stdin.
            Task.Run(() => {
                try {
                    string line;
                    while ((line = parent.ReadLine()) != null && line != "__OCX_STOP_TRAE__") {
                        if (!commands.TryAdd(line)) { Frame("OCX_TRAE_ERROR:transport:0"); break; }
                    }
                } catch { Frame("OCX_TRAE_ERROR:transport:0"); }
                finally { stop.Set(); commands.CompleteAdding(); }
            });
            Task.Run(() => {
                try {
                    var writer = new StreamWriter(input, new UTF8Encoding(false)); writer.NewLine = "\n"; writer.AutoFlush = true;
                    foreach (string line in commands.GetConsumingEnumerable()) writer.WriteLine(line);
                } catch { stop.Set(); }
            });
            outTask = Task.Run(() => {
                try { output.CopyTo(Console.OpenStandardOutput()); }
                finally { stop.Set(); }
            });
            errTask = Task.Run(() => {
                try {
                    byte[] buffer = new byte[3072]; int count;
                    while ((count = errors.Read(buffer, 0, buffer.Length)) != 0)
                        Frame("OCX_TRAE_STDERR:" + Convert.ToBase64String(buffer, 0, count));
                } catch { stop.Set(); }
            });
            // Root exit also stops the job, including helpers that kept inherited pipes open.
            while (!stop.WaitOne(20) && WaitForSingleObject(process.process, 0) == 258) { }
        } catch (Exception error) {
            var native = error as Win32Exception;
            Frame("OCX_TRAE_ERROR:" + stage + ":" + (native == null ? 0 : native.NativeErrorCode));
        } finally {
            stopped = !started;
            if (started) {
                try {
                    Require(TerminateJobObject(job, 1));
                    var clock = Stopwatch.StartNew();
                    while (Active(job) != 0 && clock.ElapsedMilliseconds < joinMs) Thread.Sleep(10);
                    stopped = Active(job) == 0 && WaitForSingleObject(process.process, 0) == 0;
                } catch { stopped = false; }
            }
            if (job != IntPtr.Zero) CloseHandle(job);
            // Drain trailing stderr before reporting exit; every wait remains bounded.
            try { if (outTask != null && errTask != null) Task.WaitAll(new Task[] { outTask, errTask }, joinMs); }
            catch (AggregateException) { Frame("OCX_TRAE_ERROR:transport:0"); }
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
            if (process.process != IntPtr.Zero) CloseHandle(process.process);
            // Process exit releases private pipes/workers. Dispose could wait on a blocked write.
            Frame(stopped ? "OCX_TRAE_JOB_STOPPED" : "OCX_TRAE_JOB_STOP_FAILED");
        }
        return stopped ? 0 : 1;
    }
}
`;
