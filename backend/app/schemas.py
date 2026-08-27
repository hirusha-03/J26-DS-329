from typing import List, Optional

from pydantic import BaseModel


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
