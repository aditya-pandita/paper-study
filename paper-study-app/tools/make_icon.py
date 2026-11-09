"""Draws the Paper Study icon (a page with an attention-style link motif) as a PNG.
Usage: python3 tools/make_icon.py <out.png> [size]"""
import sys
from PIL import Image, ImageDraw

out = sys.argv[1]
S = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
k = S / 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# rounded-square background (teal), inset like macOS icons
d.rounded_rectangle([100 * k, 100 * k, 924 * k, 924 * k], radius=190 * k, fill=(15, 110, 86, 255))
# paper sheet
d.rounded_rectangle([270 * k, 200 * k, 754 * k, 824 * k], radius=36 * k, fill=(250, 249, 245, 255))
# text lines
for i, w in enumerate([380, 300, 340]):
    y = (270 + i * 56) * k
    d.rounded_rectangle([322 * k, y, (322 + w) * k, y + 22 * k], radius=11 * k, fill=(196, 192, 182, 255))
# attention links: three dots on a row, one query dot below, curved links
pts = [(350, 640), (512, 640), (674, 640)]
q = (512, 760)
for (x, y) in pts:
    d.line([q[0] * k, q[1] * k, x * k, y * k], fill=(133, 79, 11, 255), width=int(18 * k))
for (x, y) in pts:
    d.ellipse([(x - 40) * k, (y - 40) * k, (x + 40) * k, (y + 40) * k], fill=(24, 95, 165, 255))
d.ellipse([(q[0] - 46) * k, (q[1] - 46) * k, (q[0] + 46) * k, (q[1] + 46) * k], fill=(133, 79, 11, 255))
img.save(out)
