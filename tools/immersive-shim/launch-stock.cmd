@echo off
REM E1: the STOCK path (no shim). Enter VR here goes to Chrome's own OpenXR session and the
REM runtime-hosted fullscreen window (the behaviour the product blocks). You must click
REM "Allow" on the VR permission bubble. Run NON-elevated.
setlocal
set "PROFILE=%LOCALAPPDATA%\DisplayXR\immersive-stock-profile"
set XR_RUNTIME_JSON=
start "" "C:\Program Files\DisplayXR\Browser\chrome.exe" --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --enable-logging --log-file="%TEMP%\dxr_stock_chrome.log" --v=1 "https://immersive-web.github.io/webxr-samples/immersive-vr-session.html"
endlocal
