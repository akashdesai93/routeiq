# Review helper: put several PNGs side by side at a reduced size.
#   python tools/montage.py out.png scale a.png b.png c.png
import sys
from PIL import Image
out, scale, files = sys.argv[1], float(sys.argv[2]), sys.argv[3:]
ims = [Image.open(f).convert('RGB') for f in files]
ims = [im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS) for im in ims]
sheet = Image.new('RGB', (sum(im.width for im in ims), max(im.height for im in ims)), 'white')
x = 0
for im in ims:
    sheet.paste(im, (x, 0)); x += im.width
sheet.save(out)
