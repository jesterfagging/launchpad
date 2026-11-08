@echo off
rem Starts the sample-data preview of the Launchpad UI from this repository.
rem Needs Node 22+. Open http://127.0.0.1:4173 (admin: /admin?mockSession=admin).
cd /d "%~dp0"
if "%PORT%"=="" set PORT=4173
node server.mjs
pause
