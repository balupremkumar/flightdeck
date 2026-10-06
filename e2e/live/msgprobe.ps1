# Main-thread stall probe: SendMessageTimeout(WM_NULL, SMTO_ABORTIFHUNG) to the Canary main window every ~100 ms.
# Appends JSONL {t, ms, ok}. WM_NULL does nothing and never activates a window. Stops after -Seconds or when -StopFile exists.
param([Parameter(Mandatory)][int]$ProcessId, [Parameter(Mandatory)][string]$Out, [int]$Seconds = 120, [string]$StopFile = "")
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class Mp {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr res);
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); if (sb.ToString().StartsWith("Flightdeck")) { found = h; return false; } } return true; }, IntPtr.Zero);
    return found;
  }
  public static bool Ping(IntPtr h) { IntPtr r; return SendMessageTimeout(h, 0, IntPtr.Zero, IntPtr.Zero, 2, 5000, out r) != IntPtr.Zero; }
}
"@
$h = [Mp]::Find([uint32]$ProcessId)
if ($h -eq [IntPtr]::Zero) { throw "no main window for pid $ProcessId" }
$sw = [Diagnostics.Stopwatch]::StartNew()
$fs = [IO.StreamWriter]::new($Out, $false, [Text.UTF8Encoding]::new($false)); $fs.AutoFlush = $true
try {
  while ($sw.Elapsed.TotalSeconds -lt $Seconds -and -not ($StopFile -and (Test-Path $StopFile))) {
    $t0 = $sw.ElapsedMilliseconds
    $ok = [Mp]::Ping($h)
    $ms = $sw.ElapsedMilliseconds - $t0
    $fs.WriteLine("{`"t`":$t0,`"ms`":$ms,`"ok`":$($ok.ToString().ToLower())}")
    Start-Sleep -Milliseconds 100
  }
} finally { $fs.Dispose() }
