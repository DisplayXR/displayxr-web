# local-open — disk HTML as localhost

WebXR (`inline-3d` included) needs a **secure context**. `file://` is not one, so a
double-clicked sample stays 2D even in the DisplayXR Browser. This helper does not
patch Chromium. It intercepts the DisplayXRHTML ProgId: `http(s)` still goes
straight to the browser; a disk path or `file://` is mounted on
`http://127.0.0.1:17880/` (localhost only) and DisplayXR is pointed at that URL.

The server root is the folder that already has `js/inline3d.js`, or else the git
root, or else the file's own directory — so sample imports like
`../../js/inline3d.js` still resolve. This is a **developer-machine helper**, not
a published SDK API, and must not be documented as one.

## Install

DisplayXR Browser must already be the Windows default for `.html` / `http` /
`https` (Settings → Apps → Default apps). Then:

```powershell
powershell -ExecutionPolicy Bypass -File tools/local-open/install.ps1
```

That copies this folder to `%LOCALAPPDATA%\DisplayXR\local-open` and points the
DisplayXRHTML ProgId at `open.cmd`. Double-click `samples/hello-cube/index.html`
and the address bar should be `http://127.0.0.1:17880/<token>/samples/hello-cube/index.html`,
not `file://`.

Needs Python 3 on `PATH` (`python` / `pythonw`).

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File tools/local-open/install.ps1 -Uninstall
```

Restores the ProgId to `chrome.exe` directly. The loopback server is left
stopped (it exits when idle / on reboot).

## What it does not do

- It does not make `file://` a secure context. The tab never stays on `file://`.
- It does not bind anything other than `127.0.0.1`.
- It does not change the DisplayXR Browser binary or the `@displayxr/inline3d` package.
