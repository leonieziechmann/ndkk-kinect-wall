@echo off
rem Auswertung der Mocap-Takes fuer "Kabel richtig aufwickeln" (mocap/auswerten.py).
rem Beispiele:
rem   auswerten.cmd C:\Pfad\zu\ndkk-kinect-wall\recordings\mocap\termin1          alle behaltenen Takes
rem   auswerten.cmd --modell leicht ...\termin1\p1.coil.teach_t1.k2rec              schneller Test (nur Koerper)
rem   auswerten.cmd --device dml --every 2 ...\termin1                              Grafik des Notebooks, jeder 2. Frame
rem   auswerten.cmd --help
rem Anleitung: mocap\README.md, Abschnitt "Auswerten".
setlocal
set "PYTHONUTF8=1"
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
%PY% "%~dp0auswerten.py" %*
if "%~1"=="" pause