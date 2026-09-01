# Mario Arena — the single global Super Mario 64.
#
# One container holds three processes: the relay, an internal static server, and
# exactly one headless Chromium that IS the game. Nothing else in the world runs
# sm64.wasm.

FROM node:18-bookworm-slim

# chromium provides both the WebGL renderer (via SwiftShader, since this VM has
# no GPU) and the WebCodecs encoder. ca-certificates is needed for the Discord
# OAuth token exchange. No `rm` in this image by house rule — apt-get clean and
# the --no-install-recommends flag keep the layer small instead.
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        ca-certificates \
        fonts-liberation \
        tini \
    && apt-get clean

WORKDIR /app

# Dependencies first so a code edit doesn't re-run npm install.
COPY arena/package.json /app/arena/package.json
RUN cd /app/arena && npm install --omit=dev --no-audit --no-fund

# The relay, the host page, and the viewer bundle.
COPY arena/ /app/arena/

# The game binaries. These stay at the repo root (shared with the AI-player
# build) and are served ONLY on loopback by host/serve-host.js.
COPY sm64.js sm64.wasm /app/

ENV ARENA_PORT=8090 \
    HOST_STATIC_PORT=8091 \
    ARENA_PROFILE_DIR=/data/profile \
    ARENA_FPS=30 \
    ARENA_BITRATE=1800000 \
    CHROME_DEVEL_SANDBOX=

# Chromium leaks zombies without a real init; tini reaps them.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/arena/entrypoint.sh"]
