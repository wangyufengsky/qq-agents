using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class HomeBrowserJob
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Basic {
        public long PerProcessTime, PerJobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Extended {
        public Basic Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int type, ref Extended info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint rights, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint Faults, Total, Active, Terminated;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int type, ref Accounting info, uint size, out uint length);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public sealed class Control {
        public string nonce { get; set; }
        public string endpoint { get; set; }
        public bool stopping { get; set; }
    }

    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly Encoding Utf8 = new UTF8Encoding(false);
    private static string controlFile;
    private static string phase;

    private static void Write(string suffix, object value) {
        // Publish complete receipts; the wrapper polls while this process starts.
        string target = controlFile + suffix;
        File.WriteAllText(target + ".tmp", Json.Serialize(value), Utf8);
        File.Move(target + ".tmp", target);
    }

    private static void State(string stage, int code = 0, int active = -1) {
        phase = stage;
        try {
            File.WriteAllText(controlFile + ".job-state", Json.Serialize(new { stage, code, active }), Utf8);
        } catch (IOException) { }
    }

    private static void Require(bool success) {
        if (!success) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }

    private static void ConfirmCleanup(IntPtr job, string nonce, uint parentId, int pid) {
        State("terminating");
        Require(TerminateJobObject(job, 0));
        State("querying");
        Accounting stats = new Accounting();
        uint returned;
        Stopwatch elapsed = Stopwatch.StartNew();
        do {
            if (QueryInformationJobObject(job, 1, ref stats, (uint)Marshal.SizeOf(stats), out returned) && stats.Active == 0) {
                Write(".job-clean", new { nonce, parentPid = parentId, helperPid = pid, hostPid = pid, cleaned = true });
                State("cleaned", 0, 0);
                return;
            }
            Thread.Sleep(10);
        } while (elapsed.ElapsedMilliseconds < 1000);
        throw new InvalidOperationException("cleanup");
    }

    private static void Guard() {
        State("reading-control");
        Control control = Json.Deserialize<Control>(File.ReadAllText(controlFile));
        if (control.stopping) return;
        int pid = Process.GetCurrentProcess().Id;
        Write(".job-guardian", new { control.nonce, pid });
        IntPtr parent = IntPtr.Zero, job = IntPtr.Zero;
        bool assigned = false;
        uint parentId = 0;
        try {
            State("authenticating");
            // Bind the lifetime handle to the server of the authenticated pipe.
            // The control file never supplies a PID to terminate.
            const string prefix = @"\\.\pipe\";
            if (!control.endpoint.StartsWith(prefix, StringComparison.Ordinal)) throw new InvalidDataException();
            long created, exited, kernel, user;
            using (var pipe = new NamedPipeClientStream(".", control.endpoint.Substring(prefix.Length), PipeDirection.InOut)) {
                pipe.Connect(3000);
                Require(GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out parentId));
                parent = OpenProcess(0x101101, false, parentId);
                Require(parent != IntPtr.Zero);
                Require(GetProcessTimes(parent, out created, out exited, out kernel, out user));
                var writer = new StreamWriter(pipe, Utf8) { AutoFlush = true };
                writer.WriteLine("job:" + control.nonce);
                if (new StreamReader(pipe, Utf8).ReadLine() != "authorized") throw new InvalidDataException();
            }
            State("creating-job");
            job = CreateJobObject(IntPtr.Zero, null);
            Require(job != IntPtr.Zero);
            Extended limits = new Extended();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
            State("assigning");
            Require(AssignProcessToJobObject(job, parent));
            assigned = true;
            State("writing-ready");
            Write(".job-ready", new { control.nonce, parentPid = parentId, created = created.ToString(), helperPid = pid, hostPid = pid });
            State("waiting-parent");
            Require(WaitForSingleObject(parent, UInt32.MaxValue) == 0);
        } finally {
            // Release the process reference before checking the live job count.
            if (parent != IntPtr.Zero) CloseHandle(parent);
            if (job != IntPtr.Zero) {
                try {
                    if (assigned) ConfirmCleanup(job, control.nonce, parentId, pid);
                } finally { CloseHandle(job); }
            }
        }
    }

    private static int Main(string[] args) {
        if (args.Length != 1) return 1;
        controlFile = args[0];
        try { Guard(); return 0; }
        catch (Exception error) { State("failed-" + phase, error.HResult); return 1; }
    }
}
