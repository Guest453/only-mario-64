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

# Debian 13 (trixie), NOT bookworm.
#
# Native games are built against modern toolchains: FNF needs GLIBC_2.38,
# GLIBCXX_3.4.32 and CXXABI_1.3.15, and bookworm ships glibc 2.36. That is not
# something a package can fix — glibc is the floor of the image, so the base
# has to move. Trixie ships glibc 2.41 and every package this image needs.
FROM debian:trixie-slim

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
        sudo \
        curl \
        unzip \
        ca-certificates \
        fonts-liberation \
        mesa-utils \
        libgl1-mesa-dri \
        libvlc5 \
        libvlccore9 \
        vlc-plugin-base \
        tini \
    && apt-get clean

# Chromium, for the SM64 wasm build ONLY.
#
# A browser is the single biggest escape hatch in a locked image, so it is not
# here as a browser: it is launched with --kiosk --app pointing at a loopback
# page, with no address bar, no tabs and no way back. Its shortcuts (Ctrl+T/N/
# W/L, F11, F12...) are additionally blocked at the input injector, because
# defence at one layer is not defence.
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
    && apt-get clean

# ── RetroArch + libretro cores ──────────────────────────────────────────────
# Cores come from the libretro buildbot (all open source). ROMs do NOT ship in
# this image and never will — they are mounted from a volume you populate.
RUN apt-get update && apt-get install -y --no-install-recommends \
        retroarch libretro-core-info \
    && apt-get clean

# ── Mesa from trixie-backports ──────────────────────────────────────────────
#
# Trixie ships Mesa 25.0.7, which does NOT advertise GL_EXT_sRGB. Lime/OpenFL
# (FNF's engine) uses sRGB framebuffers on its GLES path, and when that
# extension is missing the framebuffer silently fails to come up: the game loop
# runs, audio plays, and the window stays black. Every other app here is fine
# because RetroArch, Chromium and glxgears never ask for it.
#
# Found by diffing glxinfo between this container (311 extensions) and a machine
# where FNF renders correctly under the SAME software renderer (318). Of the six
# missing extensions, GL_EXT_sRGB is the only one a 2D game would ever touch.
#
# Backports rather than sid: 26.1.2 is built against trixie, so it upgrades Mesa
# without dragging in a newer glibc.
RUN echo 'deb http://deb.debian.org/debian trixie-backports main' \
        > /etc/apt/sources.list.d/backports.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends -t trixie-backports \
        libgl1-mesa-dri libglx-mesa0 libegl-mesa0 libgbm1 mesa-utils \
    && apt-get clean \
    && echo "mesa now: $(glxinfo --version 2>/dev/null | head -1 || true)"

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
# Desktop mode needs exactly the parts the game modes exclude: a panel with a
# menu, a file manager, a terminal, a desktop to right-click. Only reachable
# once the crowd VOTES desktop mode in.
RUN apt-get update && apt-get install -y --no-install-recommends \
        xfce4-panel xfdesktop4 xfce4-appfinder xfce4-terminal thunar \
        xfce4-settings xdg-utils x11-apps \
        dbus-x11 \
    && apt-get clean

ARG WITH_STEAM=1
RUN if [ "$WITH_STEAM" = "1" ]; then \
      # Enable contrib/non-free by EDITING the existing deb822 source, not by
      # adding a legacy .list for the same repo. Doing the latter gives two
      # entries for bookworm with different Signed-By values, and apt then
      # refuses to read ANY sources at all:
      #   E: Conflicting values set for option Signed-By ... != 
      #   E: The list of sources could not be read.
      # which silently broke every apt call in this step.
      sed -i 's/^Components:.*/Components: main contrib non-free non-free-firmware/' \
        /etc/apt/sources.list.d/debian.sources ; \
      dpkg --add-architecture i386 ; apt-get update ; \
      echo steam steam/question select "I AGREE" | debconf-set-selections ; \
      echo steam steam/license note '' | debconf-set-selections ; \
      (apt-get install -y --no-install-recommends steam-installer \
        || apt-get install -y --no-install-recommends steam \
        || echo "WARN: steam not installable here - desktop mode works, minus Steam") ; \
      apt-get clean ; \
    else echo "skipping steam" ; fi

WORKDIR /app
COPY arena/package.json /app/arena/package.json
RUN cd /app/arena && npm install --omit=dev --no-audit --no-fund

COPY arena/ /app/arena/
# The SM64 wasm. Served on loopback to the container's own Chromium; viewers
# never download it.
COPY sm64.js sm64.wasm /app/

# Unprivileged. Anyone driving the keyboard is driving it as this user, so it
# owns nothing but its own session.
# Locked-down RetroArch config, owned by root and passed with --config so the
# session cannot rewrite it.
COPY arena/desktop/retroarch.cfg /etc/arena-retroarch.cfg

# Route ALSA's default device to PulseAudio.
#
# Something in the base image left /etc/asound.conf as `pcm.!default {type null}`
# — a black hole. Anything using ALSA (SDL/OpenAL games like FNF) wrote its audio
# to nowhere: the pulse sink read -91dB, digital silence, while the game looked
# perfectly healthy and even held an open pulse stream.
RUN printf 'pcm.!default { type pulse }\nctl.!default { type pulse }\n' > /etc/asound.conf \
    && chmod 644 /etc/asound.conf

# Everything runs as this user. The first cut of this image ran the whole
# session as root, which meant anyone driving the keyboard was driving it as
# root — a bad trade for zero benefit.
RUN useradd -m -u 1000 -s /bin/false arena \
    && mkdir -p /roms /data/retroarch /data/saves /data/system /data/pulse \
                /data/home /data/home/.run /data/home/.config/pulse \
    && chown -R arena:arena /data /roms /home/arena \
    && chmod 700 /data/home/.run /data/pulse \
    && chmod 644 /etc/arena-retroarch.cfg \
    # PulseAudio refuses to start without a machine-id, and XDG_RUNTIME_DIR has
    # to exist as a real 0700 directory owned by the user. Both were missing
    # after the switch to non-root, which is why pulse silently never came up.
    && (dbus-uuidgen > /etc/machine-id 2>/dev/null || cat /proc/sys/kernel/random/uuid | tr -d '-' > /etc/machine-id) \
    && chmod 644 /etc/machine-id

# ── Privilege split ─────────────────────────────────────────────────────────
#
# Desktop mode hands anonymous people a real desktop with a terminal. If that
# ran as the same user as the capture agent, anyone could pkill the stream.
#
# So it runs as `guest`, a second unprivileged user with NO sudo rights at all.
# guest cannot signal arena's processes, cannot read arena's files, and cannot
# escalate. The ONE thing arena may do across the boundary is launch the desktop
# script as guest — a single NOPASSWD sudoers rule, nothing else.
#
# Deliberately NOT done: giving guest a sudo password. A password (base64-encoded
# or otherwise) is strictly weaker than no sudo entitlement, and base64 is an
# encoding, not a secret. Admin access is `docker exec -u root`, which the crowd
# has no path to.
RUN useradd -m -u 1001 -s /bin/bash guest \
    && mkdir -p /data/guest \
    && chown -R guest:guest /data/guest /home/guest \
    && printf '%s\n%s\n' \
        'arena ALL=(guest) NOPASSWD: /app/arena/desktop/start-desktop.sh' \
        'arena ALL=(root) NOPASSWD: /app/arena/desktop/stop-guest.sh' \
        > /etc/sudoers.d/arena-desktop \
    && chmod 440 /etc/sudoers.d/arena-desktop \
    && visudo -c >/dev/null

USER arena
ENV HOME=/data/home XDG_RUNTIME_DIR=/data/home/.run

ENV DISPLAY=:99 \
    ARENA_W=854 \
    ARENA_H=480 \
    ARENA_SCREEN_W=1280 \
    ARENA_SCREEN_H=720 \
    ARENA_FPS=30 \
    ARENA_BITRATE=2000000 \
    ROM_DIR=/roms

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/arena/desktop/entrypoint.sh"]
