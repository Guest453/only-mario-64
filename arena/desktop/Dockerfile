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

# ── Steam (opt-in: --build-arg WITH_STEAM=1) ────────────────────────────────
#
# Off by default because it costs ~1GB and i386 multiarch for a feature that
# cannot work unattended anyway: Steam needs an interactive login, and I will
# not create accounts or type credentials. Setup is a one-time manual step you
# do yourself — see docs/ARENA.md.
#
# Two things to know before turning this on:
#  - Steam's subscriber agreement prohibits account sharing. A crowd-driven
#    account risks a ban, so use a throwaway with nothing you would miss.
#  - Full keyboard access means anyone can reach Steam's own settings. Attach no
#    payment method.
ARG WITH_STEAM=0
RUN if [ "$WITH_STEAM" = "1" ]; then       dpkg --add-architecture i386 && apt-get update &&       echo steam steam/question select "I AGREE" | debconf-set-selections &&       echo steam steam/license note '' | debconf-set-selections &&       apt-get install -y --no-install-recommends         software-properties-common ca-certificates &&       apt-get install -y --no-install-recommends steam-installer libgl1:i386 libc6:i386 ||         echo "WARN: steam install failed; rebuild with WITH_STEAM=0 or fix the repo" &&       apt-get clean ;     else echo "skipping steam (WITH_STEAM=0)" ; fi

WORKDIR /app
COPY arena/package.json /app/arena/package.json
RUN cd /app/arena && npm install --omit=dev --no-audit --no-fund

COPY arena/ /app/arena/

# Unprivileged. Anyone driving the keyboard is driving it as this user, so it
# owns nothing but its own session.
# Locked-down RetroArch config, owned by root and passed with --config so the
# session cannot rewrite it.
COPY arena/desktop/retroarch.cfg /etc/arena-retroarch.cfg

# Everything runs as this user. The first cut of this image ran the whole
# session as root, which meant anyone driving the keyboard was driving it as
# root — a bad trade for zero benefit.
RUN useradd -m -u 1000 -s /bin/false arena \
    && mkdir -p /roms /data/retroarch /data/saves /data/system /data/pulse /data/home \
    && chown -R arena:arena /data /roms /home/arena \
    && chmod 644 /etc/arena-retroarch.cfg

USER arena
ENV HOME=/data/home XDG_RUNTIME_DIR=/data/home/.run

ENV DISPLAY=:99 \
    ARENA_W=854 \
    ARENA_H=480 \
    ARENA_FPS=30 \
    ARENA_BITRATE=2000000 \
    ROM_DIR=/roms

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/arena/desktop/entrypoint.sh"]
