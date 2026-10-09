@echo off
rem Startet alles fuer die LED-Wand (Doppelklick). Beenden mit Q im Fenster, NOTAUS: Strg+Alt+Shift+N.
rem Optionen werden weitergereicht, z. B.: start-wand.cmd -NoWall
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-wand.ps1" %*
if errorlevel 1 pause
