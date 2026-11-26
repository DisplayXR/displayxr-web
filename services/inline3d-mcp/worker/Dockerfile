# The hosted inline3d checker: @displayxr/inline3d-tools in headless Chrome on an NVIDIA GPU, as a
# RunPod serverless (queue) worker. Built and pushed to ghcr.io/displayxr/inline3d-checker by
# .github/workflows/inline3d-checker-image.yml. See ../README.md.
FROM node:22-bookworm-slim
ENV NVIDIA_DRIVER_CAPABILITIES=all DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates python3 python3-pip libvulkan1 libegl1 \
 && wget -q -O /tmp/c.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get install -y --no-install-recommends /tmp/c.deb && rm /tmp/c.deb \
 && pip3 install --no-cache-dir --break-system-packages runpod==1.9.1 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Keep this pin equal to the front end's (../package.json).
RUN npm i --omit=dev @displayxr/inline3d-tools@0.1.7 && npm cache clean --force
COPY chrome-gpu.sh guard-proxy.mjs ip-guard.mjs handler.py /app/
RUN chmod +x /app/chrome-gpu.sh
CMD ["python3", "-u", "/app/handler.py"]
