# Window helper for the live Canary harness. Positions/sizes the top-level window(s) of ONE pid
# with SWP_NOACTIVATE | SWP_NOZORDER, so it never takes foreground or sends input.
# Modes: move (default), info, foreground, release (hand foreground back if this pid holds it: minimise, then SHOWNOACTIVATE).
param(
  [Parameter(Mandatory)][int]$ProcessId,
  [string]$Mode = "move",
  [int]$X = -20000, [int]$Y = 0, [int]$Width = 0, [int]$Height = 0,
  [int]$WaitMs = 0
)
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class FdWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<IntPtr> ForPid(uint pid, bool visibleOnly) {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && (!visibleOnly || IsWindowVisible(h))) r.Add(h); return true; }, IntPtr.Zero);
    return r;
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); return sb.ToString(); }
  public static int[] Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return new[] { r.L, r.T, r.R - r.L, r.B - r.T }; }
  public static bool Iconic(IntPtr h) { return IsIconic(h); }
  public static bool Move(IntPtr h, int x, int y, int w, int hh) {
    if (IsIconic(h)) ShowWindow(h, 4);   // SW_SHOWNOACTIVATE: un-minimise without activating
    uint f = 0x0004 | 0x0010; if (w <= 0 || hh <= 0) f |= 0x0001;
    return SetWindowPos(h, IntPtr.Zero, x, y, w, hh, f);
  }
  public static void Show(IntPtr h, int cmd) { ShowWindow(h, cmd); }
  public static bool IsForeground(IntPtr h) { return GetForegroundWindow() == h; }
  public static string Foreground() {
    var h = GetForegroundWindow(); uint p = 0; GetWindowThreadProcessId(h, out p);
    return p + "|" + Title(h);
  }
}
"@
if ($Mode -eq "foreground") { [FdWin]::Foreground(); return }
if ($Mode -eq "release") {
  foreach ($h in [FdWin]::ForPid([uint32]$ProcessId, $true)) {
    if ([FdWin]::IsForeground($h)) { [FdWin]::Show($h, 6); Start-Sleep -Milliseconds 300; [FdWin]::Show($h, 4) }
  }
  [FdWin]::Foreground(); return
}
$deadline = [DateTime]::UtcNow.AddMilliseconds($WaitMs)
$out = @()
do {
  $wins = [FdWin]::ForPid([uint32]$ProcessId, ($Mode -ne "info")) | Where-Object { [FdWin]::Rect($_)[2] -gt 200 -or [FdWin]::Iconic($_) -or $Mode -eq "info" }
  $out = @(foreach ($h in $wins) {
    if ($Mode -eq "move") { [void][FdWin]::Move($h, $X, $Y, $Width, $Height) }
    $rect = [FdWin]::Rect($h)
    @{ hwnd = [int64]$h; title = [FdWin]::Title($h); x = $rect[0]; y = $rect[1]; w = $rect[2]; h = $rect[3]; iconic = [FdWin]::Iconic($h) }
  })
  Start-Sleep -Milliseconds 25
} while ([DateTime]::UtcNow -lt $deadline)
$out | ConvertTo-Json -Compress
