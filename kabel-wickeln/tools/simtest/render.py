#!/usr/bin/env python3
"""Render rodsim snapshot JSON to a PNG grid: rows = views, cols = snapshots.

JSON: {title, radius, visScale, views:[{name, target:[x,y,z], dist, yaw, pitch, fov}],
       snapshots:[{t, label, pos:[...3n], d1:[...3n], caps:[{a,b,r}], grips:[i...]}]}
Depth-sorted thick lines, Lambert-ish shading, a red stripe drawn where the
material d1 direction faces the camera (shows twist), floor grid at y=0.
"""
import json, math, sys
from PIL import Image, ImageDraw, ImageFont

def norm(v):
    l = math.sqrt(sum(a * a for a in v)) or 1.0
    return [a / l for a in v]

def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

def dot(a, b):
    return sum(x * y for x, y in zip(a, b))

class Cam:
    def __init__(self, v, W, H):
        yaw, pitch = math.radians(v.get('yaw', 30)), math.radians(v.get('pitch', 25))
        d = v.get('dist', 3)
        t = v['target']
        fwd = [-math.cos(pitch) * math.sin(yaw), -math.sin(pitch), -math.cos(pitch) * math.cos(yaw)]
        self.eye = [t[0] - fwd[0] * d, t[1] - fwd[1] * d, t[2] - fwd[2] * d]
        self.f = norm(fwd)
        up = [0, 1, 0] if abs(self.f[1]) < 0.99 else [0, 0, -1]
        self.r = norm(cross(self.f, up))
        self.u = cross(self.r, self.f)
        self.W, self.H = W, H
        self.foc = (H / 2) / math.tan(math.radians(v.get('fov', 40)) / 2)

    def proj(self, p):
        d = [p[0] - self.eye[0], p[1] - self.eye[1], p[2] - self.eye[2]]
        z = dot(d, self.f)
        if z < 1e-3:
            return None
        return (self.W / 2 + dot(d, self.r) * self.foc / z, self.H / 2 - dot(d, self.u) * self.foc / z, z)

def render_view(img, ox, oy, W, H, view, snap, radius, vis):
    cam = Cam(view, W, H)
    dr = ImageDraw.Draw(img)
    dr.rectangle([ox, oy, ox + W - 1, oy + H - 1], fill=(244, 242, 236))
    # floor grid
    g = view.get('grid', 0.25); ext = view.get('gridExtent', 3)
    t = view['target']
    k0 = int(-ext / g)
    for k in range(k0, -k0 + 1):
        for a, b in (([t[0] + k * g, 0, t[2] - ext], [t[0] + k * g, 0, t[2] + ext]), ([t[0] - ext, 0, t[2] + k * g], [t[0] + ext, 0, t[2] + k * g])):
            # clip in steps
            pts = []
            for s in range(41):
                u = s / 40
                p = cam.proj([a[0] + (b[0] - a[0]) * u, 0, a[2] + (b[2] - a[2]) * u])
                if p: pts.append((ox + p[0], oy + p[1]))
            if len(pts) > 1:
                dr.line(pts, fill=(222, 218, 208), width=1)
    pos = snap['pos']; d1 = snap.get('d1'); n = len(pos) // 3
    P = [pos[3 * i:3 * i + 3] for i in range(n)]
    items = []
    light = norm([0.4, 1.0, 0.3])
    grips = set(snap.get('grips', []))
    # shadows on floor
    for i in range(n - 1):
        a = cam.proj([P[i][0], 0, P[i][2]]); b = cam.proj([P[i + 1][0], 0, P[i + 1][2]])
        if a and b:
            w = max(1, radius * vis * cam.foc / a[2] * 2)
            h = max(P[i][1], 0)
            c = int(min(236, 200 + h * 60))
            dr.line([(ox + a[0], oy + a[1]), (ox + b[0], oy + b[1])], fill=(c, c - 3, c - 10), width=int(w))
    for i in range(n - 1):
        a = cam.proj(P[i]); b = cam.proj(P[i + 1])
        if not a or not b:
            continue
        z = (a[2] + b[2]) / 2
        tdir = norm([P[i + 1][k] - P[i][k] for k in range(3)])
        items.append((z, i, a, b, tdir))
    # capsules
    for c in snap.get('caps', []):
        a = cam.proj(c['a']); b = cam.proj(c['b'])
        if a and b:
            items.append(((a[2] + b[2]) / 2 + 1e-4, -1, a, b, c['r']))
    items.sort(key=lambda it: -it[0])
    n_total = n - 1
    for z, i, a, b, extra in items:
        if i < 0:
            w = max(2, extra * cam.foc / z * 2)
            dr.line([(ox + a[0], oy + a[1]), (ox + b[0], oy + b[1])], fill=(205, 160, 130), width=int(w))
            for p in (a, b):
                dr.ellipse([ox + p[0] - w / 2, oy + p[1] - w / 2, ox + p[0] + w / 2, oy + p[1] + w / 2], fill=(205, 160, 130))
            continue
        w = max(2.0, radius * vis * cam.foc / z * 2)
        # shade: depth + crude light from tangent (cylinder max brightness)
        tl = dot(extra, light)
        br = math.sqrt(max(0.0, 1 - tl * tl))
        depthf = max(0.0, min(1.0, (z - view.get('dist', 3) + 1.5) / 3))
        base = 30 + 120 * br * (1 - 0.5 * depthf)
        hue = i / n_total
        col = (int(base * (0.65 + 0.35 * hue)), int(base * 0.8 + 20), int(base * (1.0 - 0.3 * hue) + 30))
        if i in grips:
            col = (200, 120, 20)
        dr.line([(ox + a[0], oy + a[1]), (ox + b[0], oy + b[1])], fill=col, width=int(round(w)))
        dr.ellipse([ox + b[0] - w / 2, oy + b[1] - w / 2, ox + b[0] + w / 2, oy + b[1] + w / 2], fill=col)
        if d1 is not None:
            # stripe: offset towards d1 if d1 faces the camera
            m = [(P[i][k] + P[i + 1][k]) / 2 for k in range(3)]
            dd = [(d1[3 * i + k] + d1[3 * i + 3 + k]) / 2 for k in range(3)]
            tocam = norm([cam.eye[k] - m[k] for k in range(3)])
            f = dot(norm(dd), tocam)
            if f > 0.0:
                off = radius * vis * 0.75
                sa = cam.proj([P[i][k] + d1[3 * i + k] * off for k in range(3)])
                sb = cam.proj([P[i + 1][k] + d1[3 * i + 3 + k] * off for k in range(3)])
                if sa and sb:
                    dr.line([(ox + sa[0], oy + sa[1]), (ox + sb[0], oy + sb[1])], fill=(225, 40, 40), width=max(1, int(w * 0.3)))
    dr.text((ox + 6, oy + 4), f"{view.get('name','')}  t={snap['t']:.2f}s  {snap.get('label','')}", fill=(40, 40, 40))

def main(src, dst, W=420, H=320):
    d = json.load(open(src))
    views, snaps = d['views'], d['snapshots']
    W = d.get('W', W); H = d.get('H', H)
    img = Image.new('RGB', (W * len(snaps), H * len(views) + 22), (255, 255, 255))
    for r, v in enumerate(views):
        for c, s in enumerate(snaps):
            render_view(img, c * W, 22 + r * H, W, H, v, s, d.get('radius', 0.004), d.get('visScale', 2.5))
    ImageDraw.Draw(img).text((6, 5), d.get('title', ''), fill=(0, 0, 0))
    img.save(dst)

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
