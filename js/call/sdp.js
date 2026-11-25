// call/sdp.js — video codec preference: VP9 > VP8 > AV1, then whatever else the browser offers.
//
// The DisplayXR Browser is a proprietary-codec-free build: it has NO H.264. A call must never
// require H.264, so it is never preferred — it stays in the list (after ours) only so a peer that
// can do nothing else still negotiates. Safari negotiates VP8 (and VP9 on recent builds).
//
// Two mechanisms, same order: `RTCRtpTransceiver.setCodecPreferences` where it exists (every
// current engine), and SDP munging of the `m=video` line as the fallback. Both are pure here.

/** Preferred video codecs, best first (mime subtype, upper case). */
export const VIDEO_CODEC_ORDER = Object.freeze(['VP9', 'VP8', 'AV1']);

/** Rank of a codec name: its index in VIDEO_CODEC_ORDER, or order.length for everything else. */
export function codecRank(name, order = VIDEO_CODEC_ORDER) {
  const i = order.indexOf(String(name || '').toUpperCase());
  return i < 0 ? order.length : i;
}

/**
 * Sort `RTCRtpCodecCapability[]` (from `RTCRtpReceiver.getCapabilities('video').codecs`) into
 * our preference order. Stable within a rank, so the browser's own order among VP9 profiles, and
 * RTX/RED/FEC placement, is kept. Pure.
 */
export function sortCodecCapabilities(codecs, order = VIDEO_CODEC_ORDER) {
  const rank = (c) => codecRank(String(c.mimeType || '').split('/')[1], order);
  return codecs
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

/**
 * Reorder the payload types on the `m=video` line so VP9 > VP8 > AV1 come first, each followed
 * by its RTX (`a=fmtp:<rtx> apt=<pt>`). Everything else keeps its relative order behind them.
 * Returns the SDP unchanged if there is no video section. Pure.
 * @param {string} sdp
 */
export function preferVideoCodecs(sdp, order = VIDEO_CODEC_ORDER) {
  if (!sdp) return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol);
  const mi = lines.findIndex((l) => l.startsWith('m=video'));
  if (mi < 0) return sdp;
  let end = lines.findIndex((l, i) => i > mi && l.startsWith('m='));
  if (end < 0) end = lines.length;
  const section = lines.slice(mi, end);
  const nameOf = new Map(); // pt -> codec name
  const rtxFor = new Map(); // apt -> [rtx pts]
  for (const l of section) {
    const m = l.match(/^a=rtpmap:(\d+) ([\w-]+)\//);
    if (m) nameOf.set(m[1], m[2].toUpperCase());
    const f = l.match(/^a=fmtp:(\d+) apt=(\d+)/);
    if (f) {
      if (!rtxFor.has(f[2])) rtxFor.set(f[2], []);
      rtxFor.get(f[2]).push(f[1]);
    }
  }
  const parts = lines[mi].split(' ');
  const pts = parts.slice(3);
  const picked = [];
  for (const want of order) {
    for (const pt of pts) {
      if (nameOf.get(pt) === want && !picked.includes(pt)) {
        picked.push(pt);
        for (const rtx of rtxFor.get(pt) || []) if (pts.includes(rtx) && !picked.includes(rtx)) picked.push(rtx);
      }
    }
  }
  if (!picked.length) return sdp;
  const rest = pts.filter((p) => !picked.includes(p));
  lines[mi] = [...parts.slice(0, 3), ...picked, ...rest].join(' ');
  return lines.join(eol);
}

/** The codec names on the `m=video` line, in order (for tests and diagnostics). */
export function videoCodecOrder(sdp) {
  const lines = String(sdp || '').split(/\r?\n/);
  const mi = lines.findIndex((l) => l.startsWith('m=video'));
  if (mi < 0) return [];
  const names = new Map();
  for (const l of lines) {
    const m = l.match(/^a=rtpmap:(\d+) ([\w-]+)\//);
    if (m) names.set(m[1], m[2].toUpperCase());
  }
  return lines[mi].split(' ').slice(3).map((pt) => names.get(pt) || pt);
}
