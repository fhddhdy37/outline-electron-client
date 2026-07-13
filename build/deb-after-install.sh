#!/bin/bash
# outline-electron-client Debian after-install.
#
# Replicates electron-builder's default postinst (it is replaced, not appended,
# when deb.afterInstall is set) and additionally forces --no-sandbox into the
# desktop launcher.
#
# Why --no-sandbox: on Ubuntu 24.04 unprivileged user namespaces are blocked by
# AppArmor (kernel.apparmor_restrict_unprivileged_userns=1), and the default
# postinst's userns probe runs as root (where it passes) so it ships the
# non-SUID sandbox — which then aborts the app at launch for the normal user.
# The SUID sandbox is also broken here because the install path contains a space
# (/opt/Outline Electron Client/...). This app only ever loads a trusted
# self-hosted Outline origin, so disabling the Chromium sandbox on Linux is an
# acceptable trade-off and makes `apt install` the only step a user needs.

APP='/opt/Outline Electron Client/outline-electron-client'
BIN='/usr/bin/outline-electron-client'

# Launcher symlink (standard electron-builder behaviour).
if type update-alternatives 2>/dev/null >&1; then
    if [ -L "$BIN" ] && [ -e "$BIN" ] && [ "$(readlink "$BIN")" != '/etc/alternatives/outline-electron-client' ]; then
        rm -f "$BIN"
    fi
    update-alternatives --install "$BIN" 'outline-electron-client' "$APP" 100 || ln -sf "$APP" "$BIN"
else
    ln -sf "$APP" "$BIN"
fi

# Force --no-sandbox in the desktop launcher used by the app menu and by browsers
# handling the outline-electron:// login deep link.
DESKTOP='/usr/share/applications/outline-electron-client.desktop'
if [ -f "$DESKTOP" ] && ! grep -q -- '--no-sandbox' "$DESKTOP"; then
    sed -i 's/" %U/" --no-sandbox %U/' "$DESKTOP"
fi

# Refresh the databases so the icon and the outline-electron:// scheme handler
# register immediately.
if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi
if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
