// Draws many points fast: a software z-buffer at screen resolution, every point a small square,
// the nearest point wins. The result is one canvas that the stage draws (plus a blurred copy for glow).

export class Splatter {
  w = 0;
  h = 0;
  canvas = document.createElement('canvas');
  private g = this.canvas.getContext('2d') as CanvasRenderingContext2D;
  private img: ImageData | null = null;
  private px: Uint32Array = new Uint32Array(0);
  private z: Float32Array = new Float32Array(0);
  count = 0;

  begin(w: number, h: number) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (w !== this.w || h !== this.h || !this.img) {
      this.w = w;
      this.h = h;
      this.canvas.width = w;
      this.canvas.height = h;
      this.img = this.g.createImageData(w, h);
      this.px = new Uint32Array(this.img.data.buffer);
      this.z = new Float32Array(w * h);
    }
    this.px.fill(0);
    this.z.fill(Infinity);
    this.count = 0;
  }

  /** x, y: canvas px from the top left; size: square side in px; r, g, b, a: 0..1 */
  point(x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number) {
    if (a <= 0.004) return;
    const s = Math.max(1, Math.round(size));
    const x0 = Math.round(x - s / 2);
    const y0 = Math.round(y - s / 2);
    if (x0 >= this.w || y0 >= this.h || x0 + s <= 0 || y0 + s <= 0) return;
    const color =
      ((Math.min(255, a * 255) & 255) << 24) |
      ((Math.min(255, b * 255) & 255) << 16) |
      ((Math.min(255, g * 255) & 255) << 8) |
      (Math.min(255, r * 255) & 255);
    const xa = Math.max(0, x0);
    const xb = Math.min(this.w, x0 + s);
    const ya = Math.max(0, y0);
    const yb = Math.min(this.h, y0 + s);
    for (let yy = ya; yy < yb; yy++) {
      let i = yy * this.w + xa;
      for (let xx = xa; xx < xb; xx++, i++) {
        if (z < this.z[i]) {
          this.z[i] = z;
          this.px[i] = color;
        }
      }
    }
    this.count++;
  }

  end() {
    if (this.img) this.g.putImageData(this.img, 0, 0);
    return this.canvas;
  }
}
