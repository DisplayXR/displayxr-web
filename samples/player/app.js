// player — one media title, two ways: a real stereo pair (default) and a deliberately flat one
// (format:'mono'), both driven by the SDK transport. See docs/authoring-inline-3d.md#2b-player.

import { createInline3D } from '@displayxr/inline3d';
import { addPlayer } from '@displayxr/inline3d/player';

// Reusing samples/windows/ own asset rather than duplicating a 5.5 MB file — see that sample's
// app.js for why it's VP9/WebM (stock Chromium ships no proprietary H.264 decoder) and why it's
// 640x360/eye (a 3D display's recommended render scale throws the rest away after the interlace).
const SRC = '../windows/assets/flymetothemoon_sbs.webm';
const POSTER = undefined; // no poster asset shipped with this sample; the first frame paints itself.

function setStatus(mode, text) {
  const el = document.getElementById('status');
  el.className = 'status ' + mode;
  el.textContent = text;
}

const wall = await createInline3D();

const sbsPlayer = addPlayer(wall, document.getElementById('tile-sbs'), SRC, {
  format: 'sbs',
  loop: true,
  title: 'Fly Me to the Moon',
  // Opt-in: creates the mixer that lets setSource() dissolve instead of cut.
  transition: 'crossfade',
  durationMs: 700,
  poster: POSTER,
  // The page knows this tile is the woven one AND that it is on screen, so it can honestly say
  // so. addPlayer never infers this for you — see docs/authoring-inline-3d.md#2b-player.
  badge3d: wall.supported,
});

const monoPlayer = addPlayer(wall, document.getElementById('tile-mono'), SRC, {
  format: 'mono',
  loop: true,
  poster: POSTER,
});

// Debug hooks, same convention as the other samples' __wall/__splat: lets a devtools console
// (or an agent driving the page, e.g. via headless CDP) inspect/drive the players directly.
window.__wall = wall;
window.player = sbsPlayer;
window.playerMono = monoPlayer;

setStatus(
  wall.supported ? 'woven' : 'flat',
  wall.supported
    ? 'DisplayXR Browser — left tile woven glasses-free 3D, right tile deliberately flat.'
    : 'No inline-3D here — both tiles render flat 2D video (open in the DisplayXR Browser for the left tile to weave).'
);

// Chapters: the one stereo asset this repo ships, entered at three points, so each chip is a real
// setSource() — and each swap a real crossfade from the outgoing frame. The entry point is a seek
// once the new source's metadata lands: a `#t=` media fragment is NOT honoured on an in-place
// swap in Chromium (measured: it plays from 0:00), so it cannot carry the chapter.
const CHAPTERS = [
  { label: 'Opening', t: 0 },
  { label: 'Cockpit', t: 8 },
  { label: 'Finale', t: 16 },
];
const chipsEl = document.getElementById('chapters');
for (const [i, ch] of CHAPTERS.entries()) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = ch.label;
  b.setAttribute('aria-pressed', String(i === 0));
  b.addEventListener('click', () => {
    for (const other of chipsEl.children) other.setAttribute('aria-pressed', String(other === b));
    sbsPlayer.setSource(SRC, { title: `Fly Me to the Moon — ${ch.label}` });
    sbsPlayer.video.addEventListener('loadedmetadata', () => sbsPlayer.seek(ch.t), { once: true });
    sbsPlayer.play().catch(() => {});
  });
  chipsEl.append(b);
}
