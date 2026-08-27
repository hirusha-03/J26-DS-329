import os
import io
from typing import List, Optional
from datetime import datetime
from fastapi import FastAPI, HTTPException, status, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from supabase import create_client, Client
from PIL import Image
import numpy as np

# Load environment variables
load_dotenv()

app = FastAPI(
    title="Vanilla Monitor API",
    description="Backend API for plantation inspections, GPS tracking, and mortality reports.",
    version="2.0.0"
)

# Configure CORS
origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]

cors_origins_env = os.getenv("CORS_ORIGINS")
if cors_origins_env:
    additional_origins = [origin.strip() for origin in cors_origins_env.split(",") if origin.strip()]
    origins.extend(additional_origins)

origins = list(set(origins))

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Supabase Client
SUPABASE_URL = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY") or os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY")

supabase: Optional[Client] = None
if SUPABASE_URL and SUPABASE_ANON_KEY:
    try:
        supabase = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
        print("Supabase client initialized successfully.")
    except Exception as e:
        print(f"Failed to initialize Supabase client: {e}")
else:
    print("Warning: Supabase credentials not found. API running in fallback local mock mode.")

# Pydantic schemas (New Database Structure)
class Plant(BaseModel):
    plant_id: str
    zone: str
    block: str
    plant_no: int
    qr_code: Optional[str] = None
    qr_image_url: Optional[str] = None
    common_name: Optional[str] = None
    latin_name: Optional[str] = None
    scientific_name: Optional[str] = None
    variety: Optional[str] = None
    plant_type: Optional[str] = None
    purchase_date: Optional[str] = None
    planted_date: Optional[str] = None
    purchased_from: Optional[str] = None
    purchase_condition: Optional[str] = None
    max_cutting_height_cm: Optional[float] = None
    planting_arrangement: Optional[str] = None
    spacing_between_hedges: Optional[str] = None
    spacing_between_rows: Optional[str] = None
    land_type: Optional[str] = None
    agricultural_land_type: Optional[str] = None
    landform_type: Optional[str] = None
    support_tree_type: Optional[str] = None
    created_at: Optional[str] = None

class PlantLocation(BaseModel):
    plant_id: str
    latitude: float
    longitude: float
    altitude: Optional[float] = None
    accuracy: Optional[float] = None
    created_at: Optional[str] = None

class Inspection(BaseModel):
    id: str
    plant_id: str
    inspection_date: Optional[str] = None
    supervisor_name: Optional[str] = None
    supervisor_email: Optional[str] = None
    watering_status: Optional[str] = None
    sunlight_level: Optional[str] = None
    shade_level: Optional[str] = None
    soil_type: Optional[str] = None
    soil_ph: Optional[float] = None
    soil_ec: Optional[float] = None
    moisture: Optional[float] = None
    temperature: Optional[float] = None
    humidity: Optional[float] = None
    fertilizer_type: Optional[List[str]] = None
    fertilizer_used: Optional[str] = None
    last_fertilized: Optional[str] = None
    vine_height_cm: Optional[float] = None
    foliage_color: Optional[str] = None
    notes: Optional[str] = None
    photo_url: Optional[str] = None
    sync_status: Optional[str] = "synced"
    created_at: Optional[str] = None

# Pydantic schemas (Backward Compatibility)
class Submission(BaseModel):
    id: str
    plant_id: str
    zone: str
    block: str
    supervisor_name: Optional[str] = None
    supervisor_email: Optional[str] = None
    watering_status: Optional[str] = None
    sunlight_level: Optional[str] = None
    shade_level: Optional[str] = None
    soil_ph: Optional[float] = None
    temperature_c: Optional[float] = None
    humidity_pct: Optional[float] = None
    soil_type: Optional[str] = None
    fertiliser_type: Optional[List[str]] = None
    last_fertilised: Optional[str] = None
    fertiliser_used: Optional[str] = None
    vine_height_cm: Optional[float] = None
    height_delta_cm: Optional[float] = None
    foliage_color: Optional[str] = None
    planting_arrangement: Optional[str] = None
    notes: Optional[str] = None
    photo_filename: Optional[str] = None
    photo_url: Optional[str] = None
    status: Optional[str] = "synced"
    sync_status: Optional[str] = "synced"
    submitted_at: Optional[str] = None

class GPSRecord(BaseModel):
    plant_id: str
    lat: float
    lng: float

class MortalityReport(BaseModel):
    id: str
    zone: str
    block: str
    dead_support_trees: int
    dead_vines: int
    reported_at: Optional[str] = None

# Mock Memory DB
mock_plants_list = []
mock_locations_list = []
mock_inspections_list = []
mock_submissions_list = []
mock_mortality_list = []

@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "database_connected": supabase is not None
    }

# ----------------- NEW SYSTEM ENDPOINTS -----------------

@app.post("/api/plants", status_code=status.HTTP_201_CREATED)
async def create_plant(plant: Plant):
    if not supabase:
        data = plant.dict()
        # check duplicate
        mock_plants_list[:] = [p for p in mock_plants_list if p["plant_id"] != plant.plant_id]
        mock_plants_list.append(data)
        return {"message": "Plant saved successfully (mock mode)", "data": data}
    try:
        data = plant.dict()
        response = supabase.table("plants").upsert(data).execute()
        return {"message": "Plant synced successfully", "data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.get("/api/plants")
async def get_plants():
    if not supabase:
        return {"data": mock_plants_list}
    try:
        response = supabase.table("plants").select("*").execute()
        return {"data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.post("/api/plant_locations", status_code=status.HTTP_201_CREATED)
async def create_plant_location(location: PlantLocation):
    if not supabase:
        data = location.dict()
        mock_locations_list[:] = [l for l in mock_locations_list if l["plant_id"] != location.plant_id]
        mock_locations_list.append(data)
        return {"message": "Location saved successfully (mock mode)", "data": data}
    try:
        data = location.dict()
        response = supabase.table("plant_locations").upsert(data).execute()
        return {"message": "Location synced successfully", "data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.get("/api/plant_locations")
async def get_plant_locations():
    if not supabase:
        return {"data": mock_locations_list}
    try:
        response = supabase.table("plant_locations").select("*").execute()
        return {"data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.post("/api/inspections", status_code=status.HTTP_201_CREATED)
async def create_inspection(inspection: Inspection):
    if not supabase:
        data = inspection.dict()
        mock_inspections_list[:] = [i for i in mock_inspections_list if i["id"] != inspection.id]
        mock_inspections_list.append(data)
        return {"message": "Inspection saved successfully (mock mode)", "data": data}
    try:
        data = inspection.dict()
        response = supabase.table("inspections").upsert(data).execute()
        return {"message": "Inspection synced successfully", "data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.get("/api/inspections")
async def get_inspections():
    if not supabase:
        return {"data": mock_inspections_list}
    try:
        response = supabase.table("inspections").select("*").order("created_at", descending=True).execute()
        return {"data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

# ----------------- BACKWARD COMPATIBLE ENDPOINTS -----------------

@app.post("/api/submissions", status_code=status.HTTP_201_CREATED)
async def create_submission(submission: Submission):
    if not supabase:
        data = submission.dict()
        mock_submissions_list[:] = [s for s in mock_submissions_list if s["id"] != submission.id]
        mock_submissions_list.append(data)
        return {"message": "Saved successfully (mock mode)", "data": submission}
    try:
        data = submission.dict()
        response = supabase.table("submissions").upsert(data).execute()
        return {"message": "Submission synced successfully", "data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.get("/api/submissions")
async def get_submissions():
    if not supabase:
        return {"data": mock_submissions_list}
    try:
        response = supabase.table("submissions").select("*").execute()
        return {"data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.post("/api/gps", status_code=status.HTTP_201_CREATED)
async def save_gps(gps: GPSRecord):
    if not supabase:
        data = {"plant_id": gps.plant_id, "latitude": gps.lat, "longitude": gps.lng}
        mock_locations_list[:] = [l for l in mock_locations_list if l["plant_id"] != gps.plant_id]
        mock_locations_list.append(data)
        return {"message": "GPS saved successfully (mock mode)", "data": gps}
    try:
        data = {"plant_id": gps.plant_id, "latitude": gps.lat, "longitude": gps.lng}
        response = supabase.table("plant_locations").upsert(data).execute()
        return {"message": "GPS saved successfully", "data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.get("/api/gps")
async def get_gps():
    if not supabase:
        res = [{"plant_id": l["plant_id"], "lat": l["latitude"], "lng": l["longitude"]} for l in mock_locations_list]
        return {"data": res}
    try:
        response = supabase.table("plant_locations").select("plant_id, latitude, longitude").execute()
        res = [{"plant_id": r["plant_id"], "lat": r["latitude"], "lng": r["longitude"]} for r in response.data]
        return {"data": res}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.post("/api/mortality", status_code=status.HTTP_201_CREATED)
async def create_mortality_report(report: MortalityReport):
    if not supabase:
        data = report.dict()
        mock_mortality_list[:] = [m for m in mock_mortality_list if m["id"] != report.id]
        mock_mortality_list.append(data)
        return {"message": "Mortality report saved successfully (mock mode)", "data": report}
    try:
        data = report.dict()
        response = supabase.table("mortality_reports").upsert(data).execute()
        return {"message": "Mortality report saved successfully", "data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.get("/api/mortality")
async def get_mortality_reports():
    if not supabase:
        return {"data": mock_mortality_list}
    try:
        response = supabase.table("mortality_reports").select("*").execute()
        return {"data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

# ----------------- OCR DECODER ENDPOINTS (OPTION A) -----------------

import json

# Load digit recognition model
MODEL_PATH = os.path.join(os.path.dirname(__file__), "digit_model.json")
try:
    with open(MODEL_PATH, "r") as f:
        model_weights = json.load(f)
    W1 = np.array(model_weights["W1"])
    b1 = np.array(model_weights["b1"])
    W2 = np.array(model_weights["W2"])
    b2 = np.array(model_weights["b2"])
    W3 = np.array(model_weights["W3"])
    b3 = np.array(model_weights["b3"])
except Exception as e:
    print(f"Warning: Could not load digit_model.json: {e}")
    W1, b1, W2, b2, W3, b3 = None, None, None, None, None, None

def otsu_threshold(gray: np.ndarray) -> int:
    hist, bin_edges = np.histogram(gray, bins=256, range=(0, 256))
    total = gray.size

    current_max = 0.0
    threshold = 127

    sum_total = np.sum(np.arange(256) * hist)
    sum_back = 0.0
    weight_back = 0.0

    for t in range(256):
        weight_back += hist[t]
        if weight_back == 0:
            continue
        weight_fore = total - weight_back
        if weight_fore == 0:
            break

        sum_back += t * hist[t]
        mean_back = sum_back / weight_back
        mean_fore = (sum_total - sum_back) / weight_fore

        var_between = weight_back * weight_fore * (mean_back - mean_fore) ** 2
        if var_between > current_max:
            current_max = var_between
            threshold = t

    return threshold

def predict_digit(flat_img):
    if W1 is None:
        return 10, 0.0
    h1 = np.maximum(0, np.dot(flat_img, W1) + b1)
    h2 = np.maximum(0, np.dot(h1, W2) + b2)
    scores = np.dot(h2, W3) + b3
    # Softmax
    exps = np.exp(scores - np.max(scores))
    probs = exps / np.sum(exps)
    cls = np.argmax(probs)
    return int(cls), float(probs[cls])

@app.post("/api/ocr/decode-field")
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
        thresh = otsu_threshold(img_np)
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

            cls, conf = predict_digit(slot_vector.flatten())
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

# ----------------- TFLITE DEEP LEARNING SCAN ENDPOINT -----------------

from tflite_inference import TFLiteMeterOCR
tflite_ocr_engine = TFLiteMeterOCR()

@app.post("/api/ocr/scan-meter")
async def scan_meter(
    file: UploadFile = File(...)
):
    try:
        image_data = await file.read()
        result = tflite_ocr_engine.run_inference(image_data, filename=file.filename)
        if "error" in result:
            raise HTTPException(status_code=400, detail=result["error"])
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

