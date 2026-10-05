@echo off
cd /d "%~dp0"
set PY=C:\Users\star\.workbuddy\binaries\python\versions\3.13.12\python.exe
if not exist "%PY%" set PY=python
echo Starting local server at http://localhost:8123
echo The LAN address for phones/tablets is printed below (http://192.168.x.x:8123).
echo (Keep this window open. Close it or press Ctrl+C to stop.)
start "" http://localhost:8123
"%PY%" "%~dp0serve.py" 8123
pause
