"""Python port of the screen-detection + perspective-rectification steps
from frontend/src/lib/meterOcr.ts (findGreenScreenCorners,
warpPerspectiveCanvas), so the OCR pipeline can be tested end-to-end
against a raw photo outside the browser. Mirrors the JS algorithm exactly
(same HSV thresholds, same connected-components + corner-extremes logic,
same bilinear warp) rather than using a different CV approach, so results
match what the app actually does.
"""
from collections import deque
from typing import NamedTuple, Optional

import numpy as np
from PIL import Image


class Corners(NamedTuple):
    tl: tuple
    tr: tuple
    bl: tuple
    br: tuple


def rgb_to_hsv_np(rgb: np.ndarray) -> np.ndarray:
    """Vectorized RGB[0..255] -> HSV (H in degrees 0-360, S/V in 0-100)."""
    arr = rgb.astype(np.float32) / 255.0
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    maxc = np.max(arr, axis=-1)
    minc = np.min(arr, axis=-1)
    v = maxc
    d = maxc - minc
    s = np.where(maxc == 0, 0, d / np.where(maxc == 0, 1, maxc))

    h = np.zeros_like(maxc)
    mask = d != 0
    rc = np.where(mask & (maxc == r), ((g - b) / np.where(d == 0, 1, d)) % 6, 0)
    gc = np.where(mask & (maxc == g) & (maxc != r), (b - r) / np.where(d == 0, 1, d) + 2, 0)
    bc = np.where(mask & (maxc == b) & (maxc != r) & (maxc != g), (r - g) / np.where(d == 0, 1, d) + 4, 0)
    h = (rc + gc + bc) / 6.0
    h = np.where(h < 0, h + 1, h)
    return np.stack([h * 360, s * 100, v * 100], axis=-1)


def find_green_screen_corners(image: Image.Image) -> Optional[Corners]:
    """Mirrors meterOcr.ts's findGreenScreenCorners: downsample to 120x120,
    HSV-threshold for the green LCD backlight, BFS the largest connected
    component, then take the 4 extreme points (x+y, x-y) as TL/TR/BL/BR.
    """
    grid_w = grid_h = 120
    small = image.convert("RGB").resize((grid_w, grid_h), Image.BILINEAR)
    rgb = np.array(small)
    hsv = rgb_to_hsv_np(rgb)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]

    green_mask = (h >= 65) & (h <= 175) & (s >= 15) & (v >= 12)

    visited = np.zeros((grid_h, grid_w), dtype=bool)
    largest = []

    for y0 in range(grid_h):
        for x0 in range(grid_w):
            if not green_mask[y0, x0] or visited[y0, x0]:
                continue
            comp = []
            q = deque([(x0, y0)])
            visited[y0, x0] = True
            while q:
                x, y = q.popleft()
                comp.append((x, y))
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if 0 <= nx < grid_w and 0 <= ny < grid_h and green_mask[ny, nx] and not visited[ny, nx]:
                        visited[ny, nx] = True
                        q.append((nx, ny))
            if len(comp) > len(largest):
                largest = comp

    if len(largest) < 260:
        return None

    tl = tr = bl = br = largest[0]
    min_tl = tl[0] + tl[1]
    max_tr = tr[0] - tr[1]
    min_bl = bl[0] - bl[1]
    max_br = br[0] + br[1]

    for pt in largest:
        s_ = pt[0] + pt[1]
        d_ = pt[0] - pt[1]
        if s_ < min_tl:
            min_tl, tl = s_, pt
        if d_ > max_tr:
            max_tr, tr = d_, pt
        if d_ < min_bl:
            min_bl, bl = d_, pt
        if s_ > max_br:
            max_br, br = s_, pt

    scale_x = image.width / grid_w
    scale_y = image.height / grid_h
    return Corners(
        tl=(tl[0] * scale_x, tl[1] * scale_y),
        tr=(tr[0] * scale_x, tr[1] * scale_y),
        bl=(bl[0] * scale_x, bl[1] * scale_y),
        br=(br[0] * scale_x, br[1] * scale_y),
    )


def warp_perspective(image: Image.Image, corners: Corners, target_w=240, target_h=240) -> Image.Image:
    """Mirrors meterOcr.ts's warpPerspectiveCanvas: bilinear-interpolated
    quad-to-rectangle warp (nearest-neighbor sampling from the source, same
    as the JS Math.floor-based sampling)."""
    src = np.array(image.convert("RGB"))
    src_h, src_w = src.shape[:2]
    out = np.zeros((target_h, target_w, 3), dtype=np.uint8)

    ys, xs = np.mgrid[0:target_h, 0:target_w]
    tx = xs / (target_w - 1)
    ty = ys / (target_h - 1)

    sx = ((1 - tx) * (1 - ty) * corners.tl[0] +
          tx * (1 - ty) * corners.tr[0] +
          (1 - tx) * ty * corners.bl[0] +
          tx * ty * corners.br[0]).astype(int)
    sy = ((1 - tx) * (1 - ty) * corners.tl[1] +
          tx * (1 - ty) * corners.tr[1] +
          (1 - tx) * ty * corners.bl[1] +
          tx * ty * corners.br[1]).astype(int)

    valid = (sx >= 0) & (sx < src_w) & (sy >= 0) & (sy < src_h)
    out[valid] = src[sy[valid], sx[valid]]

    return Image.fromarray(out)


def rectify(image: Image.Image, target_w=240, target_h=240) -> Optional[Image.Image]:
    """Full pipeline: detect green screen corners, then warp. Returns None
    if no green LCD backlight region was found (mirrors the JS null case)."""
    corners = find_green_screen_corners(image)
    if corners is None:
        return None
    return warp_perspective(image, corners, target_w, target_h)
