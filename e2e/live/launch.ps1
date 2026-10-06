# Starts the Canary exe OUTSIDE the calling process tree/job object (Win32_Process.Create runs it under
# WmiPrvSE) with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS set on that one process only, never globally.
# Prints the PID. The window is moved off-screen (NOACTIVATE) as soon as it appears.
param(
  [Parameter(Mandatory)][string]$Exe,
  [Parameter(Mandatory)][string]$PidFile,
  [int]$Port = 9333
)
$ErrorActionPreference = "Stop"
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "port $Port already in use" }
$wvArgs = "--remote-debugging-port=$Port --disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-backgrounding-occluded-windows"
# Current environment, minus this agent session's own markers so a pane's Claude does not think it is nested.
$drop = '^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK.*|AI_AGENT|WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS)$'
$envs = New-Object System.Collections.Generic.List[string]
foreach ($e in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
  if ($e.Key -match $drop) { continue }
  $envs.Add("$($e.Key)=$($e.Value)")
}
$envs.Add("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=$wvArgs")
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
  ShowWindow = [uint16]7   # SW_SHOWMINNOACTIVE
  EnvironmentVariables = [string[]]$envs.ToArray()
}
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = "`"$Exe`""
  CurrentDirectory = (Split-Path $Exe)
  ProcessStartupInformation = $startup
}
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed: $($r.ReturnValue)" }
Set-Content -Path $PidFile -Value $r.ProcessId -NoNewline
# Move the window off-screen the moment it exists (polls every ~25 ms for up to 20 s).
$win = Join-Path $PSScriptRoot "window.ps1"
& $win -ProcessId $r.ProcessId -Mode move -X -20000 -Y 0 -WaitMs 20000 | Out-Null
# The app calls set_focus() on RunEvent::Ready, which can take foreground even from a WMI-launched process.
# If it did, hand foreground back (minimise then SW_SHOWNOACTIVATE; no SetForegroundWindow).
& $win -ProcessId $r.ProcessId -Mode release | Out-Null
$r.ProcessId
