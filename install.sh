#!/usr/bin/env bash
# PiCams installer — Raspberry Pi OS Trixie 64-bit
# Run as pi user with sudo available: bash install.sh
set -euo pipefail

PICAMS_DIR="/home/pi/picams"
GO2RTC_BIN="/usr/local/bin/go2rtc"

echo "=== PiCams Installer ==="
echo ""

# ── 1. System update ──────────────────────────────────────────────────────────
echo "[1/8] Updating system packages…"
sudo apt-get update -qq
sudo apt-get upgrade -y -qq

# ── 2. Dependencies ───────────────────────────────────────────────────────────
echo "[2/8] Installing dependencies…"
sudo apt-get install -y -qq mpv x11-xserver-utils x11-utils curl wget git

# ── 3. Switch to X11 (Trixie defaults to Wayland) ────────────────────────────
echo "[3/8] Switching to X11…"
sudo raspi-config nonint do_wayland W1

# ── 4. Enable desktop autologin ───────────────────────────────────────────────
echo "[4/8] Enabling desktop autologin…"
sudo raspi-config nonint do_boot_behaviour B4

# ── 5. Node.js 20 LTS ────────────────────────────────────────────────────────
echo "[5/8] Installing Node.js 20 LTS…"
if ! node --version 2>/dev/null | grep -q '^v20'; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] \
    https://deb.nodesource.com/node_20.x nodistro main" \
    | sudo tee /etc/apt/sources.list.d/nodesource.list > /dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq nodejs
fi
echo "  Node: $(node --version)"

# ── 6. go2rtc ─────────────────────────────────────────────────────────────────
echo "[6/8] Installing go2rtc…"
if [ ! -f "$GO2RTC_BIN" ]; then
  GO2RTC_VER=$(curl -s https://api.github.com/repos/AlexxIT/go2rtc/releases/latest \
    | grep '"tag_name"' | sed 's/.*"v\([^"]*\)".*/\1/')
  echo "  Downloading go2rtc v${GO2RTC_VER} (arm64)…"
  sudo wget -q -O "$GO2RTC_BIN" \
    "https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VER}/go2rtc_linux_arm64"
  sudo chmod +x "$GO2RTC_BIN"
fi
echo "  go2rtc: $($GO2RTC_BIN --version 2>&1 | head -1)"

# ── 7. Clone / update picams ──────────────────────────────────────────────────
echo "[7/8] Setting up PiCams…"
if [ ! -d "$PICAMS_DIR/.git" ]; then
  git clone https://github.com/ArchiveHunter/PiCams.git "$PICAMS_DIR"
else
  echo "  Repo exists — pulling latest…"
  git -C "$PICAMS_DIR" pull
fi

cd "$PICAMS_DIR"
npm install --silent

# Copy example configs if not already configured
[ -f "$PICAMS_DIR/.env" ]          || cp "$PICAMS_DIR/.env.example"          "$PICAMS_DIR/.env"
[ -f "$PICAMS_DIR/go2rtc.yaml" ]   || cp "$PICAMS_DIR/go2rtc.example.yaml"   "$PICAMS_DIR/go2rtc.yaml"

# ── 8. Systemd services ───────────────────────────────────────────────────────
echo "[8/8] Installing systemd services…"
sudo cp "$PICAMS_DIR/go2rtc.service"  /etc/systemd/system/
sudo cp "$PICAMS_DIR/picams.service"  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable go2rtc picams

# ── LXDE autostart — disable screensaver, remove any old Chromium kiosk ───────
AUTOSTART_DIR="/home/pi/.config/lxsession/LXDE-pi"
mkdir -p "$AUTOSTART_DIR"
cat > "$AUTOSTART_DIR/autostart" << 'EOF'
@lxpanel --profile LXDE-pi
@pcmanfm --desktop --profile LXDE-pi
@xset s off
@xset -dpms
@xset s noblank
EOF

echo ""
echo "=== Done ==="
echo ""
echo "Before rebooting, configure your streams:"
echo "  nano $PICAMS_DIR/go2rtc.yaml   — add your UniFi Protect RTSP URLs"
echo "  nano $PICAMS_DIR/.env          — set DISPLAY_W/H if not 1920×1080"
echo ""
echo "Then: sudo reboot"
echo ""
echo "Phone control UI: http://$(hostname -I | awk '{print $1}'):${PORT:-8080}/"
