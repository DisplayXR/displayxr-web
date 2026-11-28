# Block-matching disparity between the two halves of a side-by-side PNG (left eye = left half).
# Prints, in EYE pixels: the disparity spread over textured blocks, per horizontal band (top -> bottom),
# the vertical disparity (best dy per block, searched +-VS), and the seam check (the columns next to the
# halves' inner edges: an unfilled seam is a run of uniform columns there). Writes an anaglyph.
#   d > 0: the right eye's copy sits further RIGHT = uncrossed = behind the glass;
#   d < 0: crossed = in front of the glass.
# Usage: python disparity.py <sbs.png> [y0 y1] [--x0 X]   (--x0: ignore eye columns < X, e.g. a sidebar)
import sys
import numpy as np
from PIL import Image

args = [a for a in sys.argv[1:] if not a.startswith('--')]
x0 = 0
if '--x0' in sys.argv:
    x0 = int(sys.argv[sys.argv.index('--x0') + 1])
    args = [a for a in args if a != str(x0)]
path = args[0]
im = np.asarray(Image.open(path).convert('L'), dtype=np.float32)
H, W = im.shape
w = W // 2
y0, y1 = (int(args[1]), int(args[2])) if len(args) > 2 else (0, H)
L, R = im[:, :w], im[:, w:2 * w]
B, S, VS = 24, 48, 4
out = []
for y in range(max(y0, VS), min(y1, H) - B - VS, B):
    for x in range(max(S, x0), w - B - S, B):
        blk = L[y:y + B, x:x + B]
        if blk.std() < 12:
            continue
        best, bd, bdy = 1e18, 0, 0
        for dy in range(-VS, VS + 1):
            for d in range(-S, S + 1):
                c = R[y + dy:y + dy + B, x + d:x + d + B]
                e = ((c - blk) ** 2).mean()
                if e < best:
                    best, bd, bdy = e, d, dy
        if best < 0.25 * blk.var():
            out.append((x, y, bd, bdy))
if not out:
    print(f'{path}: no textured blocks matched')
    sys.exit(0)
a = np.array(out)
d, dy = a[:, 2], a[:, 3]
print(f'{path}: blocks={len(out)} disparity px (eye): min={d.min()} p5={np.percentile(d,5):.0f} median={np.median(d):.0f} p95={np.percentile(d,95):.0f} max={d.max()} | vertical: |dy|>0 in {np.mean(dy != 0)*100:.1f}% of blocks, median {np.median(dy):.0f}')
for i in range(4):
    ya, yb = y0 + (y1 - y0) * i // 4, y0 + (y1 - y0) * (i + 1) // 4
    m = (a[:, 1] >= ya) & (a[:, 1] < yb)
    if m.sum():
        print(f'  band y {ya:4d}-{yb:4d}: n={m.sum():3d} median d={np.median(d[m]):+.0f} (p10 {np.percentile(d[m],10):+.0f}, p90 {np.percentile(d[m],90):+.0f})')
# seam: per-column std of the 12 columns on each side of the halves' inner edges
col = lambda img, c: img[:, c].std()
inner = [col(L, c) for c in range(w - 12, w)] + [col(R, c) for c in range(0, 12)]
print(f'  inner-edge columns (left half last 12, right half first 12) std: min {min(inner):.1f} mean {np.mean(inner):.1f}  (a seam reads ~0)')
rgb = np.asarray(Image.open(path).convert('RGB'))
an = np.zeros((rgb.shape[0], w, 3), np.uint8)
an[..., 0] = rgb[:, :w, 0]
an[..., 1] = rgb[:, w:2 * w, 1]
an[..., 2] = rgb[:, w:2 * w, 2]
Image.fromarray(an).save(path.replace('.png', '-anaglyph.png'))
