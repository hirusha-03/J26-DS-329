"""Bounded image decoding shared by prediction and explanation."""

import io
import warnings

from fastapi import HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError

ACCEPTED_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
# Includes 48 MP phone images; checked before decoding or allocating RGB buffers.
MAX_IMAGE_PIXELS = 50_000_000
# Extremely narrow panoramas would otherwise allocate a huge resized image.
MAX_ASPECT_RATIO = 20


async def read_upload(file: UploadFile) -> bytes:
    if file.content_type not in ACCEPTED_TYPES:
        raise HTTPException(415, "Only JPG, PNG and WebP photos are supported.")
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "The photo is larger than 10 MB.")
    return data


def decode_image(data: bytes) -> Image.Image:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as img:
                w, h = img.size
                if w * h > MAX_IMAGE_PIXELS:
                    raise HTTPException(
                        400, "The photo exceeds the 50 megapixel limit."
                    )
                if min(w, h) < 1 or max(w, h) / min(w, h) > MAX_ASPECT_RATIO:
                    raise HTTPException(400, "The photo dimensions are not supported.")
                # RGB conversion detaches the returned image from the file buffer.
                return img.convert("RGB")
    except (Image.DecompressionBombWarning, Image.DecompressionBombError):
        raise HTTPException(400, "The photo dimensions are too large.") from None
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(400, "The image could not be decoded.") from None
