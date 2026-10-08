// The mirror world, from the shared LED wall core (ctx.wall, see ../../WALL.md): a point of a person
// goes through the wall mapping (mirrored, the walk stretched over the whole wall, the person's
// shift) onto the wall, then behind it (ctx.wall.mirror: x from the wall center, y up,
// z = -distance from the wall) and `pull` m closer.
//
// The camera looks from the eye through the wall rectangle (offAxisProjection), so far things get
// small, as in a mirror. `real` (0..1) moves the picture of the people towards where the wall setup
// puts them, like every other wall scene and the calibration test image: real size, at their mapped
// place. Their points slide along the eye's rays for it, so the depth stays: they still stand in
// front of and behind things of the world, and the world keeps its parallax around them.

export class MirrorMap {
  constructor() {
    this.wall = null;
    this.eye = [0, 1.1, 3]; // x from the wall center, height, distance in front of the wall (m)
    this.pull = 0;
    this.real = 1;
    this.room = [0, 0, 0]; // room point of the last fromCamera()
    this._cam = new Float32Array(12); // camera frame (m) -> room, three rows of x y z 1
    this._w = [0, 0, 0];
  }

  /** Once per frame: ctx.wall, the eye [x, y, distance] the people are placed for, pull (m), real 0..1. */
  update(wall, eye, pull, real) {
    this.wall = wall;
    this.eye[0] = eye[0];
    this.eye[1] = eye[1];
    this.eye[2] = Math.max(0.1, eye[2]);
    this.pull = pull;
    this.real = Math.min(1, Math.max(0, real));
    // camera (x right, y down, z forward) -> world (xSign x, -y, z) -> room
    const m = wall.room.matrix;
    const c = this._cam;
    for (let i = 0; i < 3; i++) {
      c[4 * i] = m[i] * wall.xSign;
      c[4 * i + 1] = -m[4 + i];
      c[4 * i + 2] = m[8 + i];
      c[4 * i + 3] = m[12 + i];
    }
  }

  /** How much bigger than on the wall a placed thing is in the world, at mirror depth Z. */
  scale(Z) {
    const D = this.eye[2];
    return 1 - (this.real * Math.min(Z, 0.9 * D)) / D;
  }

  /** wall point (m) -> mirror world, placed (in place allowed) */
  fromWall(w, out = [0, 0, 0]) {
    this.wall.mirror(w, out);
    out[2] += this.pull;
    // along the eye's ray: the picture on the wall goes from the mirror's perspective to the mapping
    const s = this.scale(out[2]);
    out[0] = this.eye[0] + (out[0] - this.eye[0]) * s;
    out[1] = this.eye[1] + (out[1] - this.eye[1]) * s;
    return out;
  }

  /** world point (m, as ctx.persons) of person `slot` -> mirror world */
  fromWorld(world, slot, out = [0, 0, 0]) {
    return this.fromWall(this.wall.fromWorld(world, slot, out), out);
  }

  /** Kinect camera point (m) of person `slot` -> mirror world; this.room is its room point */
  fromCamera(x, y, z, slot, out = [0, 0, 0]) {
    const c = this._cam;
    const r = this.room;
    r[0] = c[0] * x + c[1] * y + c[2] * z + c[3];
    r[1] = c[4] * x + c[5] * y + c[6] * z + c[7];
    r[2] = c[8] * x + c[9] * y + c[10] * z + c[11];
    return this.fromWall(this.wall.fromRoom(r, slot, out), out);
  }

  /** m from the wall of a point at mirror depth Z (the people's colors go by it) */
  distance(Z) {
    return this.pull - Z;
  }

  /** world velocity (m/s) of a world point of person `slot` -> mirror world (stretched walk included) */
  velocity(world, vel, slot, out = [0, 0, 0]) {
    const Z = this.pull - this.wall.fromWorld(world, slot, this._w)[2];
    this.wall.velocity(world, vel, slot, out);
    const s = this.scale(Z);
    out[0] *= s;
    out[1] *= s;
    out[2] = -out[2];
    return out;
  }

  /**
   * A point on the floor of the mirror world (y = 0) that is seen where the world point (the feet,
   * person.ground) is seen: for ripples and quakes around the feet. Always behind the wall.
   */
  floor(world, slot, out = [0, 0, 0]) {
    const p = this.fromWorld(world, slot, out);
    const [ex, ey, D] = this.eye;
    const tMin = (D + 0.05) / Math.max(1e-3, D - p[2]); // the floor starts behind the wall
    const t = p[1] < ey - 1e-3 ? Math.max(tMin, ey / (ey - p[1])) : tMin;
    out[0] = ex + (p[0] - ex) * t;
    out[1] = 0;
    out[2] = D - (D - p[2]) * t;
    return out;
  }
}
