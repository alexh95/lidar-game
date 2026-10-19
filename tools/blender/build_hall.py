"""
Builds the first test level, levels/hall.blend, from scratch.

This is how the first draft was made. From now on the .blend is the source: open it in
Blender and edit it by hand. Re-running this script refuses to overwrite an existing file
unless you pass --force (and then your hand edits are gone).

    blender -b --factory-startup --python tools/blender/build_hall.py -- levels/hall.blend [--force]

Coordinates are Blender's: X east, Y north, Z up, metres. The glTF export turns +Y into
three.js's -Z (forward). The player spawns in the vestibule facing north.

Layout:
  vestibule  x -2..2,  y -3..2,   3 m tall. Spawn, a bench, a ceiling lamp.
  corridor   x -1..1,  y 2..14,   2.6 m. Ceiling beams, a sealed door, a window west into
             the pendulum room (a pendulum swings there, out of reach).
  hall       x -10..10, y 14..34, 8 m. Two rows of columns, stairs up the east wall to a
             mezzanine, a slowly turning monolith behind a railing in the middle.
  terrace    west of the hall through a wide opening, with a parapet. Below it, 5 m down,
             a flat expanse with a tower, three standing stones, and something that drifts.
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
out_path = os.path.abspath(argv[0] if argv else "levels/hall.blend")
force = "--force" in argv
if os.path.exists(out_path) and not force:
    print(f"[build_hall] {out_path} exists; pass --force to overwrite it (hand edits would be lost)")
    sys.exit(1)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.name = "hall"
scene.unit_settings.system = "METRIC"
scene.render.fps = 30

# ---- materials: the name is what the game reads (see levels/README.md) ----
MATERIALS = {
    "concrete": (0.55, 0.55, 0.55),
    "plaster": (0.80, 0.78, 0.72),
    "tile": (0.70, 0.72, 0.75),
    "metal": (0.45, 0.50, 0.60),
    "wood": (0.50, 0.35, 0.20),
    "stone": (0.40, 0.40, 0.38),
    # Anything with an entity material leaves dots that fade. Red in the viewport so it stands out.
    "entity": (0.90, 0.20, 0.15),
}
mats = {}
for name, rgb in MATERIALS.items():
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1.0)
    try:
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.8
    except AttributeError:
        pass
    mats[name] = m

collections = {}


def coll(name):
    if name not in collections:
        c = bpy.data.collections.new(name)
        scene.collection.children.link(c)
        collections[name] = c
    return collections[name]


def link(obj, collection):
    coll(collection).objects.link(obj)
    return obj


def mesh_object(name, bm, material, collection, location=(0, 0, 0)):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mats[material])
    obj = bpy.data.objects.new(name, me)
    obj.location = location
    return link(obj, collection)


def box(name, x0, x1, y0, y1, z0, z1, material, collection):
    """An axis-aligned box from its extents (world coordinates)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    sx, sy, sz = x1 - x0, y1 - y0, z1 - z0
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    return mesh_object(name, bm, material, collection, ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))


def cylinder(name, x, y, z0, z1, r, material, collection, segments=20):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments, radius1=r, radius2=r, depth=z1 - z0)
    return mesh_object(name, bm, material, collection, (x, y, (z0 + z1) / 2))


def wall_with_opening(name, axis, fixed0, fixed1, a0, a1, z0, z1, op_a0, op_a1, op_z0, op_z1, material, collection):
    """
    A wall slab along `axis` ('x' or 'y') spanning a0..a1, z0..z1, with a rectangular opening.
    fixed0..fixed1 is its thickness across the other axis.
    """
    parts = []

    def piece(tag, b0, b1, c0, c1):
        if b1 - b0 < 1e-4 or c1 - c0 < 1e-4:
            return
        if axis == "x":
            parts.append(box(f"{name}_{tag}", b0, b1, fixed0, fixed1, c0, c1, material, collection))
        else:
            parts.append(box(f"{name}_{tag}", fixed0, fixed1, b0, b1, c0, c1, material, collection))

    piece("a", a0, op_a0, z0, z1)
    piece("b", op_a1, a1, z0, z1)
    piece("below", op_a0, op_a1, z0, op_z0)
    piece("above", op_a0, op_a1, op_z1, z1)
    return parts


T = 0.2  # wall thickness

# ---- vestibule ----
C = "vestibule"
box("vest_floor", -2.2, 2.2, -3.2, 2.2, -0.2, 0, "concrete", C)
box("vest_ceiling", -2.2, 2.2, -3.2, 2.2, 3.0, 3.2, "plaster", C)
box("vest_wall_w", -2.2, -2.0, -3.2, 2.2, 0, 3.0, "concrete", C)
box("vest_wall_e", 2.0, 2.2, -3.2, 2.2, 0, 3.0, "concrete", C)
box("vest_wall_s", -2.0, 2.0, -3.2, -3.0, 0, 3.0, "concrete", C)
wall_with_opening("vest_wall_n", "x", 2.0, 2.2, -2.0, 2.0, 0, 3.0, -0.6, 0.6, 0, 2.2, "concrete", C)
box("vest_bench", -1.95, -1.55, -2.2, -0.4, 0, 0.45, "wood", C)
cylinder("vest_lamp", 0, -0.5, 2.85, 3.0, 0.22, "metal", C)

# ---- corridor (with a window west into the pendulum room) ----
C = "corridor"
box("corr_floor", -1.2, 1.2, 2.2, 14.0, -0.2, 0, "concrete", C)
box("corr_ceiling", -1.2, 1.2, 2.2, 14.0, 2.6, 2.8, "plaster", C)
wall_with_opening("corr_wall_w", "y", -1.2, -1.0, 2.2, 14.0, 0, 2.6, 6.0, 8.0, 1.0, 2.0, "concrete", C)
box("corr_wall_e", 1.0, 1.2, 2.2, 14.0, 0, 2.6, "concrete", C)
for i, y in enumerate(range(4, 14, 2)):
    box(f"corr_beam_{i}", -1.0, 1.0, y - 0.08, y + 0.08, 2.42, 2.6, "metal", C)
# A sealed door on the east wall.
box("corr_door", 0.94, 1.0, 10.45, 11.45, 0, 2.1, "metal", C)
box("corr_door_frame_l", 0.9, 1.0, 10.33, 10.45, 0, 2.22, "metal", C)
box("corr_door_frame_r", 0.9, 1.0, 11.45, 11.57, 0, 2.22, "metal", C)
box("corr_door_frame_t", 0.9, 1.0, 10.33, 11.57, 2.1, 2.22, "metal", C)
box("corr_window_sill", -1.25, -0.95, 6.0, 8.0, 0.96, 1.0, "metal", C)

C = "pendulum_room"
box("pend_floor", -6.2, -1.2, 4.8, 9.2, -0.2, 0, "concrete", C)
box("pend_ceiling", -6.2, -1.2, 4.8, 9.2, 4.0, 4.2, "plaster", C)
box("pend_wall_w", -6.2, -6.0, 4.8, 9.2, 0, 4.0, "concrete", C)
box("pend_wall_s", -6.0, -1.2, 4.8, 5.0, 0, 4.0, "concrete", C)
box("pend_wall_n", -6.0, -1.2, 9.0, 9.2, 0, 4.0, "concrete", C)
# The corridor's wall stops at 2.6 m; close the room above it.
box("pend_wall_e_top", -1.2, -1.0, 4.8, 9.2, 2.6, 4.0, "concrete", C)
box("pend_wall_e_s", -1.2, -1.0, 4.8, 6.0, 0, 2.6, "concrete", C)

# ---- hall ----
C = "hall"
box("hall_floor", -10.2, 10.2, 14.2, 34.2, -0.2, 0, "tile", C)
box("hall_ceiling", -10.2, 10.2, 14.0, 34.2, 8.0, 8.2, "plaster", C)
wall_with_opening("hall_wall_s", "x", 14.0, 14.2, -10.2, 10.2, 0, 8.0, -1.0, 1.0, 0, 2.6, "concrete", C)
box("hall_wall_n", -10.2, 10.2, 34.0, 34.2, 0, 8.0, "concrete", C)
box("hall_wall_e", 10.0, 10.2, 14.2, 34.0, 0, 8.0, "concrete", C)
wall_with_opening("hall_wall_w", "y", -10.2, -10.0, 14.2, 34.0, 0, 8.0, 22.0, 26.0, 0, 4.0, "concrete", C)
for side in (-5, 5):
    for y in (18, 22, 26, 30):
        cylinder(f"hall_column_{'w' if side < 0 else 'e'}{y}", side, y, 0, 8.0, 0.35, "concrete", C, segments=24)

# Stairs up the east wall (16 steps of 25 cm) to the mezzanine at 4 m.
for i in range(16):
    box(f"hall_step_{i:02d}", 8.6, 10.0, 18 + i * 0.75, 18 + (i + 1) * 0.75, 0, (i + 1) * 0.25, "concrete", C)
box("mezz_slab", -10.0, 10.0, 30.0, 34.0, 3.8, 4.0, "concrete", C)
# Railing along the mezzanine edge, open where the stairs arrive.
x = -9.8
k = 0
while x < 8.4:
    box(f"mezz_post_{k:02d}", x - 0.03, x + 0.03, 30.0, 30.06, 4.0, 5.0, "metal", C)
    x += 1.0
    k += 1
box("mezz_rail_top", -10.0, 8.45, 29.98, 30.08, 4.98, 5.04, "metal", C)
box("mezz_rail_mid", -10.0, 8.45, 30.0, 30.06, 4.5, 4.54, "metal", C)
# Stair railing on the open (west) side.
for i in range(0, 16, 3):
    y = 18 + (i + 0.5) * 0.75
    box(f"stair_post_{i:02d}", 8.6, 8.66, y - 0.03, y + 0.03, (i + 1) * 0.25, (i + 1) * 0.25 + 1.0, "metal", C)

box("hall_bench_w", -7.8, -7.3, 20.5, 23.5, 0, 0.45, "wood", C)
box("hall_bench_e", 7.0, 7.5, 24.5, 27.5, 0, 0.45, "wood", C)

# The turning monolith on its pedestal, behind a ring railing.
cylinder("hall_pedestal", 0, 24, 0, 0.4, 1.2, "stone", C, segments=32)
R = 2.2
N = 18
for i in range(N):
    a = i / N * math.tau
    cylinder(f"ring_post_{i:02d}", R * math.cos(a), 24 + R * math.sin(a), 0, 1.0, 0.025, "metal", C, segments=8)
for level, z in (("top", 0.97), ("mid", 0.5)):
    for i in range(N):
        a0 = i / N * math.tau
        a1 = (i + 1) / N * math.tau
        p0 = Vector((R * math.cos(a0), 24 + R * math.sin(a0)))
        p1 = Vector((R * math.cos(a1), 24 + R * math.sin(a1)))
        mid = (p0 + p1) / 2
        length = (p1 - p0).length
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=(length, 0.04, 0.04), verts=bm.verts)
        seg = mesh_object(f"ring_rail_{level}_{i:02d}", bm, "metal", C, (mid.x, mid.y, z))
        seg.rotation_euler = Euler((0, 0, math.atan2(p1.y - p0.y, p1.x - p0.x)))

# ---- terrace and the expanse below ----
C = "terrace"
box("terrace_block", -22.0, -10.2, 18.0, 30.0, -5.0, 0, "stone", C)
box("terrace_parapet_w", -22.0, -21.7, 18.0, 30.0, 0, 1.0, "stone", C)
box("terrace_parapet_s", -21.7, -10.2, 18.0, 18.3, 0, 1.0, "stone", C)
box("terrace_parapet_n", -21.7, -10.2, 29.7, 30.0, 0, 1.0, "stone", C)

C = "outside"
box("expanse", -100.0, -10.0, -40.0, 90.0, -5.2, -5.0, "stone", C)
box("tower", -62.0, -58.0, 28.0, 32.0, -5.0, 25.0, "concrete", C)
for i, (x, y) in enumerate(((-40.0, 60.0), (-75.0, 5.0), (-35.0, -10.0))):
    box(f"standing_stone_{i}", x - 0.5, x + 0.5, y - 1.25, y + 1.25, -5.0, 1.0, "stone", C)

# ---- entities: moving things, animated here, whose dots fade ----
C = "entities"


def fcurves_of(obj):
    """The object's F-curves (Blender 4.4+ keeps them in the action's layered channelbags)."""
    action = obj.animation_data.action
    if hasattr(action, "layers") and action.layers:
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    yield from bag.fcurves
    else:
        yield from action.fcurves


def keys(obj, path, frames_values, interpolation):
    for frame, value in frames_values:
        setattr(obj, path, value)
        obj.keyframe_insert(data_path=path, frame=frame)
    for fc in fcurves_of(obj):
        if fc.data_path == path:
            for kp in fc.keyframe_points:
                kp.interpolation = interpolation


# The monolith turns once every 24 s (linear, so the loop is seamless).
bm = bmesh.new()
bmesh.ops.create_cube(bm, size=1.0)
bmesh.ops.scale(bm, vec=(1.2, 0.3, 3.2), verts=bm.verts)
bmesh.ops.translate(bm, vec=(0, 0, 1.6), verts=bm.verts)
mono = mesh_object("ENT_monolith", bm, "entity", C, (0, 24, 0.4))
keys(mono, "rotation_euler", [(1, Euler((0, 0, 0))), (1 + 24 * 30, Euler((0, 0, math.tau)))], "LINEAR")

# The pendulum swings north-south across the corridor window, 7 s per swing and back.
bm = bmesh.new()
bmesh.ops.create_cube(bm, size=1.0)
bmesh.ops.scale(bm, vec=(0.04, 0.04, 2.8), verts=bm.verts)
bmesh.ops.translate(bm, vec=(0, 0, -1.4), verts=bm.verts)
bob = bmesh.new()
bmesh.ops.create_uvsphere(bob, u_segments=16, v_segments=10, radius=0.3)
bmesh.ops.translate(bob, vec=(0, 0, -3.0), verts=bob.verts)
tmp = bpy.data.meshes.new("tmp_bob")
bob.to_mesh(tmp)
bob.free()
bm.from_mesh(tmp)
bpy.data.meshes.remove(tmp)
pend = mesh_object("ENT_pendulum", bm, "entity", C, (-3.6, 7.0, 3.95))
swing = math.radians(32)
keys(pend, "rotation_euler", [(1, Euler((swing, 0, 0))), (1 + 105, Euler((-swing, 0, 0))), (1 + 210, Euler((swing, 0, 0)))], "BEZIER")

# Out on the expanse, a tall shape drifts north and back over 80 s.
bm = bmesh.new()
bmesh.ops.create_cube(bm, size=1.0)
bmesh.ops.scale(bm, vec=(0.8, 0.8, 4.0), verts=bm.verts)
bmesh.ops.translate(bm, vec=(0, 0, 2.0), verts=bm.verts)
drift = mesh_object("ENT_drifter", bm, "entity", C, (-45.0, 20.0, -5.0))
keys(drift, "location", [(1, Vector((-45.0, 20.0, -5.0))), (1 + 40 * 30, Vector((-45.0, 50.0, -5.0))), (1 + 80 * 30, Vector((-45.0, 20.0, -5.0)))], "BEZIER")

scene.frame_start = 1
scene.frame_end = 1 + 80 * 30

# ---- markers ----
spawn = bpy.data.objects.new("SPAWN", None)
spawn.empty_display_type = "SINGLE_ARROW"
spawn.empty_display_size = 0.6
spawn.location = (0, -1.6, 0)
# An empty's arrow points along its local Z; the game faces the player along the empty's
# local +Y (north here). The rotation stays identity.
link(spawn, "markers")

os.makedirs(os.path.dirname(out_path), exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=out_path)
count = sum(1 for o in bpy.data.objects if o.type == "MESH")
tris = 0
for o in bpy.data.objects:
    if o.type == "MESH":
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles)
print(f"[build_hall] wrote {out_path}: {count} meshes, {tris} triangles")
