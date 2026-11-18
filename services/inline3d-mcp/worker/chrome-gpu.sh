#!/bin/sh
# Chrome as root in a container, on the real NVIDIA GPU through ANGLE's GL-EGL backend (without
# these flags it silently falls back to SwiftShader). Every request goes through guard-proxy.mjs,
# which refuses private, link-local and metadata addresses at connect time and allows loopback
# only (the checker's own server for check_files). <-loopback> removes Chrome's implicit bypass
# for loopback AND link-local (169.254.169.254 would otherwise go direct).
exec google-chrome --no-sandbox --disable-dev-shm-usage "$@" \
  --use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist \
  --proxy-server=http://127.0.0.1:8899 --proxy-bypass-list='<-loopback>' \
  --disable-quic --disable-background-networking --disable-sync --no-first-run --no-default-browser-check
