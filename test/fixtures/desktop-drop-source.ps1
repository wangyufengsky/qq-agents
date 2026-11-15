# Provides an isolated OLE drag source for the native desktop smoke test.
param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][string]$FilePath,
  [Parameter(Mandatory = $true)][string]$Text,
  [Parameter(Mandatory = $true)][string]$Link
)
$ErrorActionPreference = 'Stop'
if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') {
  throw 'The native drag source requires PowerShell -STA.'
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class DesktopDropSourceDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[void][DesktopDropSourceDpi]::SetProcessDPIAware()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Desktop Drop Fixture Source'
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.ClientSize = New-Object System.Drawing.Size(180, 125)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None

function Add-DragRow([int]$top, [string]$label, [string]$kind, [System.Drawing.Color]$color) {
  $row = New-Object System.Windows.Forms.Label
  $row.Text = $label
  $row.Location = New-Object System.Drawing.Point(0, $top)
  $row.Size = New-Object System.Drawing.Size(180, 35)
  $row.BackColor = $color
  $row.Tag = $kind
  $row.Add_MouseDown({
    param($sender, $eventArgs)
    if ($eventArgs.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
    $data = New-Object System.Windows.Forms.DataObject
    switch ($sender.Tag) {
      'file' {
        $files = New-Object System.Collections.Specialized.StringCollection
        [void]$files.Add($FilePath)
        $data.SetFileDropList($files)
      }
      'link' {
        $data.SetText($Link)
        $data.SetData('UniformResourceLocatorW', $Link)
      }
      default { $data.SetText($Text) }
    }
    $effect = $sender.DoDragDrop($data, [System.Windows.Forms.DragDropEffects]::Copy)
    [Console]::Out.WriteLine("OLE $($sender.Tag): $effect")
    [Console]::Out.Flush()
  })
  $form.Controls.Add($row)
}
Add-DragRow 0 'Test text' 'text' ([System.Drawing.Color]::Beige)
Add-DragRow 35 'Test file' 'file' ([System.Drawing.Color]::Honeydew)
Add-DragRow 70 'Test link' 'link' ([System.Drawing.Color]::Lavender)
$form.Add_Shown({
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
})
[System.Windows.Forms.Application]::Run($form)
