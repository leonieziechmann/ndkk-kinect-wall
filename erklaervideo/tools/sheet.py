# Contact sheet of the stills (for a quick look): python3 tools/sheet.py output/stills out.jpg [cols]
import sys, os
from PIL import Image, ImageDraw
src, out = sys.argv[1], sys.argv[2]
cols = int(sys.argv[3]) if len(sys.argv) > 3 else 2
files = sorted(f for f in os.listdir(src) if f.endswith('.jpg'))
ims = [Image.open(os.path.join(src, f)) for f in files]
w, h = ims[0].size
rows = (len(ims) + cols - 1) // cols
sheet = Image.new('RGB', (cols * w, rows * h), (40, 40, 40))
d = ImageDraw.Draw(sheet)
for i, (f, im) in enumerate(zip(files, ims)):
    x, y = (i % cols) * w, (i // cols) * h
    sheet.paste(im, (x, y))
    d.text((x + 8, y + 6), f, fill=(255, 255, 0))
sheet.save(out, quality=88)
print(out, sheet.size)
