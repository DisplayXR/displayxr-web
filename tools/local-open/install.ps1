# Install (or remove) the DisplayXR local-file → localhost opener.
# Copies this folder to %LOCALAPPDATA%\DisplayXR\local-open and points the
# DisplayXRHTML ProgId at open.cmd. Requires the per-user browser registration
# from earlier (Settings → Default apps → DisplayXR Browser).
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dst = Join-Path $env:LOCALAPPDATA 'DisplayXR\local-open'
$cmd = Join-Path $dst 'open.cmd'
$progId = 'HKCU:\Software\Classes\DisplayXRHTML\shell\open\command'
$browser = 'C:\Program Files\DisplayXR\Browser\chrome.exe'

if ($Uninstall) {
    if (Test-Path $progId) {
        Set-ItemProperty $progId -Name '(default)' -Value "`"$browser`" --single-argument %1"
    }
    Write-Output "Restored DisplayXRHTML to chrome.exe directly. Loopback server left stopped."
    exit 0
}

New-Item -ItemType Directory -Force -Path $dst | Out-Null
foreach ($name in 'server.py', 'launch.py', 'open.cmd') {
    Copy-Item -Force (Join-Path $src $name) (Join-Path $dst $name)
}

if (-not (Test-Path $progId)) {
    throw "DisplayXRHTML is not registered. Set DisplayXR as the default browser first."
}
Set-ItemProperty $progId -Name '(default)' -Value "`"$cmd`" --single-argument %1"
Write-Output "Installed. Local HTML now opens as http://127.0.0.1:17880/... in DisplayXR."
Write-Output "ProgId command: $((Get-ItemProperty $progId).'(default)')"
