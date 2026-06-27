'use strict';

const fs   = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && val.length) process.env[key.trim()] = val.join('=').trim();
  });
}

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');

const PORT        = parseInt(process.env.PORT       || 8080);
const GO2RTC_API  = process.env.GO2RTC_API          || 'http://localhost:1984';
const GO2RTC_RTSP = process.env.GO2RTC_RTSP         || 'rtsp://localhost:8554';
const DISPLAY_W   = parseInt(process.env.DISPLAY_W  || 1920);
const DISPLAY_H   = parseInt(process.env.DISPLAY_H  || 1080);
const PI_USER     = process.env.PI_USER             || 'pi';

const CAMERAS = [
  { id: 'back_garden', name: 'Back Garden', streamLo: 'backgarden_lo', streamHd: 'backgarden_hd' },
  { id: 'chase',       name: 'Chase',       streamLo: 'chase_lo',      streamHd: 'chase_hd'      },
  { id: 'driveway',    name: 'Driveway',    streamLo: 'driveway_lo',   streamHd: 'driveway_hd'   },
  { id: 'side',        name: 'Side',        streamLo: 'side_lo',       streamHd: 'side_hd'       },
];

// 2×2 grid positions
const W2 = Math.floor(DISPLAY_W / 2);
const H2 = Math.floor(DISPLAY_H / 2);
const GRID_POSITIONS = [
  { x: 0,  y: 0  },
  { x: W2, y: 0  },
  { x: 0,  y: H2 },
  { x: W2, y: H2 },
];

const MPV_ENV = {
  ...process.env,
  DISPLAY:    ':0',
  XAUTHORITY: `/home/${PI_USER}/.Xauthority`,
};

// Base flags for all mpv instances
const MPV_BASE = [
  '--no-border',
  '--no-osc',
  '--really-quiet',
  '--no-input-default-bindings',
  '--cursor-autohide=always',
  '--hwdec=v4l2m2m',
  '--vo=gpu',
  // Explicit low-latency — don't rely on profile alone
  '--no-cache',
  '--untimed',
  '--video-sync=desync',
  '--demuxer-lavf-analyzeduration=0.01',
  '--demuxer-lavf-probescore=10',
  '--demuxer-max-bytes=512KiB',
  '--demuxer-max-back-bytes=50KiB',
  '--loop-file=inf',
  '--rtsp-transport=tcp',
];

let gridProcs = [];
let fsProc    = null;
let state     = { mode: 'grid', activeCamera: null };

// ── mpv management ─────────────────────────────────────────────────────────────

function spawnMpv(extraArgs) {
  const proc = spawn('mpv', [...MPV_BASE, ...extraArgs], {
    env:      MPV_ENV,
    stdio:    'ignore',
    detached: false,
  });
  proc.on('error', err => console.error('[mpv] spawn error:', err.message));
  return proc;
}

function spawnGridCell(cam, i) {
  const { x, y } = GRID_POSITIONS[i];
  const proc = spawnMpv([
    `--geometry=${W2}x${H2}+${x}+${y}`,
    `${GO2RTC_RTSP}/${cam.streamLo}`,
  ]);
  proc.on('exit', code => {
    // Self-heal: respawn this cell if we're still in grid mode
    if (state.mode === 'grid') {
      console.log(`[mpv] ${cam.name} exited (${code}), respawning in 2s`);
      setTimeout(() => {
        if (state.mode === 'grid') gridProcs[i] = spawnGridCell(cam, i);
      }, 2000);
    }
  });
  return proc;
}

function spawnGrid() {
  gridProcs = CAMERAS.map((cam, i) => spawnGridCell(cam, i));
  console.log('[mpv] Grid started');
}

function startFullscreen(cam) {
  stopFullscreen();
  fsProc = spawnMpv([
    '--fullscreen',
    '--ontop',
    `${GO2RTC_RTSP}/${cam.streamHd}`,
  ]);
  fsProc.on('exit', () => { fsProc = null; });
  console.log(`[mpv] Fullscreen: ${cam.name}`);
}

function stopFullscreen() {
  if (fsProc) { fsProc.kill('SIGTERM'); fsProc = null; }
}

function killGrid() {
  gridProcs.forEach(p => p && p.kill('SIGTERM'));
  gridProcs = [];
}

// ── Wait for X display before spawning mpv ────────────────────────────────────

async function waitForDisplay(maxSeconds = 60) {
  console.log('[display] Waiting for X display…');
  for (let i = 0; i < maxSeconds; i++) {
    try {
      execSync('xdpyinfo', { env: MPV_ENV, stdio: 'ignore' });
      console.log(`[display] Ready after ${i}s`);
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.error(`[display] Not available after ${maxSeconds}s`);
  return false;
}

// ── Express + WebSocket ───────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const controls = new Set();

function broadcastState() {
  const msg = JSON.stringify({ type: 'state', ...state, cameras: CAMERAS });
  controls.forEach(ws => ws.readyState === WebSocket.OPEN && ws.send(msg));
}

wss.on('connection', ws => {
  controls.add(ws);
  ws.send(JSON.stringify({ type: 'state', ...state, cameras: CAMERAS }));
  ws.on('close', () => controls.delete(ws));
  ws.on('error', () => {});
  ws.on('message', data => {
    try {
      const cmd = JSON.parse(data);
      if (cmd.action === 'fullscreen' && cmd.camera) {
        const cam = CAMERAS.find(c => c.id === cmd.camera);
        if (!cam) return;
        state = { mode: 'fullscreen', activeCamera: cmd.camera };
        startFullscreen(cam);
        broadcastState();
      } else if (cmd.action === 'grid') {
        state = { mode: 'grid', activeCamera: null };
        stopFullscreen();
        broadcastState();
      }
    } catch (_) {}
  });
});

// ── Snapshot proxy — go2rtc frame grab ───────────────────────────────────────

app.get('/snapshot/:stream', async (req, res) => {
  try {
    const upstream = await fetch(
      `${GO2RTC_API}/api/frame.jpeg?src=${encodeURIComponent(req.params.stream)}`
    );
    if (!upstream.ok) return res.status(502).end();
    const buf = await upstream.arrayBuffer();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.send(Buffer.from(buf));
  } catch {
    res.status(502).end();
  }
});

app.get('/api/cameras', (_req, res) => res.json(CAMERAS));
app.get('/api/state',   (_req, res) => res.json({ ...state, cameras: CAMERAS }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.redirect('/control.html'));

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown() {
  console.log('[server] Shutting down');
  stopFullscreen();
  killGrid();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, async () => {
  console.log(`PiCams v2 running on http://0.0.0.0:${PORT}`);
  const ready = await waitForDisplay();
  if (ready) spawnGrid();
});
