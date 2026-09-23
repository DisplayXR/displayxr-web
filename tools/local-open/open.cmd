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

REM Chromium implements --single-argument as "the rest of the command line is
REM one value". cmd.exe does not: an unquoted path with spaces (C:\Users\SR
REM Laptop\...) becomes several tokens. Pass every token through; launch.py
REM joins them when the combined path exists.
pythonw "%LAUNCH%" -- %*
exit /b %ERRORLEVEL%
