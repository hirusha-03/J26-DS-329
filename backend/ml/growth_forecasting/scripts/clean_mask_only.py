import argparse
from pathlib import Path
import cv2
import numpy as np

p = argparse.ArgumentParser(description='Conservative cleaning of a SAM2 vine mask')
p.add_argument('--mask', required=True)
p.add_argument('--image', required=True)
p.add_argument('--out', default='clean1')
p.add_argument('--min-area', type=int, default=12, help='Remove components smaller than this pixel area; use 0 to disable')
p.add_argument('--close', type=int, default=0, help='Optional morphological closing kernel size; 0 disables')
a = p.parse_args()
image = cv2.imread(a.image)
mask = cv2.imread(a.mask, cv2.IMREAD_GRAYSCALE)
if image is None or mask is None:
    raise SystemExit('Could not read image or mask. Check absolute paths.')
if image.shape[:2] != mask.shape:
    raise SystemExit(f'Size mismatch: image {image.shape[:2]}, mask {mask.shape}')
_, binary = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)
if a.close > 1:
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (a.close, a.close))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
num, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
clean = np.zeros_like(binary)
for i in range(1, num):
    if stats[i, cv2.CC_STAT_AREA] >= a.min_area:
        clean[labels == i] = 255
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
cv2.imwrite(str(out/'vine01_clean_mask.png'), clean)
overlay = image.copy()
overlay[clean > 0] = (0.45 * overlay[clean > 0] + 0.55 * np.array([0, 255, 0])).astype(np.uint8)
cv2.imwrite(str(out/'vine01_clean_overlay.png'), overlay)
removed = cv2.subtract(binary, clean)
review = image.copy()
review[clean > 0] = (0.55 * review[clean > 0] + 0.45 * np.array([0, 255, 0])).astype(np.uint8)
review[removed > 0] = (0, 0, 255)
cv2.imwrite(str(out/'vine01_review_removed_red.png'), review)
print(f'Saved cleaned mask, overlay, and removal review in: {out.resolve()}')
print(f'Foreground pixels: {cv2.countNonZero(binary)} -> {cv2.countNonZero(clean)}')
print('Review red pixels carefully: some may be real vine.')
