import json
import math

import cv2
import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

router = APIRouter(prefix="/api/vine", tags=["Vine Measurement"])

MAX_IMAGE_BYTES = 15 * 1024 * 1024
MAX_POINTS = 100000


@router.post("/measure")
async def measure_vine(
    image: UploadFile = File(...),
    ordered_points: str = Form(...),
    marker_size_cm: float = Form(...),
    vine_id: str = Form("Unassigned"),
):
    if not math.isfinite(marker_size_cm) or marker_size_cm <= 0:
        raise HTTPException(422, "Marker size must be positive and finite.")

    if image.content_type not in {
        "image/jpeg", "image/png", "image/webp"
    }:
        raise HTTPException(415, "Unsupported image type.")

    try:
        raw = await image.read(MAX_IMAGE_BYTES + 1)
    finally:
        await image.close()

    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "Image exceeds 15 MB.")

    array = np.frombuffer(raw, dtype=np.uint8)
    photo = cv2.imdecode(array, cv2.IMREAD_COLOR)

    if photo is None:
        raise HTTPException(422, "Unable to decode image.")

    try:
        points = json.loads(ordered_points)
    except json.JSONDecodeError:
        raise HTTPException(422, "Invalid route JSON.")

    # Accept either:
    # 1. [{"x": 10, "y": 20}, ...] (manual route)
    # 2. {"segments_xy": [[[10,20], [11,21]], ...]} (V8 route)
    is_segmented = isinstance(points, dict) and "segments_xy" in points
    raw_segments = points.get("segments_xy") if is_segmented else [points]

    if not isinstance(raw_segments, list) or not raw_segments:
        raise HTTPException(422, "Invalid route or segments_xy.")

    height, width = photo.shape[:2]
    normalized_segments = []
    total_points = 0

    for segment in raw_segments:
        if not isinstance(segment, list):
            raise HTTPException(422, "Each route segment must be a list.")

        normalized = []
        for point in segment:
            if isinstance(point, dict):
                x, y = point.get("x"), point.get("y")
            elif isinstance(point, list) and len(point) == 2:
                x, y = point
            else:
                raise HTTPException(422, "Invalid route point.")

            if (
                isinstance(x, bool) or isinstance(y, bool)
                or not isinstance(x, (int, float))
                or not isinstance(y, (int, float))
                or not math.isfinite(x) or not math.isfinite(y)
                or not 0 <= x < width or not 0 <= y < height
            ):
                raise HTTPException(422, "Route point outside image.")

            normalized.append((float(x), float(y)))

        if len(normalized) >= 2:
            normalized_segments.append(normalized)
            total_points += len(normalized)

    if not 2 <= total_points <= MAX_POINTS:
        raise HTTPException(422, "Route must contain 2–100000 valid points.")

    dictionary = cv2.aruco.getPredefinedDictionary(
        cv2.aruco.DICT_5X5_50
    )
    detector = cv2.aruco.ArucoDetector(
        dictionary, cv2.aruco.DetectorParameters()
    )
    corners, ids, _ = detector.detectMarkers(photo)

    if ids is None or len(ids) == 0:
        raise HTTPException(422, "No ArUco 5x5 marker detected.")

    # Initial integration: select the first detected marker.
    marker = corners[0].reshape(4, 2)
    sides = [
        float(np.linalg.norm(marker[(i + 1) % 4] - marker[i]))
        for i in range(4)
    ]
    marker_side_px = sum(sides) / 4

    if marker_side_px <= 0:
        raise HTTPException(422, "Invalid marker geometry.")

    # Never add a distance between separate V8 segments.
    route_length_px = sum(
        math.dist(segment[i - 1], segment[i])
        for segment in normalized_segments
        for i in range(1, len(segment))
    )

    cm_per_px = marker_size_cm / marker_side_px
    length_cm = route_length_px * cm_per_px

    return {
        "status": "success",
        "vine_id": vine_id,
        "marker_id": int(ids[0][0]),
        "marker_size_cm": marker_size_cm,
        "marker_side_px": round(marker_side_px, 3),
        "cm_per_px": round(cm_per_px, 7),
        "route_length_px": round(route_length_px, 2),
        "route_segment_count": len(normalized_segments),
        "route_source": "sam2_v8_segments" if is_segmented else "manual_polyline",
        "estimated_length_cm": round(length_cm, 2),
        "estimated_length_m": round(length_cm / 100, 4),
        "measurement_type": "projected_2d_estimate",
        "physical_ground_truth_validated": False,
        "route_confirmed_continuous": False,
        "warning": (
            "Single-image 2D estimate. Perspective, depth, "
            "marker orientation and route selection affect accuracy."
        ),
    }
