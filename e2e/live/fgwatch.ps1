# Samples GetForegroundWindow every 250 ms for -Seconds and writes JSONL (t_ms, hwnd, pid, title) to -Out.
# Read-only: never changes focus. Run it BEFORE launching so the pre-launch foreground is the first row.
param([Parameter(Mandatory)][string]$Out, [int]$Seconds = 15)
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class FgW {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string Sample() { var h = GetForegroundWindow(); uint p = 0; GetWindowThreadProcessId(h, out p); var sb = new StringBuilder(256); GetWindowText(h, sb, 256); return ((long)h) + "\t" + p + "\t" + sb.ToString(); }
}
"@
$sw = [Diagnostics.Stopwatch]::StartNew()
$rows = New-Object System.Collections.Generic.List[string]
while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
  $f = [FgW]::Sample().Split("`t", 3)
  $rows.Add((@{ t = [int]$sw.ElapsedMilliseconds; hwnd = [int64]$f[0]; pid = [int]$f[1]; title = $f[2] } | ConvertTo-Json -Compress))
  Start-Sleep -Milliseconds 250
}
Set-Content -Path $Out -Value $rows
