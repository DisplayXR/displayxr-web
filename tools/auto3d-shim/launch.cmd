@echo off
REM Launch the installed DisplayXR Browser with the auto-3D prototype loaded, in its OWN profile.
REM CLOSE every other DisplayXR Browser window first: a second instance gets no weave slot and
REM renders 2D forever (displayxr-browser#162). Run NON-elevated.
REM Usage: launch.cmd [url]
setlocal
set "EXT=%~dp0"
set "EXT=%EXT:~0,-1%"
set "PROFILE=%LOCALAPPDATA%\DisplayXR\auto3d-shim-profile"
set "URL=%~1"
if "%URL%"=="" set "URL=https://threejs.org/examples/webgl_animation_keyframes.html"
start "" "C:\Program Files\DisplayXR\Browser\chrome.exe" ^
  --load-extension="%EXT%" ^
  --user-data-dir="%PROFILE%" ^
  --no-first-run --no-default-browser-check ^
  --disable-features=CalculateNativeWinOcclusion ^
  --enable-logging --log-file="%TEMP%\dxr_auto3d_chrome.log" --v=1 ^
  "%URL%"
endlocal
