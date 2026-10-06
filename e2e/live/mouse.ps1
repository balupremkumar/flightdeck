# Real OS mouse for the W4 batch (Balu away from the mouse). One gesture per call: move to the first point, optional
# press, glide through the points in small steps, optional release. Physical screen pixels. Restores nothing; the
# caller parks the cursor at the end.
param(
  [Parameter(Mandatory)][string]$Points,   # "x1,y1;x2,y2;..."
  [switch]$Down, [switch]$Up,
  [int]$StepPx = 6, [int]$StepMs = 8, [int]$HoldMs = 120
)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class FdMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  public static void Press() { mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); }
  public static void Release() { mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); }
}
"@
$pts = @($Points.Split(";") | ForEach-Object { $a = $_.Split(","); @([int]$a[0], [int]$a[1]) })
[void][FdMouse]::SetCursorPos($pts[0][0], $pts[0][1])
Start-Sleep -Milliseconds 80
if ($Down) { [FdMouse]::Press(); Start-Sleep -Milliseconds $HoldMs }
for ($i = 1; $i -lt $pts.Count; $i++) {
  $x0 = $pts[$i - 1][0]; $y0 = $pts[$i - 1][1]; $x1 = $pts[$i][0]; $y1 = $pts[$i][1]
  $n = [Math]::Max(1, [int]([Math]::Sqrt(($x1 - $x0) * ($x1 - $x0) + ($y1 - $y0) * ($y1 - $y0)) / $StepPx))
  for ($k = 1; $k -le $n; $k++) {
    [void][FdMouse]::SetCursorPos([int]($x0 + ($x1 - $x0) * $k / $n), [int]($y0 + ($y1 - $y0) * $k / $n))
    Start-Sleep -Milliseconds $StepMs
  }
}
Start-Sleep -Milliseconds $HoldMs
if ($Up) { [FdMouse]::Release() }
"ok"
