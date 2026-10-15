# Puts the wand-video kiosk onto a Raspberry Pi OS (Trixie) SD card that is mounted in Windows.
# Only touches the boot partition (FAT): cloud-init files, cmdline.txt, config.txt, wand-video\.
#   powershell -NoProfile -ExecutionPolicy Bypass -File pi-video-loop\update-card.ps1 -Drive D: -Media <dir with loop.mov and debs\>
param(
  [string]$Drive = "D:",
  [string]$Media = ""
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$boot = "$Drive\"

if (-not (Test-Path "$boot\cmdline.txt") -or -not (Select-String -Quiet -Path "$boot\issue.txt" -Pattern "Raspberry Pi reference")) {
  throw "$Drive is not a Raspberry Pi OS boot partition"
}

function Write-Lf([string]$src, [string]$dst) {
  $t = [IO.File]::ReadAllText($src) -replace "`r`n", "`n"
  [IO.File]::WriteAllText($dst, $t, (New-Object Text.UTF8Encoding $false))
}

# cloud-init: user, early install on every boot, new instance id so the card re-runs its setup
Write-Lf "$here\boot\user-data" "$boot\user-data"
Write-Lf "$here\boot\meta-data" "$boot\meta-data"

# Kernel command line: one line; no login prompt on the screen, no boot text, no cursor
$cmd = ([IO.File]::ReadAllText("$boot\cmdline.txt") -replace "[\r\n]+", " ").Trim()
$cmd = $cmd -replace "console=tty1\b", "console=tty3"
foreach ($opt in "quiet", "loglevel=3", "logo.nologo", "vt.global_cursor_default=0", "consoleblank=0", "systemd.mask=getty@tty1.service") {
  if (-not ($cmd -split " " -contains $opt)) { $cmd += " $opt" }
}
# Next boot runs only firstrun.sh (installs, removes these options again, reboots into the video)
$cmd = ($cmd -replace " systemd\.(run|run_success_action|run_failure_action)=\S*", "" -replace " systemd\.unit=kernel-command-line\.target", "")
$cmd += " systemd.run=/boot/firmware/wand-video/firstrun.sh systemd.run_success_action=reboot systemd.run_failure_action=reboot systemd.unit=kernel-command-line.target"
[IO.File]::WriteAllText("$boot\cmdline.txt", "$cmd`n", (New-Object Text.UTF8Encoding $false))

# config.txt: no rainbow splash
$cfg = [IO.File]::ReadAllText("$boot\config.txt")
if ($cfg -notmatch "(?m)^disable_splash=1") {
  [IO.File]::AppendAllText("$boot\config.txt", "# Wand-Video kiosk: no rainbow splash at power-on`ndisable_splash=1`n")
}

# Player, setup and settings
$wv = "$boot\wand-video"
New-Item -ItemType Directory -Force "$wv\debs" | Out-Null
foreach ($f in "firstrun.sh", "install.sh", "wand-video.sh", "wand-video.service") { Write-Lf "$here\wand-video\$f" "$wv\$f" }
if (-not (Test-Path "$wv\wand-video.conf")) { Copy-Item "$here\wand-video\wand-video.conf" $wv }
Copy-Item "$here\wand-video\LIESMICH.txt" $wv -Force

# Video and offline packages (only when given and not yet on the card)
if ($Media) {
  if (-not (Test-Path "$wv\loop.mov") -or (Get-Item "$wv\loop.mov").Length -ne (Get-Item "$Media\loop.mov").Length) {
    Copy-Item "$Media\loop.mov" $wv -Force
  }
  foreach ($d in Get-ChildItem "$Media\debs\*.deb") {
    if (-not (Test-Path "$wv\debs\$($d.Name)")) { Copy-Item $d.FullName "$wv\debs" }
  }
}
Write-VolumeCache -DriveLetter $Drive.TrimEnd(":")
"cmdline.txt: $cmd"
"debs on card: " + (Get-ChildItem "$wv\debs\*.deb").Count + ", loop.mov: " + (Test-Path "$wv\loop.mov")
