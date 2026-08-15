"""Extracts individual digit-slot crops from the 5 real meter photos for
manual labeling (step 1 of the OCR fine-tune plan). For each photo:
rectify -> per-field crop -> same column-projection segmentation already
used in tflite_inference.py's run_mlp_ocr -> save each digit slot as its
own numbered 28x28 PNG under backend/ml_ocr_data/raw/, plus one contact
sheet (all crops in a numbered grid) so labels can be assigned by eye in
one pass instead of opening 50 files individually.

Usage: .venv/Scripts/python.exe -m ocr_debug.extract_crops
"""
import os
import sys
import json

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ocr_debug.rectify import find_green_screen_corners, warp_perspective
from tflite_inference import TFLiteMeterOCR

PHOTOS_DIR = r"D:\Y4S1\RP\vanilla-app\ocr"
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ml_ocr_data")
RAW_DIR = os.path.join(OUT_DIR, "raw")

FIELDS = {
    "ph": (0, 32, 98, 78, 3, 1),
    "ec": (90, 110, 145, 85, 3, 1),
    "temperature": (0, 185, 100, 55, 3, 1),
    "humidity": (135, 185, 90, 55, 2, None),
}


def segment_field(crop_np, ocr, rw, rh, max_digits):
    thresh = ocr.otsu_threshold(crop_np)
    binary_img = crop_np < thresh
    col_sums = np.sum(binary_img, axis=0)
    min_active_pixels = max(1, int(rh * 0.05))
    active = col_sums >= min_active_pixels

    segments = []
    in_segment = False
    seg_start = 0
    for x in range(rw):
        if active[x] and not in_segment:
            in_segment = True
            seg_start = x
        elif not active[x] and in_segment:
            in_segment = False
            width = x - seg_start
            if width >= 2:
                segments.append({"start": seg_start, "width": width})
    if in_segment:
        width = rw - seg_start
        if width >= 2:
            segments.append({"start": seg_start, "width": width})

    if len(segments) == max_digits or len(segments) == 0:
        return segments, binary_img
    elif len(segments) > max_digits:
        sorted_by_width = sorted(segments, key=lambda s: s["width"], reverse=True)
        chosen = sorted(sorted_by_width[:max_digits], key=lambda s: s["start"])
        return chosen, binary_img
    return segments, binary_img


def main():
    os.makedirs(RAW_DIR, exist_ok=True)
    ocr = TFLiteMeterOCR()

    photos = sorted(f for f in os.listdir(PHOTOS_DIR) if f.lower().endswith((".jpg", ".jpeg", ".png")))
    if not photos:
        print(f"No photos found in {PHOTOS_DIR}")
        sys.exit(1)

    manifest = []
    idx = 0
    thumbs = []

    for photo_name in photos:
        photo_path = os.path.join(PHOTOS_DIR, photo_name)
        image = Image.open(photo_path)
        corners = find_green_screen_corners(image)
        if corners is None:
            print(f"SKIP {photo_name}: no screen detected")
            continue
        rectified = warp_perspective(image, corners).convert("L")
        img_np = np.array(rectified)

        for field_name, (rx, ry, rw, rh, max_digits, decimal_from_end) in FIELDS.items():
            crop_np = img_np[ry:ry + rh, rx:rx + rw]
            digit_boxes, binary_img = segment_field(crop_np, ocr, rw, rh, max_digits)

            for box in digit_boxes:
                sx, ex = box["start"], box["start"] + box["width"]
                slot_binary = binary_img[:, sx:ex]
                slot_gray_np = np.where(slot_binary, 0, 255).astype(np.uint8)
                slot_img = Image.fromarray(slot_gray_np)

                sw, sh = slot_img.size
                if sw == 0 or sh == 0:
                    continue
                aspect_ratio = sw / sh
                if aspect_ratio > 1.0:
                    dh = max(4, int(28 / aspect_ratio))
                    dy = (28 - dh) // 2
                    dw, dx = 28, 0
                else:
                    dw = max(4, int(28 * aspect_ratio))
                    dx = (28 - dw) // 2
                    dh, dy = 28, 0

                bg_img = Image.new("L", (28, 28), 255)
                slot_resized = slot_img.resize((dw, dh), Image.BILINEAR)
                bg_img.paste(slot_resized, (dx, dy))

                idx += 1
                crop_id = f"{idx:04d}"
                crop_path = os.path.join(RAW_DIR, f"{crop_id}.png")
                bg_img.save(crop_path)
                manifest.append({
                    "id": crop_id,
                    "photo": photo_name,
                    "field": field_name,
                })
                thumbs.append((crop_id, bg_img))

    manifest_path = os.path.join(OUT_DIR, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"Saved {len(manifest)} crops to {RAW_DIR}")
    print(f"Manifest: {manifest_path}")

    # Contact sheet: grid of all crops, each labeled with its id, for
    # fast eyeball labeling in one image instead of opening 50 files.
    cols = 8
    rows = (len(thumbs) + cols - 1) // cols
    cell = 70
    sheet = Image.new("RGB", (cols * cell, rows * cell), (30, 30, 30))
    draw = ImageDraw.Draw(sheet)
    for i, (crop_id, img) in enumerate(thumbs):
        col, row = i % cols, i // cols
        x0, y0 = col * cell, row * cell
        big = img.resize((56, 56), Image.NEAREST).convert("RGB")
        sheet.paste(big, (x0 + 5, y0 + 5))
        draw.text((x0 + 5, y0 + 62), crop_id, fill=(255, 255, 0))
    sheet_path = os.path.join(OUT_DIR, "contact_sheet.png")
    sheet.save(sheet_path)
    print(f"Contact sheet: {sheet_path}")


if __name__ == "__main__":
    main()
