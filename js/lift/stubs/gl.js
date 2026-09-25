// lift/stubs/gl.js — tiny WebGL2 helpers shared by the stubs. Not part of any contract.

export function getGL(canvas) {
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false });
  if (!gl) throw new Error('lift stub: WebGL2 unavailable');
  return gl;
}

export function program(gl, vs, fs) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
  return p;
}

/** Normalise an un-normalised disparity map to 0..1 bytes (min/max). */
export function disparityToBytes(data) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Math.round(((data[i] - lo) / span) * 255);
  return out;
}

/** Horizontal eye factor for view i of n: -1..+1 (0 for a single mono view). */
export function eyeFactor(i, n) {
  return n > 1 ? (i - (n - 1) / 2) / ((n - 1) / 2) : 0;
}
