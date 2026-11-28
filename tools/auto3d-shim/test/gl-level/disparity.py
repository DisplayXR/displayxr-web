# Block-matching disparity between the two halves of a side-by-side PNG (left eye = left half).
# For each textured block of the left half, the best match in the right half over a 2-D search
# (dx in [-S, S], dy in [-V, V]); reports the horizontal disparity spread (right x - left x, eye px:
# > 0 = behind the convergence plane, < 0 = in front), the vertical disparity, and writes an anaglyph.
# Usage: python disparity.py <sbs.png> [--S 60] [--V 4] [--y0 N --y1 N] [--json]
import json
import sys
import numpy as np
from PIL import Image

args = sys.argv[1:]
path = args[0]
opt = lambda k, d: type(d)(args[args.index(k) + 1]) if k in args else d
S, V = opt('--S', 60), opt('--V', 4)
im = np.asarray(Image.open(path).convert('L'), dtype=np.float32)
lo, hi = np.percentile(im, 1), np.percentile(im, 99.5)
im = np.clip((im - lo) / max(1.0, hi - lo) * 255.0, 0, 255)  # contrast-stretched: dark viewers (a black backdrop) still match
H, W = im.shape
w = W // 2
y0, y1 = opt('--y0', 0), opt('--y1', H)
L, R = im[:, :w], im[:, w:2 * w]
B = max(12, w // 64)
out = []
for y in range(max(y0, V), min(y1, H - V) - B, B):
    for x in range(S, w - B - S, B):
        blk = L[y:y + B, x:x + B]
        if blk.std() < 8:
            continue
        E = np.full((2 * V + 1, 2 * S + 1), 1e18)
        for dy in range(-V, V + 1):
            for d in range(-S, S + 1):
                c = R[y + dy:y + dy + B, x + d:x + d + B]
                E[dy + V, d + S] = ((c - blk) ** 2).mean()
        iv, ix = np.unravel_index(np.argmin(E), E.shape)
        best, bd, bv = E[iv, ix], ix - S, iv - V
        # unique: nothing as good more than 2 px away (repeated texture, a flat gradient)
        far = E.copy(); far[max(0, iv - 2):iv + 3, max(0, ix - 2):ix + 3] = 1e18
        if best < 0.2 * blk.var() and abs(bd) < S and abs(bv) < V and best < 0.5 * far.min():
            out.append((x, y, bd, bv))
res = {'file': path, 'eye': [w, H], 'blocks': len(out), 'block': B}
if out:
    d = np.array([o[2] for o in out]); v = np.array([o[3] for o in out])
    res.update({'dx': {'min': int(d.min()), 'p10': float(np.percentile(d, 10)), 'median': float(np.median(d)), 'p90': float(np.percentile(d, 90)), 'max': int(d.max())},
                'dy': {'min': int(v.min()), 'max': int(v.max()), 'median': float(np.median(v)), 'withinOne': float((np.abs(v) <= 1).mean()), 'meanAbs': float(np.abs(v).mean())},
                'halvesMeanAbsDiff': float(np.abs(L - R).mean())})
rgb = np.asarray(Image.open(path).convert('RGB'))
an = np.zeros((rgb.shape[0], w, 3), np.uint8)
an[..., 0] = rgb[:, :w, 0]; an[..., 1] = rgb[:, w:2 * w, 1]; an[..., 2] = rgb[:, w:2 * w, 2]
Image.fromarray(an).save(path.replace('.png', '-anaglyph.png'))
print(json.dumps(res) if '--json' in args else res)
