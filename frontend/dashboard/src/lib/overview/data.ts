import { API_BASE_URL } from "@/lib/constants";
import type { ModelStatus } from "@/lib/disease/types";
import type { HealthResponse } from "@/lib/advisory/api";
import { fetchPlantRows, toPlantView, type FetchResult, type HotspotCluster, type PlantView } from "@/lib/plantStatus";
import { supabase } from "@/lib/supabase";
import type { TrendRow } from "./cycleChanges";

const ADVISORY_API_URL = process.env.NEXT_PUBLIC_ADVISORY_API_URL || "http://127.0.0.1:8001";
const MODULE_TIMEOUT_MS = 3000;
// Field-app pages (inspection, history) live in frontend/monitor; same default as SideNav.
export const MONITOR_URL = (process.env.NEXT_PUBLIC_MONITOR_URL || "http://localhost:3000").replace(/\/$/, "");

export interface PlantData {
  plants: PlantView[];
  hotspots: HotspotCluster[];
  source: FetchResult["source"];
}

export async function loadPlants(now = Date.now()): Promise<PlantData> {
  const { rows, hotspots, source } = await fetchPlantRows();
  return { plants: rows.map((r) => toPlantView(r, now)), hotspots, source };
}

export async function loadTrends(): Promise<TrendRow[]> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase
    .from("health_trends")
    .select("level, entity_id, window_start, window_end, n_cycles, trend, slope, unhealthy_share, model_version, created_at")
    .in("level", ["block", "zone"]);
  if (error) throw new Error(`health_trends: ${error.message}`);
  return (data ?? []) as TrendRow[];
}

export type ModuleKey = "m1" | "m2" | "m3" | "m4";
export type ModuleState = "checking" | "live" | "limited" | "offline";

export interface ModuleHealth {
  state: ModuleState;
  detail: string;
  note?: string; // M1 validation label, shown in the data-trust section
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(MODULE_TIMEOUT_MS), cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function checkDisease(): Promise<ModuleHealth> {
  try {
    const s = await getJson<ModelStatus>(`${API_BASE_URL}/api/disease/status`);
    if (!s.model_loaded) return { state: "limited", detail: "Server up, model not loaded" };
    const gradcam = s.explanation?.enabled ? " · Grad-CAM on" : "";
    return { state: "live", detail: `${s.model_version ?? "model"}${gradcam}`, note: s.status };
  } catch {
    return { state: "offline", detail: "Disease API not reachable" };
  }
}

export async function checkAdvisory(): Promise<ModuleHealth> {
  try {
    const h = await getJson<HealthResponse>(`${ADVISORY_API_URL}/health`);
    return h.status === "ok"
      ? { state: "live", detail: "Advisor ready" }
      : { state: "limited", detail: "Advisor still loading" };
  } catch {
    return { state: "offline", detail: "Advisory service not running" };
  }
}
