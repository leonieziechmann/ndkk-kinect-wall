# load.ps1 - CPU and GPU load per process over a time window, to go with pose-bench runs.
#   powershell -ExecutionPolicy Bypass -File load.ps1 -Seconds 20 [-Top 8] [-Hub http://127.0.0.1:8090]
# CPU: processor time each process used in the window, in cores (1.0 = one core busy).
# GPU: Windows "GPU Engine" counters, per process and engine type (3D, Compute, Copy, ...) in percent
# of that engine, averaged over the window; "total" is the busiest engine summed over all processes,
# as Task Manager shows it. Hub: frames the hub received from the sensor per second in the window.
param([int]$Seconds = 20, [int]$Top = 8, [string]$Hub = 'http://127.0.0.1:8090')

function HubFrames { try { (Invoke-RestMethod -Uri "$Hub/api/status" -TimeoutSec 2).frames } catch { $null } }
$hub0 = HubFrames

$cpu0 = @{}
$names = @{}  # also processes that end during the window keep their name
foreach ($p in Get-Process) { $names[$p.Id] = $p.ProcessName; try { $cpu0[$p.Id] = $p.TotalProcessorTime.TotalSeconds } catch {} }
$t0 = Get-Date
$samples = Get-Counter -Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 1 -MaxSamples $Seconds -ErrorAction SilentlyContinue
$wall = ((Get-Date) - $t0).TotalSeconds
$hub1 = HubFrames
$cpu = @{}
foreach ($p in Get-Process) {
  $names[$p.Id] = $p.ProcessName
  if ($cpu0.ContainsKey($p.Id)) { try { $cpu[$p.Id] = ($p.TotalProcessorTime.TotalSeconds - $cpu0[$p.Id]) / $wall } catch {} }
}

# GPU: sum per (pid, engine type) per sample, then average over the samples
$per = @{}
$engTotal = @{}
foreach ($s in $samples) {
  $engNow = @{}
  foreach ($c in $s.CounterSamples) {
    if ($c.InstanceName -notmatch 'pid_(\d+)_.*engtype_(.+)$') { continue }
    $key = "$($Matches[1])|$($Matches[2])"
    $per[$key] = ($per[$key] + $c.CookedValue)
    $engNow[$Matches[2]] = ($engNow[$Matches[2]] + $c.CookedValue)
  }
  foreach ($e in $engNow.Keys) { $engTotal[$e] = ($engTotal[$e] + $engNow[$e]) }
}
$n = [Math]::Max(1, @($samples).Count)
"window {0:N1} s, {1} GPU samples" -f $wall, $n
if ($null -ne $hub0 -and $null -ne $hub1) { "sensor at the hub: {0:N1} fps" -f (($hub1 - $hub0) / $wall) }
"GPU total by engine (%):  " + (($engTotal.GetEnumerator() | Sort-Object Value -Descending | Where-Object { $_.Value / $n -ge 0.5 } | ForEach-Object { "{0} {1:N1}" -f $_.Key, ($_.Value / $n) }) -join ' | ')
"GPU per process (%):"
$per.GetEnumerator() | Where-Object { $_.Value / $n -ge 0.5 } | Sort-Object Value -Descending | Select-Object -First $Top | ForEach-Object {
  $procId, $eng = $_.Key -split '\|'
  "  {0,-24} pid {1,-6} {2,-10} {3,6:N1}" -f $names[[int]$procId], $procId, $eng, ($_.Value / $n)
}
"CPU per process (cores):"
$cpu.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First $Top | ForEach-Object {
  "  {0,-24} pid {1,-6} {2,6:N2}" -f $names[$_.Key], $_.Key, $_.Value
}
"CPU total (cores of 12): {0:N2}" -f (($cpu.Values | Measure-Object -Sum).Sum)
