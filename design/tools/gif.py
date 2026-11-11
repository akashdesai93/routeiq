# Assemble numbered PNG frames into a looping GIF (Pillow only, no ffmpeg).
#   python tools/gif.py <frames-dir> <out.gif> <ms-per-frame> [width]
import sys, glob
from PIL import Image
src, out, ms = sys.argv[1], sys.argv[2], int(sys.argv[3])
width = int(sys.argv[4]) if len(sys.argv) > 4 else None
frames = []
for f in sorted(glob.glob(src + '/*.png')):
    im = Image.open(f).convert('RGB')
    if width and im.width != width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    frames.append(im)
# One palette for the whole loop, taken from a strip of sample frames, so colours never shimmer
step = max(1, len(frames) // 8)
sample = frames[::step]
strip = Image.new('RGB', (sample[0].width * len(sample), sample[0].height))
for i, im in enumerate(sample):
    strip.paste(im, (i * im.width, 0))
pal = strip.quantize(colors=255, method=Image.MEDIANCUT, dither=Image.NONE)
quant = [im.quantize(palette=pal, dither=Image.NONE) for im in frames]
quant[0].save(out, save_all=True, append_images=quant[1:], duration=ms, loop=0, optimize=False, disposal=1)
print(out, len(frames), 'frames')
