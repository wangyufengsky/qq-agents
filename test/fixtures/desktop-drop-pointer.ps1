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
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int x, int y);
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
function Move-Pointer([int]$x, [int]$y) {
  if (-not [DesktopDropPointer]::SetCursorPos($x, $y)) { throw 'SetCursorPos failed on the interactive desktop.' }
  $actual = New-Object DesktopDropPointer+Point
  if (-not [DesktopDropPointer]::GetCursorPos([ref]$actual) -or $actual.X -ne $x -or $actual.Y -ne $y) {
    throw 'The interactive desktop did not accept the requested pointer position.'
  }
}
Move-Pointer $StartX $StartY
Start-Sleep -Milliseconds $HoldMs
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
} finally {
  if ($pressed) { [DesktopDropPointer]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) }
}
