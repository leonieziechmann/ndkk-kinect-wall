// The people on the wall as a grid of cells in meters: every person pixel is put into the room and
// mapped onto the wall by the scene's projection (ctx.wall: mirror, the play field stretched over the
// wall, each person's place and body size; see WALL.md). A person covers as much wall as they are wide, at the place the
// mapping gives them, whether near the sensor or far.
//
// Per cell: the slot of the front-most person (0 = nobody), whether it was covered in this frame for
// the first time (an edge of a body moved in) and a fading "activity" for the picture (moving edges
// glow). "First time" is measured in real meters: the stretched walk moves a person's silhouette
// faster than the person (their offset on the wall changes as they walk), and that part is taken out.
// Each person's offset (wall x = offset + mirrorSign·planX·scale) is snapped to whole cells, so this
// comparison is exact. Someone held at the wall's edge keeps their exact offset: their silhouette
// stands still there while they walk on, and that is what counts for them.

export const CELL = 0.015; // m: 400 x 133 cells on a 6 x 2 m wall, finer than the depth pixels at 2-4 m
const EMPTY_MM = 0xffff;
const SLOTS = 17;
// how a slot's pixels are placed: stretched like points (no shift), shifted as a whole, held at the edge
const STRETCHED = 0;
const SNAPPED = 1;
const HELD = 2;

export class WallGrid {
  constructor(wallW, wallH) {
    this.w = Math.max(8, Math.round(wallW / CELL));
    this.h = Math.max(8, Math.round(wallH / CELL));
    const n = this.w * this.h;
    this.front = new Uint16Array(n); // mm of the front-most person point
    this.slot = new Uint8Array(n);
    this.prev = new Uint8Array(n); // slot of the last update
    this.isFresh = new Uint8Array(n); // covered now, not covered before (compensated, see above)
    this.act = new Float32Array(n);
    this.tmp = new Uint8Array(n);
    this.tex = new Uint8Array(n * 4); // rgba8: covered, slot, activity, fresh
    this.covered = 0; // cells covered in the last update
    this.fresh = 0;
    this.votes = new Uint16Array(SLOTS);
    // per slot: how it is placed (STRETCHED, SNAPPED, HELD), its offset in whole cells (SNAPPED) or m
    // (HELD), the person's id; the same of the last update; the cells the offset moved by since then
    this.mode = new Uint8Array(SLOTS);
    this.shiftCells = new Int32Array(SLOTS);
    this.shiftM = new Float64Array(SLOTS);
    this.ids = new Float64Array(SLOTS);
    this.prevMode = new Uint8Array(SLOTS);
    this.prevShift = new Int32Array(SLOTS);
    this.prevIds = new Float64Array(SLOTS);
    this.moved = new Int32Array(SLOTS);
  }

  /**
   * Rebuilds the grid from one person tracking result (ctx.kinect.persons) with the mapping of the
   * wall core (ctx.wall, updated for the same result).
   */
  update(persons, rays, xSign, wall) {
    const { w, h, front, slot, tmp } = this;
    const S = wall.setup;
    const P = wall.projection;
    const m = wall.room.matrix;
    const perPerson = P.apply === 'person';
    const planX0 = wall.planX0; // plan x of the sensor
    const ms = wall.mirrorSign;
    const top = S.bottom + S.size.h;
    const { near, far } = wall.zone; // room z (m from the sensor)
    const inv = 1 / CELL;

    // the persons' offsets as wall.fromRoom(r, slot) applies them: snapped to cells, exact when held
    const { mode, shiftCells, shiftM, ids, moved } = this;
    mode.fill(STRETCHED);
    ids.fill(0);
    const lo = Math.min(P.margin, S.size.w / 2) + 1e-6;
    const hi = S.size.w - P.margin - 1e-6;
    for (const q of wall.persons) {
      const s = q.slot;
      if (!(s >= 1 && s < SLOTS)) continue;
      ids[s] = q.id;
      if (!perPerson || !wall.visible[s]) continue;
      mode[s] = P.edge === 'clamp' && (q.x <= lo || q.x >= hi) ? HELD : SNAPPED;
      shiftCells[s] = Math.round(wall.offset[s] * inv);
      shiftM[s] = wall.offset[s];
    }
    // how many cells each silhouette was moved by the change of its shift: not the person's motion
    for (let s = 1; s < SLOTS; s++) {
      const same = mode[s] === SNAPPED && this.prevMode[s] === SNAPPED && ids[s] === this.prevIds[s];
      moved[s] = same ? shiftCells[s] - this.prevShift[s] : 0;
    }

    front.fill(EMPTY_MM);
    slot.fill(0);
    const { indices, labels, depth } = persons;
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      const mm = depth[i];
      if (mm < 100) continue;
      const z = mm * 0.001;
      const wx = xSign * rays[2 * i] * z;
      const wy = -rays[2 * i + 1] * z;
      const rz = m[2] * wx + m[6] * wy + m[10] * z + m[14];
      if (rz < near || rz > far) continue;
      const rx = m[0] * wx + m[4] * wy + m[8] * z + m[12];
      const ry = m[1] * wx + m[5] * wy + m[9] * z + m[13];
      const s = labels[i];
      const how = mode[s];
      // wall.roomX(): the body around the person's place (offset + mirrorSign·planX·scale), or every
      // point through the projection
      const body = ms * (planX0 + xSign * rx) * wall.scale[s];
      const gx = how === SNAPPED ? Math.floor(body * inv) + shiftCells[s] : how === HELD ? Math.floor((body + shiftM[s]) * inv) : Math.floor(wall.roomX(rx, rz, 0) * inv);
      const gy = Math.floor((top - wall.roomY(ry, s)) * inv);
      if (gx < 0 || gx >= w || gy < 0 || gy >= h) continue;
      const c = gy * w + gx;
      if (mm < front[c]) {
        front[c] = mm;
        slot[c] = s;
      }
    }

    // close single holes and drop single specks (8 neighbours: >= 6 covered fills, <= 1 clears)
    tmp.set(slot);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const c = y * w + x;
        let n = 0;
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const v = tmp[c + dy * w + dx];
            if ((dx || dy) && v) {
              n++;
              s = v;
            }
          }
        }
        if (!tmp[c] && n >= 6) slot[c] = s;
        else if (tmp[c] && n <= 1) slot[c] = 0;
      }
    }

    // compare with the last update where the same piece of body was then: `moved` cells to the side
    // for the person here now (or, where nobody is now, the one who was here)
    const { prev, isFresh, act, tex } = this;
    let covered = 0;
    let fresh = 0;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const c = row + x;
        const is = slot[c] !== 0;
        const xp = x - moved[is ? slot[c] : prev[c]];
        const was = xp >= 0 && xp < w && prev[row + xp] !== 0;
        const f = is && !was;
        isFresh[c] = f ? 1 : 0;
        act[c] = Math.max(act[c] * 0.82, was !== is ? 1 : 0);
        covered += is;
        fresh += f;
        const t = c * 4;
        tex[t] = is ? 255 : 0;
        tex[t + 1] = slot[c];
        tex[t + 2] = Math.round(act[c] * 255);
        tex[t + 3] = f ? 255 : 0;
      }
    }
    prev.set(slot);
    this.prevMode.set(mode);
    this.prevShift.set(shiftCells);
    this.prevIds.set(ids);
    this.covered = covered;
    this.fresh = fresh;
  }

  /** Clears everything (nobody there, or no data for a while). */
  clear() {
    this.slot.fill(0);
    this.prev.fill(0);
    this.isFresh.fill(0);
    this.act.fill(0);
    this.tex.fill(0);
    this.prevMode.fill(STRETCHED);
    this.covered = 0;
    this.fresh = 0;
  }

  /**
   * Contact of a circle (wall m: x from the left edge, y = height above the floor) with the people.
   * covered/fresh: m² of the circle covered by a person / newly covered in this frame;
   * edge: m of body outline inside the circle; fresh / edge is how far the outline moved in this
   * frame (a still body's outline flickers by single cells: thin, so it moves "slowly");
   * dx, dy: from the covered part to the center (m), slot: who moved into it (most fresh cells).
   */
  probe(x, y, r, top) {
    const { w, h, slot, isFresh } = this;
    const inv = 1 / CELL;
    const cx = x * inv;
    const cy = (top - y) * inv;
    const rc = r * inv;
    const x0 = Math.max(0, Math.floor(cx - rc));
    const x1 = Math.min(w - 1, Math.ceil(cx + rc));
    const y0 = Math.max(0, Math.floor(cy - rc));
    const y1 = Math.min(h - 1, Math.ceil(cy + rc));
    let cov = 0;
    let fresh = 0;
    let edge = 0;
    let sx = 0;
    let sy = 0;
    const votes = this.votes;
    votes.fill(0);
    for (let gy = y0; gy <= y1; gy++) {
      const ddy = gy + 0.5 - cy;
      for (let gx = x0; gx <= x1; gx++) {
        const ddx = gx + 0.5 - cx;
        if (ddx * ddx + ddy * ddy > rc * rc) continue;
        const c = gy * w + gx;
        const s = slot[c];
        if (!s) continue;
        cov++;
        if (gx === 0 || gx === w - 1 || gy === 0 || gy === h - 1 || !slot[c - 1] || !slot[c + 1] || !slot[c - w] || !slot[c + w]) edge++;
        sx += ddx;
        sy += ddy;
        if (isFresh[c]) {
          fresh++;
          votes[s]++;
        }
      }
    }
    let who = 0;
    for (let s = 1; s < SLOTS; s++) if (votes[s] > votes[who]) who = s;
    const area = CELL * CELL;
    // (sx, sy) points from the center to the covered part, in cells, y down
    return { covered: cov * area, fresh: fresh * area, edge: edge * CELL, dx: cov ? (-sx / cov) * CELL : 0, dy: cov ? (sy / cov) * CELL : 0, slot: who };
  }
}
