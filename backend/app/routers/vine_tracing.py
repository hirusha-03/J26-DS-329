import asyncio
import json
import math
import os
import tempfile
from pathlib import Path

import cv2
import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

router = APIRouter(prefix="/api/vine", tags=["Vine Tracing"])

SAM_ROOT = Path("/mnt/f/vanilla-sam2/sam2")
PYTHON = Path("/mnt/f/vanilla-sam2/sam-env/bin/python")
SCRIPT = SAM_ROOT / "guided_vine_tracer_v8.py"
CHECKPOINT = SAM_ROOT / "checkpoints/sam2.1_hiera_tiny.pt"

MAX_IMAGE_BYTES = 15 * 1024 * 1024
MAX_GUIDES = 200
TRACE_TIMEOUT_SECONDS = 600

# Prevent multiple GPU-intensive V8 jobs from running together.
trace_lock = asyncio.Lock()


@router.post("/trace")
async def trace_vine(
    image: UploadFile = File(...),
    guide_points: str = Form(...),
):
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

    photo = cv2.imdecode(
        np.frombuffer(raw, dtype=np.uint8),
        cv2.IMREAD_COLOR,
    )
    if photo is None:
        raise HTTPException(422, "Cannot decode photograph.")

    height, width = photo.shape[:2]

    try:
        points = json.loads(guide_points)
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(422, "Invalid guide points JSON.")

    if not isinstance(points, list) or not 2 <= len(points) <= MAX_GUIDES:
        raise HTTPException(422, "Provide 2–200 guide points.")

    waypoints = []

    for point in points:
        if not isinstance(point, dict):
            raise HTTPException(422, "Invalid guide point.")

        x, y = point.get("x"), point.get("y")

        if (
            isinstance(x, bool) or isinstance(y, bool)
            or not isinstance(x, (int, float))
            or not isinstance(y, (int, float))
            or not math.isfinite(x) or not math.isfinite(y)
            or not 0 <= x < width or not 0 <= y < height
        ):
            raise HTTPException(422, "Guide point outside photograph.")

        waypoints.append([int(x), int(y)])

    if not SCRIPT.is_file() or not CHECKPOINT.is_file() or not PYTHON.is_file():
        raise HTTPException(503, "SAM2 V8 installation is incomplete.")

    if trace_lock.locked():
        raise HTTPException(429, "SAM2 is busy. Try again after the current trace.")

    async with trace_lock:
        with tempfile.TemporaryDirectory(prefix="vine_v8_") as temp:
            job = Path(temp)
            image_path = job / "photo.png"
            points_path = job / "waypoints.json"
            output_dir = job / "output"

            if not cv2.imwrite(str(image_path), photo):
                raise HTTPException(500, "Could not prepare photograph.")

            points_path.write_text(json.dumps({
                "waypoints_xy": waypoints,
                "negative_points_xy": [],
            }))

            command = [
                str(PYTHON),
                str(SCRIPT),
                "--image", str(image_path),
                "--out", str(output_dir),
                "--points-json", str(points_path),
                "--checkpoint", str(CHECKPOINT),
                "--config", "configs/sam2.1/sam2.1_hiera_t.yaml",
                "--no-gui",
            ]

            try:
                process = await asyncio.create_subprocess_exec(
                    *command,
                    cwd=str(SAM_ROOT),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env={**os.environ, "PYTHONUNBUFFERED": "1"},
                    start_new_session=True,
                )
                try:
                    stdout, stderr = await asyncio.wait_for(
                        process.communicate(),
                        timeout=TRACE_TIMEOUT_SECONDS,
                    )
                except asyncio.TimeoutError:
                    import signal
                    os.killpg(process.pid, signal.SIGKILL)
                    await process.communicate()
                    raise HTTPException(504, "SAM2 tracing timed out.")
            except OSError as exc:
                raise HTTPException(500, f"Could not launch SAM2: {exc}")

            if process.returncode != 0:
                print("SAM2 V8 failed:", stderr.decode(errors="replace")[-4000:])
                raise HTTPException(
                    500,
                    "SAM2 tracing failed. Check the backend terminal.",
                )

            route_path = output_dir / "ordered_route_v8.json"
            report_path = output_dir / "guided_route_report.json"

            if not route_path.exists() or not report_path.exists():
                raise HTTPException(500, "SAM2 did not produce route outputs.")

            route = json.loads(route_path.read_text())
            report = json.loads(report_path.read_text())

            segments = route.get("segments_xy")
            if not isinstance(segments, list) or not segments:
                raise HTTPException(500, "SAM2 returned an empty route.")

            return {
                "status": "success",
                "method": "SAM2_V8",
                "segments_xy": segments,
                "route_length_px": report.get("route_length_px"),
                "segment_count": len(segments),
                "warning": report.get("warning"),
            }
