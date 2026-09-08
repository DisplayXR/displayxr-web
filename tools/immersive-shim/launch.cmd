@echo off
REM Launch the installed DisplayXR Browser with the immersive-vr shim loaded, in its OWN
REM profile (so it never hands the URL to an already-running instance) and with logging on.
REM Run NON-elevated (double-click, or explorer.exe "launch.cmd" from an elevated shell).
REM Usage: launch.cmd [url]
setlocal
set "SHIM=%~dp0"
set "SHIM=%SHIM:~0,-1%"
set "PROFILE=%LOCALAPPDATA%\DisplayXR\immersive-shim-profile"
set "URL=%~1"
if "%URL%"=="" set "URL=https://immersive-web.github.io/webxr-samples/"
start "" "C:\Program Files\DisplayXR\Browser\chrome.exe" ^
  --load-extension="%SHIM%" ^
  --user-data-dir="%PROFILE%" ^
  --no-first-run --no-default-browser-check ^
  --disable-features=CalculateNativeWinOcclusion ^
  --enable-logging --log-file="%TEMP%\dxr_shim_chrome.log" --v=1 ^
  "%URL%"
endlocal
