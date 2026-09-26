# PiCams

A Raspberry Pi security camera display and phone control system for **UniFi Protect** cameras.

Spawns four native **mpv** instances in a 2×2 grid on a connected TV. A phone-accessible web UI lets you switch any camera to fullscreen and return to the grid. No browser, no Chromium — pure mpv with hardware decode for ~1s latency.

---

## Requirements

- Raspberry Pi (tested on Pi 4/5) with **Raspberry Pi OS Trixie 64-bit**
- TV or monitor connected via HDMI
- UniFi Protect NVR (UDM Pro or similar) on the same network
- RTSP stream aliases from UniFi Protect

---

## Quick install

Run this on your Pi as the `pi` user (with `sudo` available):

```bash
bash <(curl -s https://raw.githubusercontent.com/ArchiveHunter/PiCams/main/install.sh)
```

The installer will:
1. Update system packages
2. Install `mpv`, `x11-utils`, `curl`, `wget`, `git`
3. Switch the desktop session from Wayland to X11
4. Enable desktop autologin
5. Install Node.js 20 LTS (via NodeSource)
6. Download the latest `go2rtc` binary
7. Clone this repo to `/home/pi/picams` and run `npm install`
8. Copy example config files if none exist
9. Install and enable the `go2rtc` and `picams` systemd services

---

## Configuration

After the installer finishes, edit two files before rebooting.

### 1. `go2rtc.yaml` — stream URLs

Copy the example if you haven't already:

```bash
cp /home/pi/picams/go2rtc.example.yaml /home/pi/picams/go2rtc.yaml
```

Edit `go2rtc.yaml` and replace the placeholder RTSP URLs with your real ones:

```yaml
streams:
  backgarden_lo:
    - rtsp://192.168.1.1:7447/YOUR_BACKGARDEN_LO_ALIAS
  backgarden_hd:
    - rtsp://192.168.1.1:7447/YOUR_BACKGARDEN_HD_ALIAS
  # ... etc
```

**Finding your RTSP aliases** — run this from any machine on the network (replace the IP and API key):

```bash
curl -sk -b "TOKEN=<api-key>" https://<udm-ip>/proxy/protect/api/bootstrap \
  | python3 -m json.tool | grep -A2 '"rtspAlias"'
```

Each camera has a `lo` (low-res ~640×360) and `hd` (high-res ~1280×720) alias. The grid uses `lo`; fullscreen uses `hd`.

### 2. `.env` — display resolution

```bash
nano /home/pi/picams/.env
```

```dotenv
PORT=8080
GO2RTC_API=http://localhost:1984
GO2RTC_RTSP=rtsp://localhost:8554

# Match your TV's resolution exactly
DISPLAY_W=1920
DISPLAY_H=1080

# Linux username (default: pi)
PI_USER=pi
```

The default is 1920×1080. Change `DISPLAY_W`/`DISPLAY_H` if your TV is a different resolution (e.g. 1360×768).

### Customising camera names

Camera names and stream IDs are defined at the top of `server.js`:

```js
const CAMERAS = [
  { id: 'back_garden', name: 'Back Garden', streamLo: 'backgarden_lo', streamHd: 'backgarden_hd' },
  { id: 'chase',       name: 'Chase',       streamLo: 'chase_lo',      streamHd: 'chase_hd'      },
  { id: 'driveway',    name: 'Driveway',    streamLo: 'driveway_lo',   streamHd: 'driveway_hd'   },
  { id: 'side',        name: 'Side',        streamLo: 'side_lo',       streamHd: 'side_hd'       },
];
```

The `streamLo`/`streamHd` values must match the stream names in `go2rtc.yaml`.

---

## Reboot and go

```bash
sudo reboot
```

After reboot the grid starts automatically. The phone control UI is at:

```
http://<pi-ip>:8080/
```

---

## Architecture

```
UniFi Protect NVR
      │ RTSP (TCP, port 7447)
      ▼
   go2rtc          ← re-streams via internal RTSP on port 8554
      │             ← also serves JPEG snapshots on port 1984 (for prewarm)
      ▼
  mpv × 4          ← 2×2 grid, hardware decoded (v4l2m2m), one process per camera
      │
  mpv × 1          ← fullscreen overlay (spawned on demand, --ontop)
      
  server.js        ← Express + WebSocket, manages mpv processes
      │
  control.html     ← Phone UI (WebSocket client)
```

**Why go2rtc in the middle?** go2rtc pre-warms the RTSP connections before mpv spawns, which prevents a black-screen delay on startup. mpv connects to go2rtc's local RTSP relay rather than hitting the NVR directly.

**Why native mpv instead of a browser?** A browser compositor adds 300–800ms of latency on top of whatever the stream is doing. mpv with `v4l2m2m` hardware decode and the flags in `server.js` gets latency down to ~1 second end-to-end.

---

## Low-latency flags

The key mpv flags that achieve ~1s latency (all set in `server.js`):

| Flag | Purpose |
|---|---|
| `--hwdec=v4l2m2m` | Hardware decode on Pi 64-bit (replaces MMAL from Buster) |
| `--no-cache --untimed` | Disable playback cache entirely |
| `--video-sync=desync` | Don't stall waiting to sync A/V |
| `--demuxer-lavf-analyzeduration=0.01` | Skip stream analysis delay |
| `--video-latency-hacks=yes` | mpv's own latency bundle |
| `--rtsp-transport=tcp` | Use TCP not UDP — prevents packet loss drops on LAN |

---

## UniFi Protect keyframe interval

UniFi Protect cameras default to a **5-second keyframe interval** (idrInterval=5), which causes 5–6s of initial lag. Setting it to 1s cuts this dramatically.

**Via the Protect web UI:** Recording Settings → Keyframe Interval → 1s (per camera).

**Via the API** (run once per camera):

```bash
# Log in and get a cookie
TOKEN=$(curl -sk -c /tmp/unifi-cookie -X POST https://192.168.1.1/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"YOUR_PASSWORD"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessKey',''))")

# Patch a camera (replace CAMERA_ID with the real ID from the bootstrap API)
curl -sk -b /tmp/unifi-cookie -X PATCH \
  https://192.168.1.1/proxy/protect/api/cameras/CAMERA_ID \
  -H "Content-Type: application/json" \
  -d '{"idrInterval":1}'
```

> **Note:** The idrInterval resets to 5 after power cuts and firmware updates. If you notice high latency after an outage, re-apply this setting.

---

## Updating

```bash
cd /home/pi/picams
git pull
npm install
sudo systemctl restart picams
```

---

## Troubleshooting

**Black screen / no video on startup**
- Check go2rtc is running: `sudo systemctl status go2rtc`
- Confirm your RTSP URLs are correct in `go2rtc.yaml`
- Try opening a stream directly: `mpv rtsp://localhost:8554/backgarden_lo`

**5–6 second lag**
- The idrInterval has probably reset. Re-apply it via the Protect UI or API (see above).

**Wrong resolution / cameras not filling the screen**
- Check `DISPLAY_W` and `DISPLAY_H` in `.env` match your TV exactly
- Run `xdpyinfo | grep dimensions` on the Pi to confirm

**Control UI not loading**
- Check picams is running: `sudo systemctl status picams`
- Confirm you're hitting the right IP: `http://<pi-ip>:8080/`

**mpv not starting (display error)**
- picams waits up to 60s for the X display. If it times out, check autologin is set: `sudo raspi-config` → System Options → Boot/Auto Login → Desktop Autologin
- Ensure X11 (not Wayland) is active: `sudo raspi-config` → Advanced Options → Wayland → X11

**Service logs**
```bash
sudo journalctl -u picams  -f
sudo journalctl -u go2rtc  -f
```
