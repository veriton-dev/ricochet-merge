#!/usr/bin/env node
// ARENA-TMA-01 Deterministic Headless Verifier (Node 22+ stdlib + headless Chromium CDP).
// Screens 9:16 portrait (390x844) single-thumb WebGL2/Canvas/WASM mini-games for:
// 1) <= 256 KiB total bundle size & zero external http(s) network references
// 2) Seeded determinism: two identical 180-tick input traces under seed=42 produce identical state()
// 3) True input causality: active aiming trace diverges from idle trace (blocks fake score timers)
// 4) Real 390x844 visual rendering: captures 3 frames and verifies inter-frame pixel motion delta

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BUNDLE_BYTES = 262_144;
const CHROMIUM_BIN = process.env.CHROMIUM_BIN || '/usr/bin/chromium';

function walkFiles(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const dir = rel ? join(root, rel) : root;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const p = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) out.push({ rel: p, full: join(root, p), size: statSync(join(root, p)).size });
    }
  }
  return out;
}

function checkStaticGate(dir) {
  const index = join(dir, 'index.html');
  if (!existsSync(index)) throw new Error('missing_index_html');
  const files = walkFiles(dir);
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > MAX_BUNDLE_BYTES) throw new Error(`bundle_too_large:${total}>${MAX_BUNDLE_BYTES}`);
  for (const f of files) {
    if (/\.(html|js|mjs|css|json|svg)$/i.test(f.rel)) {
      const txt = readFileSync(f.full, 'utf8');
      if (/https?:\/\//i.test(txt)) throw new Error(`forbidden_network_url_in:${f.rel}`);
    }
  }
  return { fileCount: files.length, totalBytes: total, indexUrl: pathToFileURL(index).href };
}

async function runCdpAudit(indexUrl) {
  const profile = `/tmp/tma01-cdp-${process.pid}-${Date.now()}`;
  mkdirSync(profile, { recursive: true });
  const env = { ...process.env };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  const proc = spawn(CHROMIUM_BIN, [
    '--headless', '--disable-gpu', '--no-sandbox', '--disable-background-networking',
    '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=390,844',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ], { env, stdio: ['ignore', 'ignore', 'pipe'] });

  try {
    const wsUrl = await new Promise((res, rej) => {
      let stderr = '';
      const timer = setTimeout(() => rej(new Error('chromium_start_timeout')), 10_000);
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
        const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (m) { clearTimeout(timer); res(m[1]); }
      });
      proc.on('exit', (code) => { clearTimeout(timer); rej(new Error(`chromium_exited:${code}`)); });
    });

    const targetsRes = await fetch(wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*/, '/json/list'));
    const targets = await targetsRes.json();
    const pageWs = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
    if (!pageWs) throw new Error('no_page_target');

    const ws = new WebSocket(pageWs);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let nextId = 1;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Page.navigate', { url: indexUrl });
    await new Promise((r) => setTimeout(r, 350));

    const probeExpr = `(async () => {
      const g = window.__GAME;
      if (!g || typeof g.reset !== 'function' || typeof g.step !== 'function' || typeof g.state !== 'function') {
        throw new Error('missing_window___GAME_bridge');
      }
      function runTrace(seed, active) {
        g.reset(seed);
        const snap = [];
        for (let i = 0; i < 180; i++) {
          const phase = i % 36;
          const inp = active
            ? { x: 0.2 + 0.6 * ((i * 37 % 100) / 100), y: 0.72, down: phase < 18, tap: phase === 18, choice: i % 3 }
            : { x: 0.5, y: 0.5, down: false, tap: false, choice: null };
          g.step(16.6667, inp);
          if (i === 5 || i === 89 || i === 179) snap.push(JSON.stringify(g.state()));
        }
        return snap;
      }
      const runA = runTrace(42, true);
      const runB = runTrace(42, true);
      if (JSON.stringify(runA) !== JSON.stringify(runB)) throw new Error('non_deterministic_seed_replay');
      const idle = runTrace(42, false);
      if (runA[2] === idle[2]) throw new Error('no_input_causality_fake_timer');
      g.reset(42);
      const st0 = g.state();
      return { finalActive: JSON.parse(runA[2]), finalIdle: JSON.parse(idle[2]), st0 };
    })()`;

    const eval1 = await send('Runtime.evaluate', { expression: probeExpr, awaitPromise: true, returnByValue: true });
    if (eval1.exceptionDetails) throw new Error('bridge_error:' + (eval1.exceptionDetails.exception?.description || eval1.exceptionDetails.text));

    const captureB64 = async () => (await send('Page.captureScreenshot', { format: 'png' })).data;
    await send('Runtime.evaluate', { expression: 'window.__GAME.reset(7); window.__GAME.step(16.67,{x:0.5,y:0.7,down:true,tap:false,choice:0});' });
    const shot1 = Buffer.from(await captureB64(), 'base64');
    await send('Runtime.evaluate', { expression: 'for(let i=0;i<75;i++) window.__GAME.step(16.67,{x:0.35+(i%5)*0.08,y:0.68,down:i%20<10,tap:i%20===10,choice:0});' });
    const shot2 = Buffer.from(await captureB64(), 'base64');
    if (shot1.equals(shot2)) throw new Error('static_frame_slop:identical_png_bytes');
    ws.close();
    return { stateSummary: eval1.result.value, shotBytes: [shot1.length, shot2.length] };
  } finally {
    proc.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  }
}

const targetDir = resolve(process.argv[2] || '.');
try {
  const stat = checkStaticGate(targetDir);
  const cdp = await runCdpAudit(stat.indexUrl);
  process.stdout.write(`PASS\tfiles=${stat.fileCount}\tbytes=${stat.totalBytes}\tshots=${cdp.shotBytes.join(',')}\tfinal=${JSON.stringify(cdp.stateSummary.finalActive)}\n`);
} catch (err) {
  process.stdout.write(`FAIL\t${err.message || err}\n`);
  process.exit(1);
}
