// inline3d-playcanvas-engine.js — the slice of `playcanvas` the SDK's two PlayCanvas backends use,
// as NAMED re-exports.
//
// Internal. ./model and ./splat import THIS module (dynamically) instead of `import('playcanvas')`.
// A dynamic import of the package hands back its whole namespace, and a bundler cannot know which
// members a namespace object will be asked for — so it keeps all of them: the full engine
// (physics, UI, audio, particles, XR, the WebGPU backend …) lands in the page's bundle. Naming
// the members here is what lets a bundler drop everything else. The page's own `import … from
// 'playcanvas'` still resolves to the SAME module instance, so entities a page adds under
// `handle.engine.root` are the engine's own types.
//
// Adding an engine member to either adapter? Add it here too; test/playcanvas-engine.test.mjs
// fails on a `pc.X` the adapters read that this list does not export.
export {
  // app + device
  AppBase,
  AppOptions,
  createGraphicsDevice,
  DEVICETYPE_WEBGL2,
  RESOLUTION_FIXED,
  // component systems + resource handlers (PLAYCANVAS_SYSTEMS / PLAYCANVAS_HANDLERS)
  CameraComponentSystem,
  GSplatComponentSystem,
  RenderComponentSystem,
  LightComponentSystem,
  AnimComponentSystem,
  TextureHandler,
  GSplatHandler,
  ContainerHandler,
  // scene graph + cameras
  Entity,
  GraphNode,
  Camera,
  RenderView,
  Asset,
  Color,
  Vec4,
  Quat,
  LAYERID_SKYBOX,
  LAYERID_UI,
  // materials / meshes (the edge feather)
  Mesh,
  MeshInstance,
  ShaderMaterial,
  BlendState,
  BLENDEQUATION_ADD,
  BLENDMODE_SRC_ALPHA,
  BLENDMODE_ZERO,
  BLENDMODE_ONE,
  BLENDMODE_ONE_MINUS_SRC_ALPHA,
  CULLFACE_NONE,
  SEMANTIC_POSITION,
  SEMANTIC_TEXCOORD0,
  ShaderChunks,
  SHADERLANGUAGE_GLSL,
  // setSource's frame snapshot
  RenderTarget,
  FILTER_NEAREST,
  // setSource's live outgoing asset (./inline3d-splat-live.js)
  Layer,
  // splats
  WORKBUFFER_UPDATE_AUTO,
  WORKBUFFER_UPDATE_ALWAYS,
  WORKBUFFER_UPDATE_ONCE,
  // tone mapping (TONE_MAPPINGS)
  TONEMAP_NONE,
  TONEMAP_LINEAR,
  TONEMAP_NEUTRAL,
  TONEMAP_ACES,
  TONEMAP_ACES2,
  TONEMAP_FILMIC,
  TONEMAP_HEJL,
  // lighting (./model)
  Texture,
  EnvLighting,
  PIXELFORMAT_RGBA8,
  TEXTURETYPE_RGBE,
  TEXTUREPROJECTION_EQUIRECT,
  ADDRESS_REPEAT,
  ADDRESS_CLAMP_TO_EDGE,
  // compressed glTF (./model)
  dracoInitialize,
  basisInitialize,
  version,
} from 'playcanvas';
