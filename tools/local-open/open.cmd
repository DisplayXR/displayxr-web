@echo off
REM DisplayXR default-browser shim: local files are served on 127.0.0.1 so
REM WebXR/inline-3d can run. http(s) passes through to the browser unchanged.
setlocal EnableExtensions
set "HERE=%~dp0"
set "LAUNCH=%HERE%launch.py"

if "%~1"=="" (
  start "" "C:\Program Files\DisplayXR\Browser\chrome.exe"
  exit /b 0
)

if /I "%~1"=="--single-argument" (
  pythonw "%LAUNCH%" --single-argument -- "%~2"
  exit /b %ERRORLEVEL%
)

pythonw "%LAUNCH%" -- %*
exit /b %ERRORLEVEL%
