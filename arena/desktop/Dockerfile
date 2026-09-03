# Mario Arena — DESKTOP variant.
#
# The wasm build (arena/Dockerfile) runs one game inside headless Chromium. This
# one runs a real X session so ANY native program works: retroarch cores, and
# later Steam. The trade is that a full desktop plus an emulator plus an encoder
# has to fit in 2 shared vCPUs with no GPU, which is why the frame budget gets
# measured before anything is built on top of it.
#
# Lockdown is a build-time property, not a runtime one: the escape hatches are
# simply never installed. No browser, no terminal, no file manager, no app
# finder, no panel menu. What is not in the image cannot be launched by someone
# hammering the keyboard.

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# ── X, window manager, audio, capture, input ────────────────────────────────
# xfwm4 + xfsettingsd is the XFCE session WITHOUT the parts that are escape
# hatches. Deliberately absent: xfce4-terminal, thunar, xfce4-appfinder,
# xfce4-panel (its menu launches arbitrary apps), and any browser.
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb \
        xfwm4 \
        xfconf \
        x11-xserver-utils \
        x11-utils \
        wmctrl \
        xdotool \
        ffmpeg \
        pulseaudio \
        pulseaudio-utils \
        nodejs \
        npm \
        curl \
        unzip \
        ca-certificates \
        fonts-liberation \
        mesa-utils \
        libgl1-mesa-dri \
        tini \
    && apt-get clean

# ── RetroArch + libretro cores ──────────────────────────────────────────────
# Cores come from the libretro buildbot (all open source). ROMs do NOT ship in
# this image and never will — they are mounted from a volume you populate.
RUN apt-get update && apt-get install -y --no-install-recommends \
        retroarch libretro-core-info \
    && apt-get clean

ARG LIBRETRO=https://buildbot.libretro.com/nightly/linux/x86_64/latest
RUN mkdir -p /usr/lib/libretro && cd /tmp \
    && for core in \
         mupen64plus_next_libretro.so \
         snes9x_libretro.so \
         genesis_plus_gx_libretro.so \
         fceumm_libretro.so \
         gambatte_libretro.so \
         mgba_libretro.so ; do \
         echo "fetching $core" ; \
         curl -fsSL "$LIBRETRO/$core.zip" -o "$core.zip" \
           && unzip -o -q "$core.zip" -d /usr/lib/libretro/ \
           || echo "WARN: $core unavailable, skipping" ; \
       done \
    && ls -la /usr/lib/libretro/ || true

WORKDIR /app
COPY arena/package.json /app/arena/package.json
RUN cd /app/arena && npm install --omit=dev --no-audit --no-fund

COPY arena/ /app/arena/

# Unprivileged. Anyone driving the keyboard is driving it as this user, so it
# owns nothing but its own session.
RUN useradd -m -s /usr/sbin/nologin arena \
    && mkdir -p /roms /data/retroarch /data/saves \
    && chown -R arena:arena /data /roms

ENV DISPLAY=:99 \
    ARENA_W=854 \
    ARENA_H=480 \
    ARENA_FPS=30 \
    ARENA_BITRATE=2000000 \
    ROM_DIR=/roms

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/arena/desktop/entrypoint.sh"]
