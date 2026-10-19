"""
Exports the open .blend to a .glb the game loads.

    blender -b levels/hall.blend --python tools/blender/export_glb.py -- public/levels/hall.glb

Only what the game reads is exported: meshes (with modifiers applied), material names,
object names and custom properties, and object animations. No textures, UVs, normals,
cameras or lights. Objects whose names start with X_ are helpers and stay out.
"""

import os
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if not argv:
    print("[export_glb] usage: blender -b file.blend --python export_glb.py -- out.glb")
    sys.exit(2)
out_path = os.path.abspath(argv[0])
os.makedirs(os.path.dirname(out_path), exist_ok=True)

# Helpers (X_ prefix) and anything hidden from render stay out of the game.
for obj in bpy.context.scene.objects:
    keep = not obj.name.startswith("X_") and not obj.hide_render
    obj.hide_set(False)
    obj.select_set(keep)

kwargs = dict(
    filepath=out_path,
    export_format="GLB",
    use_selection=True,
    export_apply=True,
    export_extras=True,
    export_yup=True,
    export_texcoords=False,
    export_normals=False,
    export_materials="EXPORT",
    export_image_format="NONE",
    export_cameras=False,
    export_lights=False,
    export_animations=True,
    export_animation_mode="ACTIONS",
    export_force_sampling=True,
    export_def_bones=False,
)
# Option names drift between Blender versions: drop the ones this build doesn't know.
props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
kwargs = {k: v for k, v in kwargs.items() if k in props}
bpy.ops.export_scene.gltf(**kwargs)
print(f"[export_glb] wrote {out_path} ({os.path.getsize(out_path)} bytes)")
