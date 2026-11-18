#!/bin/sh
# Chrome as root in a container, on the real NVIDIA GPU through ANGLE's GL-EGL backend (without
# these flags it silently falls back to SwiftShader). Every non-loopback request goes through
# guard-proxy.mjs, which refuses private, link-local and metadata addresses at connect time.
# Loopback bypasses it: that is the checker's own server for check_files (the job's files only).
exec google-chrome --no-sandbox --disable-dev-shm-usage "$@" \
  --use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist \
  --proxy-server=http://127.0.0.1:8899 \
  --disable-quic --disable-background-networking --disable-sync --no-first-run --no-default-browser-check
