// ─── Core Entity Types ───────────────────────────────────

export interface User {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  role: 'admin' | 'supervisor' | 'inspector';
  createdAt: string;
}

export interface Plant {
  id: string;
  plantNumber: string;
  zone: string;
  block: string;
  row: number;
  gpsLat?: number;
  gpsLng?: number;
  plantedDate?: string;
  status: 'healthy' | 'diseased' | 'dead' | 'unknown';
}

export interface Inspection {
  id: string;
  plantId: string;
  inspectorId: string;
  zone: string;
  block: string;
  plantNumber: string;
  height: number;
  ph: number;
  humidity: number;
  temperature: number;
  fertilizer: string;
  watering: string;
  notes: string;
  imageUrl?: string;
  diseaseDetection?: DiseaseResult;
  createdAt: string;
  syncStatus: 'synced' | 'pending' | 'failed';
}

export interface DiseaseResult {
  disease: string;
  confidence: number;
  imageUrl: string;
  detectedAt: string;
}

export interface BeanClassification {
  grade: string;
  confidence: number;
  imageUrl: string;
  classifiedAt: string;
}

export interface WeatherData {
  date: string;
  tempMax: number;
  tempMin: number;
  humidity: number;
  precipitation: number;
  windSpeed: number;
  weatherCode: number;
  description: string;
}

export interface GrowthRecord {
  date: string;
  plantId: string;
  height: number;
  zone: string;
  block: string;
}

export interface DashboardStats {
  totalPlants: number;
  healthyPlants: number;
  diseasedPlants: number;
  deadPlants: number;
  totalBlocks: number;
  totalInspections: number;
  pendingSync: number;
  recentSubmissions: Inspection[];
}

export interface Recommendation {
  id: string;
  plantId?: string;
  zone?: string;
  type: 'watering' | 'fertilizer' | 'disease' | 'general';
  message: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  createdAt: string;
}

export interface BlockInfo {
  id: string;
  zone: string;
  block: string;
  plantCount: number;
  healthyCount: number;
  diseasedCount: number;
  avgHeight: number;
  gpsCenter: { lat: number; lng: number };
}

// ─── Form Types ──────────────────────────────────────────

export interface InspectionFormData {
  zone: string;
  block: string;
  plantNumber: string;
  height: number;
  ph: number;
  humidity: number;
  temperature: number;
  fertilizer: string;
  watering: string;
  notes: string;
  image?: File;
}

// ─── API Response Types ──────────────────────────────────

export interface ApiResponse<T> {
  data: T;
  message?: string;
  success: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
