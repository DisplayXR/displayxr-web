// Full-viewport triangle for the live DIBR pass. One draw per view; the viewport is set by the
// caller to layer.getViewport(view), so vUv spans exactly that view's tile (0..1, GL-up).
export default /* glsl */ `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // gl_VertexID 0,1,2 -> (-1,-1) (3,-1) (-1,3): one triangle covering the viewport.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;
