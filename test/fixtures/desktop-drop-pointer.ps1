# Drives only the isolated Electron fixture on an interactive Windows desktop.
param(
  [switch]$Probe,
  [int]$StartX,
  [int]$StartY,
  [int]$EndX,
  [int]$EndY,
  [ValidateRange(1, 200)][int]$Steps = 40,
  [ValidateRange(1, 1000)][int]$StepDelayMs = 20,
  [ValidateRange(1, 3000)][int]$HoldMs = 300
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DesktopDropPointer {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int max);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
if (-not [Environment]::UserInteractive) { throw 'Native drag smoke requires an interactive Windows user session.' }
$desktop = [DesktopDropPointer]::OpenInputDesktop(0, $false, 0x0100)
if ($desktop -eq [IntPtr]::Zero) { throw 'Native drag smoke cannot access the interactive input desktop.' }
[void][DesktopDropPointer]::CloseDesktop($desktop)
if ($Probe) { Write-Output 'Interactive input desktop available'; exit 0 }
if (-not ($PSBoundParameters.ContainsKey('StartX') -and $PSBoundParameters.ContainsKey('StartY') -and $PSBoundParameters.ContainsKey('EndX') -and $PSBoundParameters.ContainsKey('EndY'))) {
  throw 'Supply physical pixel coordinates for both drag endpoints.'
}
[void][DesktopDropPointer]::SetProcessDPIAware()
$desktopLeft = [DesktopDropPointer]::GetSystemMetrics(76)
$desktopTop = [DesktopDropPointer]::GetSystemMetrics(77)
$desktopWidth = [DesktopDropPointer]::GetSystemMetrics(78)
$desktopHeight = [DesktopDropPointer]::GetSystemMetrics(79)
if ($desktopWidth -le 0 -or $desktopHeight -le 0) { throw 'Invalid input desktop dimensions.' }
function Move-Pointer([int]$x, [int]$y) {
  $absoluteX = [uint32][Math]::Floor(($x - $desktopLeft + 0.5) * 65536 / $desktopWidth)
  $absoluteY = [uint32][Math]::Floor(($y - $desktopTop + 0.5) * 65536 / $desktopHeight)
  # MOVE | MOVE_NOCOALESCE | VIRTUALDESK | ABSOLUTE also drives OLE's drag loop.
  [DesktopDropPointer]::mouse_event(0xE001, $absoluteX, $absoluteY, 0, [UIntPtr]::Zero)
}
function Confirm-Pointer([int]$x, [int]$y) {
  $actual = New-Object DesktopDropPointer+Point
  if (-not [DesktopDropPointer]::GetCursorPos([ref]$actual) -or $actual.X -ne $x -or $actual.Y -ne $y) {
    throw ('Input desktop cursor mismatch: expected {0},{1}, found {2},{3}.' -f $x,$y,$actual.X,$actual.Y)
  }
  $window = [DesktopDropPointer]::GetAncestor([DesktopDropPointer]::WindowFromPoint($actual), 2)
  $text = New-Object System.Text.StringBuilder 128
  [void][DesktopDropPointer]::GetWindowText($window, $text, $text.Capacity)
  # Only identify fixture titles. Do not log content from another desktop window.
  if ($text.ToString() -match '^Desktop Drop Fixture (Source|Backdrop)$') { Write-Output $text.ToString() }
  else { Write-Output 'Other desktop window' }
}
Move-Pointer $StartX $StartY
Start-Sleep -Milliseconds $HoldMs
Confirm-Pointer $StartX $StartY
$pressed = $false
try {
  [DesktopDropPointer]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  $pressed = $true
  Start-Sleep -Milliseconds $HoldMs
  for ($i = 1; $i -le $Steps; $i++) {
    $x = [int][Math]::Round($StartX + ($EndX - $StartX) * $i / $Steps)
    $y = [int][Math]::Round($StartY + ($EndY - $StartY) * $i / $Steps)
    Move-Pointer $x $y
    Start-Sleep -Milliseconds $StepDelayMs
  }
  # Let the target window receive drag-over after mouse-through is disabled.
  foreach ($offset in @(3, 0, 3, 0)) {
    Move-Pointer ($EndX + $offset) $EndY
    Start-Sleep -Milliseconds 80
  }
  Confirm-Pointer $EndX $EndY
} finally {
  if ($pressed) { [DesktopDropPointer]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) }
}
