// camera/metadata.js — stereo metadata that travels INSIDE the captured file (RFC 0003 Decision 9):
// an XMP packet in a JPEG (APP1 segment), a `Tags` element in a WebM. No sidecar.
//
// What is recorded is what a viewer needs to show the pair correctly and to re-converge it: the
// layout (side-by-side, 2×1, left eye left), the disparity of the subject the capture converged
// on, and the camera's baseline / field of view / rectified flag when known. Photos store the RAW
// rectified pair and report the convergence alongside (baking the shift crops the edges — RFC
// 0003 §4), so `convergencePx` is advisory: "shift the eyes toward each other by half of this to
// put the face at the display plane". Keys are `dxr:` in XMP and `DXR_*` in WebM.
//
// Pure byte work on Uint8Arrays — no DOM, no codecs — so every writer has a reader and both are
// round-tripped under `node --test` (test/camera.test.mjs). Robustness over completeness: a
// JPEG without an XMP segment reads as `null`, a WebM with a known-size Segment gets its size
// patched in place, and a reader that cannot walk a file falls back to the one place the writer
// ever puts the tags (the end of the file).

export const XMP_NS = 'http://displayxr.org/ns/stereo/1.0/';
const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';

/** The stereo metadata record both containers carry. `layout` is `'sbs'` (2×1, left eye left) or `'mono'`. */
export function normalizeStereoMeta(m = {}) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const layout = m.layout === 'sbs' || m.layout === 'side-by-side' ? 'sbs' : 'mono';
  return {
    layout,
    columns: layout === 'sbs' ? 2 : 1,
    rows: 1,
    convergencePx: num(m.convergencePx),
    baselineMm: num(m.baselineMm),
    horizontalFovDeg: num(m.horizontalFovDeg),
    rectified: m.rectified === true ? true : m.rectified === false ? false : null,
    eyeWidth: num(m.eyeWidth),
    eyeHeight: num(m.eyeHeight),
    software: typeof m.software === 'string' && m.software ? m.software : null,
  };
}

// ── XMP ────────────────────────────────────────────────────────────────────────────────────

const xmlAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const r3 = (v) => Math.round(v * 1000) / 1000;

/** The XMP packet (a string) for a stereo record. Attribute form, one `rdf:Description`. */
export function buildStereoXmp(meta) {
  const m = normalizeStereoMeta(meta);
  const attrs = [
    ['Layout', m.layout === 'sbs' ? 'side-by-side' : 'mono'],
    ['Columns', m.columns],
    ['Rows', m.rows],
    ['ConvergencePx', m.convergencePx === null ? null : r3(m.convergencePx)],
    ['BaselineMm', m.baselineMm === null ? null : r3(m.baselineMm)],
    ['HorizontalFovDeg', m.horizontalFovDeg === null ? null : r3(m.horizontalFovDeg)],
    ['Rectified', m.rectified === null ? null : m.rectified ? 'True' : 'False'],
    ['EyeWidth', m.eyeWidth],
    ['EyeHeight', m.eyeHeight],
    ['Software', m.software],
  ]
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => ` dxr:${k}="${xmlAttr(v)}"`)
    .join('');
  return (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    `<rdf:Description rdf:about="" xmlns:dxr="${XMP_NS}"${attrs}/>` +
    '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
  );
}

/** The stereo record in an XMP packet, or null when it carries none (`dxr:` attributes or elements). */
export function parseStereoXmp(xml) {
  if (typeof xml !== 'string' || !xml.includes(XMP_NS)) return null;
  const get = (k) => {
    const a = new RegExp(`\\bdxr:${k}="([^"]*)"`).exec(xml);
    if (a) return a[1];
    const e = new RegExp(`<dxr:${k}>([^<]*)</dxr:${k}>`).exec(xml);
    return e ? e[1] : null;
  };
  const num = (k) => {
    const v = get(k);
    return v === null || v === '' || !Number.isFinite(+v) ? null : +v;
  };
  const rect = get('Rectified');
  const layout = get('Layout');
  const sw = get('Software');
  return normalizeStereoMeta({
    layout: layout === 'side-by-side' || layout === 'sbs' ? 'sbs' : 'mono',
    convergencePx: num('ConvergencePx'),
    baselineMm: num('BaselineMm'),
    horizontalFovDeg: num('HorizontalFovDeg'),
    rectified: rect === null ? null : /^true$/i.test(rect),
    eyeWidth: num('EyeWidth'),
    eyeHeight: num('EyeHeight'),
    software: sw === null ? null : sw.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&'),
  });
}

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

/** Is this a JPEG (starts with SOI)? */
export const isJpeg = (bytes) => bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8;

/**
 * Walk a JPEG's marker segments up to SOS. Yields `{ marker, start, end, data }` where `start` is
 * the marker's 0xFF byte and `end` the first byte after the segment.
 */
function* jpegSegments(bytes) {
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return;
    const marker = bytes[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      i += marker === 0xff ? 1 : 2; // standalone markers / fill bytes
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return; // SOS / EOI: entropy-coded data follows
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) return;
    yield { marker, start: i, end: i + 2 + len, data: bytes.subarray(i + 4, i + 2 + len) };
    i += 2 + len;
  }
}

function startsWith(data, str) {
  if (data.length < str.length) return false;
  for (let i = 0; i < str.length; i++) if (data[i] !== str.charCodeAt(i)) return false;
  return true;
}

/**
 * A copy of `bytes` with `xmp` as an APP1 XMP segment — replacing an existing XMP segment, else
 * inserted after the SOI and any APP0/APP1 (JFIF/EXIF) segments, where readers expect it.
 * Throws on a non-JPEG or a packet that does not fit one segment (65 KB).
 * @param {Uint8Array} bytes
 * @param {string} xmp
 */
export function jpegWithXmp(bytes, xmp) {
  if (!isJpeg(bytes)) throw new TypeError('jpegWithXmp: not a JPEG');
  const payload = new Uint8Array([...enc(XMP_HEADER), ...enc(xmp)]);
  const len = payload.length + 2;
  if (len > 0xffff) throw new RangeError('jpegWithXmp: XMP packet too large for one APP1 segment');
  const seg = new Uint8Array(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg[2] = len >> 8;
  seg[3] = len & 0xff;
  seg.set(payload, 4);
  let at = 2;
  let replace = null;
  for (const s of jpegSegments(bytes)) {
    if (s.marker === 0xe1 && startsWith(s.data, XMP_HEADER)) {
      replace = s;
      break;
    }
    if (s.marker === 0xe0 || s.marker === 0xe1) at = s.end;
    else break;
  }
  const [cutA, cutB] = replace ? [replace.start, replace.end] : [at, at];
  const out = new Uint8Array(bytes.length - (cutB - cutA) + seg.length);
  out.set(bytes.subarray(0, cutA), 0);
  out.set(seg, cutA);
  out.set(bytes.subarray(cutB), cutA + seg.length);
  return out;
}

/** The XMP packet string of a JPEG, or null. */
export function readJpegXmp(bytes) {
  if (!isJpeg(bytes)) return null;
  for (const s of jpegSegments(bytes)) if (s.marker === 0xe1 && startsWith(s.data, XMP_HEADER)) return dec(s.data.subarray(XMP_HEADER.length));
  return null;
}

/** The stereo record of a JPEG (`parseStereoXmp(readJpegXmp(bytes))`), or null. */
export const readJpegStereoMeta = (bytes) => parseStereoXmp(readJpegXmp(bytes));

// ── WebM (Matroska / EBML) ─────────────────────────────────────────────────────────────────

const ID = { EBML: 0x1a45dfa3, Segment: 0x18538067, Tags: 0x1254c367, Tag: 0x7373, Targets: 0x63c0, SimpleTag: 0x67c8, TagName: 0x45a3, TagString: 0x4487 };

/** Is this an EBML/WebM file? */
export const isWebm = (bytes) => bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;

function idBytes(id) {
  const out = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
}

/** An EBML size vint of `width` bytes (1..8) for `n`; `width` 0 = the shortest that fits. */
function vint(n, width = 0) {
  let w = width;
  if (!w) for (w = 1; w < 8 && n > 2 ** (7 * w) - 2; w++);
  const out = new Array(w).fill(0);
  let v = n;
  for (let i = w - 1; i >= 1; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] = (0x80 >> (w - 1)) | v;
  return out;
}

/** Read an element ID at `i` (1..4 bytes, by leading zeros). */
function readId(bytes, i) {
  const b = bytes[i];
  const w = b >= 0x80 ? 1 : b >= 0x40 ? 2 : b >= 0x20 ? 3 : b >= 0x10 ? 4 : 0;
  if (!w || i + w > bytes.length) return null;
  let id = 0;
  for (let k = 0; k < w; k++) id = id * 256 + bytes[i + k];
  return { id, width: w };
}

/** Read a size vint at `i`. `unknown` = the all-ones "unknown size" (live/streamed files). */
function readSize(bytes, i) {
  const b = bytes[i];
  let w = 1;
  while (w <= 8 && !(b & (0x80 >> (w - 1)))) w++;
  if (w > 8 || i + w > bytes.length) return null;
  let v = b & (0xff >> w);
  let allOnes = v === 0x7f >> (w - 1);
  for (let k = 1; k < w; k++) {
    v = v * 256 + bytes[i + k];
    if (bytes[i + k] !== 0xff) allOnes = false;
  }
  return { size: v, width: w, unknown: allOnes };
}

function element(id, payload) {
  return [...idBytes(id), ...vint(payload.length), ...payload];
}

/** The bytes of a `Tags` element holding one whole-file `Tag` with a `SimpleTag` per entry. */
export function buildWebmTags(entries) {
  const simple = [];
  for (const [name, value] of Object.entries(entries)) {
    if (value === null || value === undefined) continue;
    simple.push(...element(ID.SimpleTag, [...element(ID.TagName, [...enc(String(name))]), ...element(ID.TagString, [...enc(String(value))])]));
  }
  const tag = element(ID.Tag, [...element(ID.Targets, []), ...simple]);
  return new Uint8Array(element(ID.Tags, tag));
}

/** The `DXR_*` tag entries for a stereo record (the WebM twin of {@link buildStereoXmp}). */
export function stereoTagEntries(meta) {
  const m = normalizeStereoMeta(meta);
  return {
    DXR_LAYOUT: m.layout === 'sbs' ? 'side-by-side' : 'mono',
    DXR_COLUMNS: String(m.columns),
    DXR_ROWS: String(m.rows),
    DXR_CONVERGENCE_PX: m.convergencePx === null ? null : String(r3(m.convergencePx)),
    DXR_BASELINE_MM: m.baselineMm === null ? null : String(r3(m.baselineMm)),
    DXR_HFOV_DEG: m.horizontalFovDeg === null ? null : String(r3(m.horizontalFovDeg)),
    DXR_RECTIFIED: m.rectified === null ? null : m.rectified ? 'true' : 'false',
    DXR_EYE_WIDTH: m.eyeWidth === null ? null : String(m.eyeWidth),
    DXR_EYE_HEIGHT: m.eyeHeight === null ? null : String(m.eyeHeight),
    DXR_SOFTWARE: m.software,
  };
}

/** The stereo record in a `DXR_*` tag map, or null when it carries none. */
export function parseStereoTags(tags) {
  if (!tags || !('DXR_LAYOUT' in tags)) return null;
  const num = (k) => (tags[k] === undefined || tags[k] === '' || !Number.isFinite(+tags[k]) ? null : +tags[k]);
  return normalizeStereoMeta({
    layout: tags.DXR_LAYOUT === 'side-by-side' ? 'sbs' : 'mono',
    convergencePx: num('DXR_CONVERGENCE_PX'),
    baselineMm: num('DXR_BASELINE_MM'),
    horizontalFovDeg: num('DXR_HFOV_DEG'),
    rectified: tags.DXR_RECTIFIED === undefined ? null : tags.DXR_RECTIFIED === 'true',
    eyeWidth: num('DXR_EYE_WIDTH'),
    eyeHeight: num('DXR_EYE_HEIGHT'),
    software: tags.DXR_SOFTWARE ?? null,
  });
}

/** Locate the Segment: `{ sizeAt, sizeWidth, unknown, dataStart, size }`, or null. */
function findSegment(bytes) {
  if (!isWebm(bytes)) return null;
  const hs = readSize(bytes, 4);
  if (!hs) return null;
  let i = 4 + hs.width + hs.size;
  while (i < bytes.length) {
    const id = readId(bytes, i);
    if (!id) return null;
    const sz = readSize(bytes, i + id.width);
    if (!sz) return null;
    const dataStart = i + id.width + sz.width;
    if (id.id === ID.Segment) return { sizeAt: i + id.width, sizeWidth: sz.width, unknown: sz.unknown, dataStart, size: sz.size };
    if (sz.unknown) return null;
    i = dataStart + sz.size; // a Void or other top-level element before the Segment
  }
  return null;
}

/**
 * A copy of `bytes` with a `Tags` element appended to the Segment. A Segment of unknown size
 * (what a `MediaRecorder` writes) just grows; a known size is patched in place when its vint
 * has room, else the vint is re-written at 8 bytes (the only shift this function ever makes,
 * and only ahead of the first child). Throws on a non-WebM file.
 * @param {Uint8Array} bytes
 * @param {Record<string, string | null | undefined>} entries
 */
export function webmWithTags(bytes, entries) {
  const seg = findSegment(bytes);
  if (!seg) throw new TypeError('webmWithTags: not a WebM/Matroska file (no Segment)');
  const tags = buildWebmTags(entries);
  if (seg.unknown) {
    const out = new Uint8Array(bytes.length + tags.length);
    out.set(bytes, 0);
    out.set(tags, bytes.length);
    return out;
  }
  const end = Math.min(bytes.length, seg.dataStart + seg.size);
  const newSize = end - seg.dataStart + tags.length;
  const fits = newSize <= 2 ** (7 * seg.sizeWidth) - 2;
  const sizeBytes = vint(newSize, fits ? seg.sizeWidth : 8);
  const out = new Uint8Array(seg.sizeAt + sizeBytes.length + (end - seg.dataStart) + tags.length + (bytes.length - end));
  out.set(bytes.subarray(0, seg.sizeAt), 0);
  out.set(sizeBytes, seg.sizeAt);
  let o = seg.sizeAt + sizeBytes.length;
  out.set(bytes.subarray(seg.dataStart, end), o);
  o += end - seg.dataStart;
  out.set(tags, o);
  o += tags.length;
  out.set(bytes.subarray(end), o);
  return out;
}

function parseTagsElement(bytes, start, end) {
  const out = {};
  const walk = (a, b, fn) => {
    let i = a;
    while (i < b) {
      const id = readId(bytes, i);
      if (!id) return;
      const sz = readSize(bytes, i + id.width);
      if (!sz || sz.unknown) return;
      const ds = i + id.width + sz.width;
      fn(id.id, ds, Math.min(b, ds + sz.size));
      i = ds + sz.size;
    }
  };
  walk(start, end, (id, a, b) => {
    if (id !== ID.Tag) return;
    walk(a, b, (id2, c, d) => {
      if (id2 !== ID.SimpleTag) return;
      let name = null;
      let value = null;
      walk(c, d, (id3, e, f) => {
        if (id3 === ID.TagName) name = dec(bytes.subarray(e, f));
        else if (id3 === ID.TagString) value = dec(bytes.subarray(e, f));
      });
      if (name !== null) out[name] = value ?? '';
    });
  });
  return out;
}

/**
 * Every `SimpleTag` name → string in the file's `Tags` elements (later ones win), or null when
 * there are none. Walks the Segment's children; where a child of unknown size blocks the walk
 * (a live-written Cluster), falls back to the trailing `Tags` element the writer appends.
 */
export function readWebmTags(bytes) {
  const seg = findSegment(bytes);
  if (!seg) return null;
  const end = seg.unknown ? bytes.length : Math.min(bytes.length, seg.dataStart + seg.size);
  let found = null;
  let i = seg.dataStart;
  while (i < end) {
    const id = readId(bytes, i);
    if (!id) break;
    const sz = readSize(bytes, i + id.width);
    if (!sz) break;
    const ds = i + id.width + sz.width;
    if (id.id === ID.Tags && !sz.unknown) found = { ...(found || {}), ...parseTagsElement(bytes, ds, Math.min(end, ds + sz.size)) };
    if (sz.unknown) {
      found = found || trailingTags(bytes, end);
      break;
    }
    i = ds + sz.size;
  }
  return found;
}

/** The `Tags` element that ends exactly at `end` (where {@link webmWithTags} puts it), if any. */
function trailingTags(bytes, end) {
  const sig = idBytes(ID.Tags);
  for (let i = end - sig.length - 1; i >= 0; i--) {
    if (bytes[i] !== sig[0] || bytes[i + 1] !== sig[1] || bytes[i + 2] !== sig[2] || bytes[i + 3] !== sig[3]) continue;
    const sz = readSize(bytes, i + 4);
    if (sz && !sz.unknown && i + 4 + sz.width + sz.size === end) return parseTagsElement(bytes, i + 4 + sz.width, end);
  }
  return null;
}

/** The stereo record of a WebM (`parseStereoTags(readWebmTags(bytes))`), or null. */
export const readWebmStereoMeta = (bytes) => parseStereoTags(readWebmTags(bytes));
