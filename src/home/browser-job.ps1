param([Parameter(Mandatory=$true)][string]$ControlFile)
$ErrorActionPreference = 'Stop'
$script:phase = 'compiling'
function Report-State([string]$Stage, [int]$Code=0, [int]$Active=-1) {
 $script:phase = $Stage
 try {
  $state = @{ stage=$Stage; code=$Code; active=$Active } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($ControlFile + '.job-state', $state, [System.Text.UTF8Encoding]::new($false))
 } catch { }
}
Report-State 'compiling'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HomeBrowserJob {
 [StructLayout(LayoutKind.Sequential)] public struct Basic {
  public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking;
  public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
 }
 [StructLayout(LayoutKind.Sequential)] public struct Io { public ulong A,B,C,D,E,F; }
 [StructLayout(LayoutKind.Sequential)] public struct Extended {
  public Basic Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
 }
 [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job, int type, ref Extended info, uint size);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint rights, bool inherit, uint pid);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
 [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
 [StructLayout(LayoutKind.Sequential)] public struct Accounting {
  public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, Total, Active, Terminated;
 }
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr job, int type, ref Accounting info, uint size, out uint length);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$job = [IntPtr]::Zero
$parentHandle = [IntPtr]::Zero
$assigned = $false
try {
 $control = Get-Content -LiteralPath $ControlFile -Raw | ConvertFrom-Json
 if ($control.stopping) { exit 0 }
 # The helper accepts no PID. Open its actual parent's handle before asking that
 # live parent to authenticate; PID reuse after the handshake cannot retarget it.
 Report-State 'opening-parent'
 $parentId = [uint32](Get-CimInstance Win32_Process -Filter "ProcessId = $PID").ParentProcessId
 $parentHandle = [HomeBrowserJob]::OpenProcess(0x101101, $false, $parentId)
 if ($parentHandle -eq [IntPtr]::Zero) { throw 'parent' }
 [long]$created=0; [long]$exited=0; [long]$kernel=0; [long]$user=0
 if (-not [HomeBrowserJob]::GetProcessTimes($parentHandle,[ref]$created,[ref]$exited,[ref]$kernel,[ref]$user)) { throw 'identity' }
 Report-State 'authenticating'
 $pipeName = $control.endpoint.Substring(9)
 $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
 try {
  $pipe.Connect(3000)
  $writer = [System.IO.StreamWriter]::new($pipe); $writer.AutoFlush = $true
  $reader = [System.IO.StreamReader]::new($pipe)
  $writer.WriteLine('job:' + $control.nonce)
  if ($reader.ReadLine() -ne 'authorized') { throw 'authority' }
 } finally { $pipe.Dispose() }
 Report-State 'creating-job'
 $job = [HomeBrowserJob]::CreateJobObject([IntPtr]::Zero, $null)
 if ($job -eq [IntPtr]::Zero) { throw 'job' }
 $info = New-Object HomeBrowserJob+Extended
 $basic = New-Object HomeBrowserJob+Basic
 $basic.Flags = 0x2000 # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
 $info.Basic = $basic
 if (-not [HomeBrowserJob]::SetInformationJobObject($job,9,[ref]$info,[System.Runtime.InteropServices.Marshal]::SizeOf($info))) { throw 'limits' }
 Report-State 'assigning'
 if (-not [HomeBrowserJob]::AssignProcessToJobObject($job,$parentHandle)) { throw 'assign' }
 $assigned = $true
 Report-State 'writing-ready'
 $ready = @{ nonce=$control.nonce; parentPid=$parentId; created=[string]$created; helperPid=$PID } | ConvertTo-Json -Compress
 [System.IO.File]::WriteAllText($ControlFile + '.job-ready', $ready, [System.Text.UTF8Encoding]::new($false))
 Report-State 'waiting-parent'
 [void][HomeBrowserJob]::WaitForSingleObject($parentHandle, [uint32]::MaxValue)
} catch {
 Report-State ('failed-' + $script:phase) $_.Exception.HResult
 [Console]::Error.WriteLine('HOME_SCENE_RENDER_FAILED')
 exit 1
} finally {
 # Job accounting retains terminated members while external process references
 # remain open. Release this identity/wait handle before waiting for Active=0.
 if ($parentHandle -ne [IntPtr]::Zero) {
  [void][HomeBrowserJob]::CloseHandle($parentHandle)
  $parentHandle = [IntPtr]::Zero
 }
 # The helper was born before assignment and stays outside the job. Its handle
 # closure kills every job member, including descendants of an exited browser.
 if ($job -ne [IntPtr]::Zero) {
  if ($assigned) {
   Report-State 'terminating'
   [void][HomeBrowserJob]::TerminateJobObject($job, 0)
   $accounting = New-Object HomeBrowserJob+Accounting
   [uint32]$returned=0
   Report-State 'querying'
   $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(1)
   do {
    $queried = [HomeBrowserJob]::QueryInformationJobObject($job,1,[ref]$accounting,[System.Runtime.InteropServices.Marshal]::SizeOf($accounting),[ref]$returned)
    if (-not $queried -or $accounting.Active -ne 0) { Start-Sleep -Milliseconds 10 }
   } while ((-not $queried -or $accounting.Active -ne 0) -and [DateTime]::UtcNow -lt $cleanupDeadline)
   if (-not $queried -or $accounting.Active -ne 0) {
    [void][HomeBrowserJob]::CloseHandle($job); $job = [IntPtr]::Zero
    Report-State 'cleanup-failed' ([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()) $accounting.Active
    throw 'HOME_SCENE_RENDER_FAILED'
   }
   Report-State 'writing-clean' 0 $accounting.Active
   $complete = @{ nonce=$control.nonce; parentPid=$parentId; helperPid=$PID; cleaned=$true } | ConvertTo-Json -Compress
   $temporary = $ControlFile + '.job-clean.tmp'
   [System.IO.File]::WriteAllText($temporary, $complete, [System.Text.UTF8Encoding]::new($false))
   [System.IO.File]::Move($temporary, $ControlFile + '.job-clean')
   Report-State 'cleaned' 0 0
  }
  [void][HomeBrowserJob]::CloseHandle($job)
 }
 if ($parentHandle -ne [IntPtr]::Zero) { [void][HomeBrowserJob]::CloseHandle($parentHandle) }
}
