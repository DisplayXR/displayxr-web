@echo off
REM Agent-diagnostic launch: same as launch.cmd + CDP on :9334. Run NON-elevated (explorer.exe on this file).
setlocal
set "SHIM=%~dp0"
set "SHIM=%SHIM:~0,-1%"
set "PROFILE=%LOCALAPPDATA%\DisplayXR\immersive-shim-profile"
set "URL=%~1"
if "%URL%"=="" set "URL=https://immersive-web.github.io/webxr-samples/immersive-vr-session.html"
set XR_RUNTIME_JSON=
start "" "C:\Program Files\DisplayXR\Browser\chrome.exe" --load-extension="%SHIM%" --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --disable-features=CalculateNativeWinOcclusion --start-maximized --remote-debugging-port=9334 --remote-allow-origins=* --enable-logging --log-file="%TEMP%\dxr_shim_chrome.log" --v=1 %2 "%URL%"
endlocal
