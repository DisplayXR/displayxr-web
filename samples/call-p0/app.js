// 3D call — P0 probe. Throwaway diagnostic for the `@displayxr/inline3d/call` design:
//   1. which cameras exist and what they really deliver (is a stereo camera one wide SBS device?)
//   2. does a 2560x720 SBS stream survive a P2P WebRTC call at full resolution, and does
//      addVideo() weave it on the receiver.
// Signalling is the free PeerJS cloud — fine for a probe, NOT the product design.
import { createInline3D } from '@displayxr/inline3d';

const $ = (s) => document.querySelector(s);
const q = new URLSearchParams(location.search);
const log = (tag, obj) => console.log(`[call-p0] ${tag} ${JSON.stringify(obj)}`);

const report = { ua: navigator.userAgent, url: location.href, woven: false, probe: null, hello: null, stats: [] };

/* ------------------------------ DisplayXR ------------------------------ */
const wall = await createInline3D();
report.woven = !!wall.supported;
$('#status').textContent = wall.supported
  ? 'DisplayXR Browser — remote SBS tile will be woven'
  : 'Not the DisplayXR Browser — remote tile is drawn flat (the raw pair)';
if (wall.supported) $('#status').classList.add('woven');
log('env', { woven: report.woven, ua: report.ua });

/* ------------------------------- Probe --------------------------------- */
async function probe() {
  $('#probe-out').textContent = 'probing…';
  const out = { devices: [], concurrent: null };
  // Labels are empty until one getUserMedia succeeds.
  try { (await navigator.mediaDevices.getUserMedia({ video: true })).getTracks().forEach((t) => t.stop()); }
  catch (e) { out.permissionError = `${e.name}: ${e.message}`; }
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  for (const d of cams) {
    const row = { label: d.label, deviceId: d.deviceId.slice(0, 12), groupId: d.groupId.slice(0, 12) };
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: d.deviceId }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
      const t = s.getVideoTracks()[0];
      const st = t.getSettings();
      const caps = t.getCapabilities ? t.getCapabilities() : {};
      Object.assign(row, {
        width: st.width, height: st.height, fps: st.frameRate, facingMode: st.facingMode,
        aspect: +(st.width / st.height).toFixed(3),
        sbsCandidate: st.width / st.height > 2.5,
        maxWidth: caps.width?.max, maxHeight: caps.height?.max,
      });
      s.getTracks().forEach((x) => x.stop());
    } catch (e) { row.error = `${e.name}: ${e.message}`; }
    out.devices.push(row);
  }
  // A stereo pair exposed as TWO devices would need both open at once.
  if (cams.length >= 2) {
    const opened = [];
    try {
      for (const d of cams.slice(0, 2)) opened.push(await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: d.deviceId } } }));
      out.concurrent = 'ok: first two devices open simultaneously';
    } catch (e) { out.concurrent = `fail after ${opened.length}: ${e.name}: ${e.message}`; }
    opened.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  }
  report.probe = out;
  $('#probe-out').textContent = JSON.stringify(out, null, 2);
  log('probe', out);
  await fillSources(cams);
}
$('#btn-probe').onclick = probe;

async function fillSources(cams) {
  cams ??= (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const sel = $('#src');
  sel.innerHTML = '<option value="synthetic">synthetic SBS 2560×720 (known disparity)</option>';
  for (const d of cams) sel.insertAdjacentHTML('beforeend', `<option value="${d.deviceId}">${d.label || 'camera ' + d.deviceId.slice(0, 6)}</option>`);
  if (q.get('src')) sel.value = q.get('src') === 'synthetic' ? 'synthetic' : sel.value;
}
await fillSources();
if (q.get('codec')) $('#codec').value = q.get('codec');
if (q.get('kbps')) $('#kbps').value = q.get('kbps');

/* --------------------------- Synthetic SBS ----------------------------- */
// Two eye halves of one scene: a checkerboard AT the screen plane (zero disparity) and a
// square that floats in front (crossed disparity ±D px per eye). If the pair arrives
// swapped or squeezed, it is obvious on the panel; the frame counter shows frame rate.
function syntheticStream() {
  const W = 1280, H = 720, D = 24;
  const c = document.createElement('canvas'); c.width = W * 2; c.height = H;
  const g = c.getContext('2d');
  let n = 0;
  const draw = () => {
    n++;
    const x = W / 2 + Math.sin(n / 60) * 300;
    for (const eye of [0, 1]) {
      const ox = eye * W;
      g.save(); g.beginPath(); g.rect(ox, 0, W, H); g.clip();
      for (let yy = 0; yy < H; yy += 80) for (let xx = 0; xx < W; xx += 80) {
        g.fillStyle = ((xx + yy) / 80) % 2 ? '#2a3350' : '#1a2036'; g.fillRect(ox + xx, yy, 80, 80);
      }
      const shift = eye === 0 ? D : -D; // crossed disparity: pops OUT of the screen
      g.fillStyle = '#3b82f6'; g.fillRect(ox + x - 120 + shift, H / 2 - 120, 240, 240);
      g.fillStyle = '#fff'; g.font = '600 48px system-ui';
      g.fillText(eye === 0 ? 'L' : 'R', ox + 30, 70);
      g.fillText(`#${n}`, ox + 30, H - 40);
      g.restore();
    }
  };
  setInterval(draw, 1000 / 30); draw();
  return c.captureStream(30);
}

/* -------------------------------- Call --------------------------------- */
let peer = null, localStream = null, sendFormat = 'mono';
const calls = new Map();

function preferCodec(sdp, codec) {
  const lines = sdp.split('\r\n');
  const mi = lines.findIndex((l) => l.startsWith('m=video'));
  if (mi < 0) return sdp;
  const pts = new Set();
  for (const l of lines) {
    const m = l.match(/^a=rtpmap:(\d+) ([\w-]+)\//);
    if (m && m[2].toUpperCase() === codec.toUpperCase()) pts.add(m[1]);
  }
  for (const l of lines) { // keep each preferred codec's RTX right behind it
    const m = l.match(/^a=fmtp:(\d+) apt=(\d+)/);
    if (m && pts.has(m[2])) pts.add(m[1]);
  }
  if (!pts.size) return sdp;
  const parts = lines[mi].split(' ');
  const rest = parts.slice(3).filter((p) => !pts.has(p));
  lines[mi] = [...parts.slice(0, 3), ...[...pts], ...rest].join(' ');
  return lines.join('\r\n');
}
const sdpTransform = (sdp) => preferCodec(sdp, $('#codec').value);

async function start() {
  const src = $('#src').value;
  if (src === 'synthetic') localStream = syntheticStream();
  else localStream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: src }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false,
  });
  const t = localStream.getVideoTracks()[0];
  t.contentHint = 'detail'; // keep resolution; SBS halves must not be downscaled independently
  const st = t.getSettings();
  const w = st.width ?? 2560, h = st.height ?? 720;
  const fmt = $('#fmt').value;
  sendFormat = fmt === 'auto' ? (w / h > 2.5 ? 'sbs' : 'mono') : fmt;
  $('#local').srcObject = localStream;
  $('#local-cap').textContent = `local ${w}×${h} — sending as ${sendFormat}`;
  log('local', { src: src === 'synthetic' ? 'synthetic' : 'camera', w, h, sendFormat });

  peer = q.get('id') ? new Peer(q.get('id')) : new Peer();
  peer.on('open', (id) => {
    $('#my-id').textContent = id; log('peer-open', { id });
    if (q.get('call')) dial(q.get('call'));
  });
  peer.on('call', (call) => { call.answer(localStream, { sdpTransform }); wire(call); });
  peer.on('connection', (dc) => dc.on('data', onHello));
  peer.on('error', (e) => log('peer-error', { type: e.type, msg: String(e) }));
}
$('#btn-start').onclick = () => start().catch((e) => log('start-error', { msg: String(e) }));

function dial(id) {
  if (!peer || calls.has(id)) return;
  log('dial', { id });
  wire(peer.call(id, localStream, { sdpTransform }));
}
$('#btn-call').onclick = () => dial($('#peer-id').value.trim());

function wire(call) {
  calls.set(call.peer, call);
  call.on('stream', async (stream) => {
    // Tell the other side what we send (out of band — the leiachat `#SBS` tag, as a data message).
    const st = localStream.getVideoTracks()[0].getSettings();
    const dc = peer.connect(call.peer);
    dc.on('open', () => dc.send({ type: 'hello', format: sendFormat, width: st.width, height: st.height, ua: navigator.userAgent }));
    await tuneSender(call.peerConnection);
    showRemote(stream);
    pollStats(call.peerConnection);
  });
  call.on('close', () => { calls.delete(call.peer); log('closed', { id: call.peer }); });
}

async function tuneSender(pc) {
  for (const s of pc.getSenders()) {
    if (s.track?.kind !== 'video') continue;
    const p = s.getParameters();
    p.degradationPreference = 'maintain-resolution'; // drop fps, not per-eye width
    if (p.encodings?.[0]) p.encodings[0].maxBitrate = +$('#kbps').value * 1000;
    try { await s.setParameters(p); } catch (e) { log('setParameters-error', { msg: String(e) }); }
  }
}

/* ------------------------------ Receiver ------------------------------- */
let remoteFormat = null, weaveHandle = null, flatLoop = 0;
function onHello(msg) {
  if (msg?.type !== 'hello') return;
  report.hello = msg; remoteFormat = msg.format; log('hello', msg);
  $('#remote-cap').textContent = `remote says: ${msg.format} ${msg.width}×${msg.height}`;
  route();
}

function showRemote(stream) {
  const v = $('#remote');
  v.srcObject = stream;
  v.play().catch(() => {});
  v.addEventListener('playing', route, { once: true });
}

function route() {
  const v = $('#remote'), canvas = $('#remote-canvas');
  if (!v.srcObject || !remoteFormat || v.readyState < 2) return;
  cancelAnimationFrame(flatLoop); weaveHandle?.remove(); weaveHandle = null;
  if (remoteFormat === 'sbs' && wall.supported) {
    weaveHandle = wall.addVideo(canvas, v); // full SBS, left eye in the left half
    log('route', { mode: 'woven-sbs' });
    return;
  }
  // Flat path: mono peer, or any peer on a non-DisplayXR browser (draws the raw pair).
  const g = canvas.getContext('2d');
  const paint = () => {
    if (v.videoWidth) {
      canvas.width = v.videoWidth; canvas.height = v.videoHeight;
      g.drawImage(v, 0, 0);
    }
    flatLoop = requestAnimationFrame(paint);
  };
  paint();
  log('route', { mode: 'flat', format: remoteFormat });
}

/* -------------------------------- Stats -------------------------------- */
function pollStats(pc) {
  let prev = {};
  setInterval(async () => {
    const r = await pc.getStats();
    const codecs = {}; r.forEach((s) => { if (s.type === 'codec') codecs[s.id] = s.mimeType; });
    const row = { t: Math.round(performance.now() / 1000) };
    r.forEach((s) => {
      if (s.kind !== 'video') return;
      if (s.type === 'outbound-rtp') {
        row.out = {
          w: s.frameWidth, h: s.frameHeight, fps: s.framesPerSecond, codec: codecs[s.codecId],
          kbps: prev.sent != null ? Math.round((s.bytesSent - prev.sent) * 8 / 2000) : null,
          limit: s.qualityLimitationReason, encoder: s.encoderImplementation,
        };
        prev.sent = s.bytesSent;
      } else if (s.type === 'inbound-rtp') {
        row.in = {
          w: s.frameWidth, h: s.frameHeight, fps: s.framesPerSecond, codec: codecs[s.codecId],
          kbps: prev.recv != null ? Math.round((s.bytesReceived - prev.recv) * 8 / 2000) : null,
          decoder: s.decoderImplementation, dropped: s.framesDropped,
        };
        prev.recv = s.bytesReceived;
      }
    });
    report.stats.push(row); if (report.stats.length > 60) report.stats.shift();
    $('#stats-out').textContent = JSON.stringify(row, null, 2);
    if (row.t % 10 < 2) log('stats', row); // ~every 10 s — keep the console readable
  }, 2000);
}

$('#btn-report').onclick = async () => {
  const txt = JSON.stringify(report, null, 2);
  log('report', report);
  try { await navigator.clipboard.writeText(txt); $('#btn-report').textContent = 'Copied'; }
  catch { $('#stats-out').textContent = txt; }
};

if (q.get('probe') === '1') probe();
if (q.get('autostart') === '1') start().catch((e) => log('start-error', { msg: String(e) }));
