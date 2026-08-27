import io
from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from PIL import Image

from app.services import ocr_decoder
from app.services.tflite_inference import TFLiteMeterOCR

router = APIRouter(prefix="/api/ocr", tags=["ocr"])

tflite_ocr_engine = TFLiteMeterOCR()


@router.post("/decode-field")
async def decode_field(
    file: UploadFile = File(...),
    num_digits: int = Form(3),
    has_decimal_at: Optional[int] = Form(None)
):
    try:
        image_data = await file.read()
        img = Image.open(io.BytesIO(image_data))
        # Ensure we have a grayscale representation
        img_gray = img.convert("L")
        img_np = np.array(img_gray)

        # Otsu binarization
        thresh = ocr_decoder.otsu_threshold(img_np)
        binary_img = img_np < thresh
        h, w = binary_img.shape

        # Calculate horizontal profile (column sums of active pixels)
        col_sums = np.sum(binary_img, axis=0)
        min_active_pixels = max(1, int(h * 0.05))
        active = col_sums >= min_active_pixels

        # Find segments of active columns
        segments = []
        in_segment = False
        seg_start = 0
        for x in range(w):
            if active[x] and not in_segment:
                in_segment = True
                seg_start = x
            elif not active[x] and in_segment:
                in_segment = False
                width = x - seg_start
                if width >= 2:
                    segments.append({"start": seg_start, "width": width})
        if in_segment:
            width = w - seg_start
            if width >= 2:
                segments.append({"start": seg_start, "width": width})

        # Group/filter segments
        digit_boxes = []
        if len(segments) == num_digits:
            digit_boxes = segments
        elif len(segments) > num_digits:
            # Take the largest N segments sorted left-to-right
            sorted_by_width = sorted(segments, key=lambda s: s["width"], reverse=True)
            chosen = sorted(sorted_by_width[:num_digits], key=lambda s: s["start"])
            digit_boxes = chosen
        else:
            # Fallback to equal-width
            digit_w = w / num_digits
            for d in range(num_digits):
                digit_boxes.append({"start": int(d * digit_w), "width": int(digit_w)})

        digits_str = ""
        for d in range(num_digits):
            if has_decimal_at is not None and d == has_decimal_at:
                digits_str += "."

            box = digit_boxes[d]
            sx = box["start"]
            ex = sx + box["width"]
            slot_binary = binary_img[:, sx:ex]

            # Convert slot binary back to grayscale 0/255 for PIL
            slot_gray_np = np.where(slot_binary, 0, 255).astype(np.uint8)
            slot_img = Image.fromarray(slot_gray_np)

            # Aspect-ratio-preserving centering on 28x28 canvas
            sw, sh = slot_img.size
            aspect_ratio = sw / sh

            if aspect_ratio > 1.0:
                dh = max(4, int(28 / aspect_ratio))
                dy = (28 - dh) // 2
                dw = 28
                dx = 0
            else:
                dw = max(4, int(28 * aspect_ratio))
                dx = (28 - dw) // 2
                dh = 28
                dy = 0

            bg_img = Image.new("L", (28, 28), 255)
            slot_resized = slot_img.resize((dw, dh), Image.BILINEAR)
            bg_img.paste(slot_resized, (dx, dy))

            # Normalize to [0, 1] range
            slot_vector = np.array(bg_img, dtype=np.float32) / 255.0

            cls, conf = ocr_decoder.predict_digit(slot_vector.flatten())
            if cls == 10:
                digits_str += " "
            else:
                digits_str += str(cls)

        cleaned = digits_str.strip()
        if not cleaned:
            return {"value": None}

        try:
            return {"value": float(cleaned)}
        except ValueError:
            return {"value": None}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/scan-meter")
async def scan_meter(file: UploadFile = File(...)):
    try:
        image_data = await file.read()
        result = tflite_ocr_engine.run_inference(image_data, filename=file.filename)
        if "error" in result:
            raise HTTPException(status_code=400, detail=result["error"])
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
