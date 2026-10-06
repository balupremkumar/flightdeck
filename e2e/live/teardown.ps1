# Stops exactly the PID in .canary.pid and its descendants (walked by ParentProcessId). Never by name.
param([Parameter(Mandatory)][string]$PidFile, [Parameter(Mandatory)][string]$Exe)
$root = [int](Get-Content $PidFile -Raw)
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$root" -ErrorAction SilentlyContinue
if (-not $p) { "pid $root not running"; Remove-Item $PidFile -ErrorAction SilentlyContinue; return }
if ($p.ExecutablePath -ne $Exe) { throw "pid $root is $($p.ExecutablePath), not the Canary exe; refusing to stop it" }
$all = Get-CimInstance Win32_Process
$tree = New-Object System.Collections.Generic.List[int]
$queue = New-Object System.Collections.Generic.Queue[int]; $queue.Enqueue($root)
while ($queue.Count) {
  $c = $queue.Dequeue(); $tree.Add($c)
  $all | Where-Object { $_.ParentProcessId -eq $c -and $_.ProcessId -ne $c } | ForEach-Object { $queue.Enqueue([int]$_.ProcessId) }
}
$ids = $tree.ToArray(); [array]::Reverse($ids)   # leaves first
foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800
$left = $ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
"stopped $($ids.Count) process(es): $($ids -join ',')" + $(if ($left) { "; still alive: $($left -join ',')" } else { "" })
Remove-Item $PidFile -ErrorAction SilentlyContinue
