param([string]$Name = 'hops', [string]$Plan = 'hops', [int]$Count = 12)
# Recording session for the jump detection (see README.md): a beep count-in, then a hub recording
# (kinect-hub-probe record, from the running hub) while a German voice announces every move and a
# short beep marks the moment to do it. The cue times (s since the recording started) go to
# recordings\<Name>.cues.csv. Plans: 'hops' (hops: small, normal, high, then several in a row) and
# 'moves' (everything that is not a hop).
#   powershell -NoProfile -ExecutionPolicy Bypass -File record-session.ps1 -Name hops-2026-10-09 -Plan hops
Set-Location 'C:\Users\Jakob\Documents\kinect'
Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $voice.SelectVoice('Microsoft Hedda Desktop') } catch {}
$voice.Rate = 1

if ($Plan -eq 'hops') {
  $intro = 'Stell dich in die Mitte, zwei bis drei Meter vor die Kamera, und steh ruhig.'
  $cues = @(
    'klein', 'klein', 'klein', 'klein', 'klein',
    'normal', 'normal', 'normal', 'normal', 'normal',
    'hoch', 'hoch', 'hoch', 'hoch',
    'jetzt mehrmals hintereinander'
  )
  $gap = 3.5
  $tail = 9
} else {
  $intro = 'Stell dich in die Mitte, zwei bis drei Meter vor die Kamera. Nicht huepfen, nur die Bewegungen.'
  $cues = @(
    'Kniebeuge', 'Ducken', 'Zehenspitzen', 'Arme hoch', 'Knie wippen',
    'Schritt nach links', 'Schritt nach rechts', 'Vorbeugen', 'In die Hocke', 'Schnell aufstehen',
    'Ducken', 'Arme hoch und runter', 'Schnelle Kniebeuge', 'Ein paar Schritte gehen'
  )
  $gap = 4.5
  $tail = 6
}
$first = 7.0
$seconds = [int][math]::Ceiling($first + $gap * ($cues.Count - 1) + $tail)

Write-Host ''
Write-Host "  Aufnahme '$Name' ($seconds s) startet gleich." -ForegroundColor Yellow
for ($i = $Count; $i -ge 1; $i--) {
  Write-Host ('      {0} ...' -f $i) -ForegroundColor Yellow
  if ($i -le 3) { [console]::Beep(880, 250); Start-Sleep -Milliseconds 750 }
  else { [console]::Beep(660, 100); Start-Sleep -Milliseconds 900 }
}
$probeArgs = @('record', '--seconds', "$seconds", '--out', "recordings\$Name.k2rec")
$p = Start-Process -FilePath '.\kinect-hub\target\release\kinect-hub-probe.exe' -ArgumentList $probeArgs -NoNewWindow -PassThru
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$startUnix = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
[console]::Beep(1200, 600)
Write-Host '      LOS! Aufnahme laeuft.' -ForegroundColor Green
$voice.Speak($intro)

$log = New-Object System.Collections.Generic.List[string]
$log.Add('cue,text,t_s,unix_ms')
for ($k = 0; $k -lt $cues.Count; $k++) {
  $at = $first + $gap * $k
  # announce about 1.6 s before the beep
  while ($sw.Elapsed.TotalSeconds -lt ($at - 1.6)) { Start-Sleep -Milliseconds 20 }
  Write-Host ('      {0,5:N1} s  {1}' -f $at, $cues[$k]) -ForegroundColor Cyan
  $voice.Speak($cues[$k])
  while ($sw.Elapsed.TotalSeconds -lt $at) { Start-Sleep -Milliseconds 5 }
  $t = $sw.Elapsed.TotalSeconds
  $log.Add([string]::Format([cultureinfo]::InvariantCulture, '{0},{1},{2:F3},{3}', ($k + 1), $cues[$k], $t, ($startUnix + [int64]($t * 1000))))
  [console]::Beep(1500, 120)
}
$log | Set-Content -Encoding utf8 "recordings\$Name.cues.csv"
while (-not $p.HasExited) { Start-Sleep -Milliseconds 200 }
[console]::Beep(700, 300); [console]::Beep(500, 300); [console]::Beep(350, 800)
$voice.Speak('Fertig. Danke!')
Write-Host '      FERTIG.' -ForegroundColor Cyan
