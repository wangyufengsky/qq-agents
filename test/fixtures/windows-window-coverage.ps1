# Samples Win32/DWM metadata on the CI desktop. No window title or pixels are read.
param([Parameter(Mandatory = $true)][long]$TargetHandle)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class CoverageProbe {
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo { public int Size; public Rect Bounds, Work; public int Flags; }

    [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr awareness);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetTopWindow(IntPtr parent);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint relative);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int metric);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out Rect value, int size);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out int value, int size);

    private const uint NextWindowInZOrder = 2;
    private const uint DwmFrameBounds = 9;
    private const uint DwmCloaked = 14;

    private static object Bounds(Rect rect) {
        return new { x = rect.Left, y = rect.Top, width = rect.Right - rect.Left, height = rect.Bottom - rect.Top };
    }

    public static object Read(long targetHandle) {
        var desktop = OpenInputDesktop(0, false, 0x0100);
        if (desktop == IntPtr.Zero) throw new InvalidOperationException("Input desktop unavailable");
        CloseDesktop(desktop);
        var previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previousDpi == IntPtr.Zero) throw new InvalidOperationException("Per-monitor DPI context unavailable");
        try {
            var target = new IntPtr(targetHandle);
            var monitor = MonitorFromWindow(target, 0);
            var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
            object display = null;
            if (monitor != IntPtr.Zero && GetMonitorInfo(monitor, ref info)) {
                display = new { bounds = Bounds(info.Bounds), workArea = Bounds(info.Work), count = GetSystemMetrics(80) };
            }
            uint pid;
            GetWindowThreadProcessId(target, out pid);
            string instance = null;
            if (pid != 0) {
                using (var owner = Process.GetProcessById((int)pid)) {
                    instance = owner.StartTime.ToUniversalTime().Ticks.ToString();
                }
            }
            var foreground = GetForegroundWindow();
            var visited = new HashSet<IntPtr>();
            var windows = new List<object>();
            var complete = true;
            for (var handle = GetTopWindow(IntPtr.Zero); handle != IntPtr.Zero; handle = GetWindow(handle, NextWindowInZOrder)) {
                if (!visited.Add(handle) || visited.Count > 4096) { complete = false; break; }
                if (!IsWindowVisible(handle) || IsIconic(handle)) continue;
                int cloaked;
                if (DwmGetWindowAttribute(handle, DwmCloaked, out cloaked, sizeof(int)) == 0 && cloaked != 0) continue;
                Rect rect;
                var dwm = DwmGetWindowAttribute(handle, DwmFrameBounds, out rect, Marshal.SizeOf(typeof(Rect))) == 0;
                if (!dwm && !GetWindowRect(handle, out rect)) { complete = false; continue; }
                if (rect.Right <= rect.Left || rect.Bottom <= rect.Top) continue;
                windows.Add(new { id = handle.ToInt64().ToString(), bounds = Bounds(rect) });
            }
            return new {
                complete = complete && visited.Count > 0 && foreground == GetForegroundWindow(),
                foregroundId = foreground.ToInt64().ToString(),
                display, windows, ownerPid = pid, processInstance = instance, dpi = GetDpiForWindow(target)
            };
        } finally { SetThreadDpiAwarenessContext(previousDpi); }
    }
}
'@
ConvertTo-Json -InputObject ([CoverageProbe]::Read($TargetHandle)) -Depth 8 -Compress
