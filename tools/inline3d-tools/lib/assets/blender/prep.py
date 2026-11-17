# Headless Blender asset prep for inline-3D pages. Run ONLY with a Blender that is already installed:
#
#   blender -b --factory-startup -P prep.py -- <in.(fbx|obj|stl|ply|dae|blend|glb|gltf)> <out.glb> [--decimate 0.5] [--metres 0.01]
#
# Imports the file, applies transforms, optionally scales to metres (--metres = how many metres
# one source unit is, e.g. 0.01 for centimetres) and decimates, recentres the bounds on the origin,
# and exports a single binary .glb (+Y up, as glTF expects).
import sys, os
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) < 2:
    print("usage: blender -b --factory-startup -P prep.py -- <in> <out.glb> [--decimate R] [--metres S]")
    sys.exit(2)
src, dst = argv[0], argv[1]
def opt(name, default=None):
    return float(argv[argv.index(name) + 1]) if name in argv else default
ratio = opt("--decimate")
metres = opt("--metres")

bpy.ops.wm.read_factory_settings(use_empty=True)
ext = os.path.splitext(src)[1].lower()
if ext == ".blend":
    bpy.ops.wm.open_mainfile(filepath=src)
elif ext in (".glb", ".gltf"):
    bpy.ops.import_scene.gltf(filepath=src)
elif ext == ".fbx":
    bpy.ops.import_scene.fbx(filepath=src)
elif ext == ".obj":
    bpy.ops.wm.obj_import(filepath=src)
elif ext == ".stl":
    bpy.ops.wm.stl_import(filepath=src)
elif ext == ".ply":
    bpy.ops.wm.ply_import(filepath=src)
elif ext == ".dae":
    bpy.ops.wm.collada_import(filepath=src)
else:
    print(f"unsupported input {ext}")
    sys.exit(2)

meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if not meshes:
    print("no mesh objects in the file")
    sys.exit(1)
bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if metres:
    for o in meshes:
        o.scale = o.scale * metres
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

if ratio and 0 < ratio < 1:
    for o in meshes:
        m = o.modifiers.new("Decimate", "DECIMATE")
        m.ratio = ratio
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=m.name)

# Recentre the combined bounds on the origin (the subject straddles the glass on a display rig).
lo = Vector((1e30, 1e30, 1e30)); hi = Vector((-1e30, -1e30, -1e30))
for o in meshes:
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
centre = (lo + hi) / 2
for o in meshes:
    o.location -= centre

bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", use_selection=True, export_apply=True, export_yup=True)
tris = sum(len(p.vertices) - 2 for o in meshes for p in o.data.polygons)
print(f"prep.py: wrote {dst}; ~{tris} triangles; size {tuple(round(v, 4) for v in (hi - lo))}")
