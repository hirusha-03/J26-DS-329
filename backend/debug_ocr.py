"""Manual debug tool for the meter OCR pipeline — takes a RAW photo (not
pre-rectified) and dumps every intermediate step as PNGs so failures are
visible instead of just getting a wrong number back:
  <out>_corners.png   original photo with detected screen quad drawn on it
  <out>_rectified.png the warped 240x240 crop
  <out>_fields.png    rectified crop with each field's box drawn on it
  <out>_field_<name>.png  per-field crop, upscaled for inspection

Usage: .venv/Scripts/python.exe debug_ocr.py path/to/photo.jpg [out_prefix]
"""
import sys
import os
from PIL import Image, ImageDraw

from ocr_debug.rectify import find_green_screen_corners, warp_perspective
from tflite_inference import TFLiteMeterOCR

FIELDS = {
    "ph": (0, 32, 98, 78, 3, 1),
    "ec": (90, 110, 145, 85, 3, 2),
    "temperature": (0, 185, 100, 55, 3, 1),
    "humidity": (135, 185, 90, 55, 2, None),
}


def main():
    if len(sys.argv) < 2:
        print("Usage: debug_ocr.py <path-to-raw-photo.jpg> [out_prefix]")
        sys.exit(1)

    photo_path = sys.argv[1]
    out_prefix = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(os.path.basename(photo_path))[0]
    out_dir = os.path.join(os.path.dirname(__file__), "ocr_debug", "out")
    os.makedirs(out_dir, exist_ok=True)

    image = Image.open(photo_path)
    print(f"Loaded {photo_path}: {image.size}")

    corners = find_green_screen_corners(image)
    if corners is None:
        print("FAILED: no green LCD backlight region detected (screen not found).")
        sys.exit(1)

    print("Detected corners:", corners)
    annotated = image.convert("RGB").copy()
    draw = ImageDraw.Draw(annotated)
    pts = [corners.tl, corners.tr, corners.br, corners.bl, corners.tl]
    draw.line(pts, fill=(255, 0, 0), width=4)
    for label, pt in [("TL", corners.tl), ("TR", corners.tr), ("BL", corners.bl), ("BR", corners.br)]:
        draw.ellipse([pt[0] - 5, pt[1] - 5, pt[0] + 5, pt[1] + 5], fill=(255, 0, 0))
    corners_path = os.path.join(out_dir, f"{out_prefix}_corners.png")
    annotated.save(corners_path)
    print("Saved:", corners_path)

    rectified = warp_perspective(image, corners)
    rectified_path = os.path.join(out_dir, f"{out_prefix}_rectified.png")
    rectified.save(rectified_path)
    print("Saved:", rectified_path)

    fields_annotated = rectified.convert("RGB").copy()
    fdraw = ImageDraw.Draw(fields_annotated)
    for name, (rx, ry, rw, rh, _num, _dec) in FIELDS.items():
        fdraw.rectangle([rx, ry, rx + rw, ry + rh], outline=(255, 0, 0), width=1)
        fdraw.text((rx, max(0, ry - 10)), name, fill=(255, 0, 0))
    fields_path = os.path.join(out_dir, f"{out_prefix}_fields.png")
    fields_annotated.save(fields_path)
    print("Saved:", fields_path)

    for name, (rx, ry, rw, rh, _num, _dec) in FIELDS.items():
        crop = rectified.crop((rx, ry, rx + rw, ry + rh))
        crop = crop.resize((rw * 4, rh * 4), Image.NEAREST)
        crop_path = os.path.join(out_dir, f"{out_prefix}_field_{name}.png")
        crop.save(crop_path)

    ocr = TFLiteMeterOCR()
    results = ocr.run_mlp_ocr(rectified)
    print("\nDecoded fields:", results)


if __name__ == "__main__":
    main()
