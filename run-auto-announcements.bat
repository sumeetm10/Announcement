@echo off
REM run-auto-announcements.bat
REM Wrapper for Windows Task Scheduler. Runs auto-post-announcements.js with
REM stdout/stderr captured to a dated log file under logs\.
REM
REM Cron schedule (set in Task Scheduler):
REM   Morning task:  every 30 min, 7:00 AM - 10:00 AM
REM   Evening task:  every 30 min, 4:00 PM - 8:00 PM

setlocal

REM Resolve the directory this batch lives in (handles paths with spaces)
set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

REM Ensure logs/ directory exists
if not exist logs mkdir logs

REM Build a YYYY-MM-DD-stamped log filename
REM %date% format depends on locale — using powershell here for predictability
for /f "usebackq tokens=*" %%i in (`powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"`) do set DATE_STAMP=%%i
set LOG_FILE=logs\auto-%DATE_STAMP%.log

echo. >> "%LOG_FILE%"
echo ============================================== >> "%LOG_FILE%"
echo Run started: %DATE% %TIME% >> "%LOG_FILE%"
echo ============================================== >> "%LOG_FILE%"

REM Run the Node script; tee stdout+stderr into the daily log
node auto-post-announcements.js >> "%LOG_FILE%" 2>&1
set EXIT_CODE=%ERRORLEVEL%

echo Run ended:   %DATE% %TIME% (exit %EXIT_CODE%) >> "%LOG_FILE%"

REM Forward exit code so Task Scheduler shows success/failure correctly
exit /b %EXIT_CODE%
