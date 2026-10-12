@echo off
rem Kinect-Aufnahme fuer "Kabel richtig aufwickeln" (mocap/aufnahme.py).
rem Doppelklick: Menue. Mit Argumenten, z. B.:
rem   aufnahme.cmd --session 1        Termin 1 (A, B, T), macht dort weiter, wo du aufgehoert hast
rem   aufnahme.cmd --setup A --prio 1
rem   aufnahme.cmd --shot p3.pair.slow
rem   aufnahme.cmd --list   /   --status   /   --help
rem Vorher muss der Hub laufen (kinect-hub\target\release\kinect-hub.exe im Hauptordner), nicht start-wand.cmd.
setlocal
set "PYTHONUTF8=1"
if "%~1"=="" set "AUFNAHME_PAUSE=1"
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo Python 3 fehlt. Installiere es von https://www.python.org/downloads/
  echo und setz bei der Installation den Haken "Add python.exe to PATH".
  pause
  exit /b 1
)
%PY% "%~dp0aufnahme.py" %*
