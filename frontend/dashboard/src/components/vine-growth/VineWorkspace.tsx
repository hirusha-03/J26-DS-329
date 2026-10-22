"use client";

import { ChangeEvent, PointerEvent, useEffect, useRef, useState } from "react";
import { Check, Download, ImagePlus, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { API_BASE_URL } from "@/lib/constants";

type Point = { x: number; y: number };
type SavedMeasurement = {
  id: string;
  date: string;
  vineId: string;
  pixelLength: number;
  lengthCm?: number;
  zone?: "A" | "B" | "C" | "D";
  blockNumber?: string;
  plantNumber?: string;
  clicks: number;
  status: string;
};
const STORAGE_KEY = "vanilla-vine-measurements-demo-v1";

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-border-light bg-white p-4 shadow-sm sm:p-5 ${className}`}>{children}</section>;
}
function lengthOf(points: Point[]) { return points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0); }

export default function VineWorkspace() {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageName, setImageName] = useState("");
  const [naturalSize, setNaturalSize] = useState({ width: 1, height: 1 });
  const [points, setPoints] = useState<Point[]>([]);
  const [vineId, setVineId] = useState("VINE-001");
  const [zone, setZone] = useState<"A" | "B" | "C" | "D">("A");
  const [blockNumber, setBlockNumber] = useState("01");
  const [plantNumber, setPlantNumber] = useState("001");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [measurements, setMeasurements] = useState<SavedMeasurement[]>([]);
  const [message, setMessage] = useState("");
  const [routeData, setRouteData] = useState<Point[] | null>(null);
  const [routeSegments, setRouteSegments] = useState<Point[][] | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [markerSizeCm, setMarkerSizeCm] = useState("6.7");
  const [isCalculating, setIsCalculating] = useState(false);
  const [isTracing, setIsTracing] = useState(false);
  const [isEditingRoute, setIsEditingRoute] = useState(false);
  const [correctionPoints, setCorrectionPoints] = useState<Point[]>([]);
  const [sectionCorrections, setSectionCorrections] = useState<Record<number, Point>>({});
  // BATCH_VINE_CORRECTIONS_V1
  const [draftGuides, setDraftGuides] = useState<Point[]>([]);
  const [selectedSection, setSelectedSection] = useState<number | null>(null);
  // SECTION_AWARE_V8_CORRECTION
  const [calibrationResult, setCalibrationResult] = useState<{
    estimated_length_cm: number;
    estimated_length_m: number;
    marker_id: number;
    warning: string;
  } | null>(null);


  useEffect(() => {
    // Load saved measurements after mount without synchronously updating state in the effect.
    queueMicrotask(() => {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) setMeasurements(parsed as SavedMeasurement[]);
      } catch { /* storage unavailable or malformed */ }
    });
  }, []);

  const displayPoints = routeData ?? points;
  const pixels = routeSegments
    ? routeSegments.reduce((sum, segment) => sum + lengthOf(segment), 0)
    : lengthOf(displayPoints);
  async function onImageUpload(event: ChangeEvent<HTMLInputElement>) {
  const file = event.target.files?.[0];
  if (!file) return;

  event.target.value = "";

  const allowedTypes = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
  ]);

  if (!allowedTypes.has(file.type)) {
    setMessage("Please select a JPEG, PNG, or WebP photograph.");
    return;
  }

  const MAX_SIZE = 15 * 1024 * 1024;

  if (file.size > MAX_SIZE) {
    setMessage("Image must be smaller than 15 MB.");
    return;
  }

  try {
    const bitmap = await createImageBitmap(file);

    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;

      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Unable to process the image.");
      }

      context.drawImage(bitmap, 0, 0);

      const safeImageUrl = canvas.toDataURL("image/png");

      setImageUrl(safeImageUrl);
      setImageName(file.name);
      setPoints([]);
      setRouteData(null);
      setRouteSegments(null);
      setIsEditingRoute(false);
      setCorrectionPoints([]);
      setDraftGuides([]);
      setSelectedSection(null);
      setCalibrationResult(null);
      setNaturalSize({
        width: bitmap.width,
        height: bitmap.height,
      });

      setMessage(
        "Photo loaded. Tap points along the vine in growth order."
      );
    } finally {
      bitmap.close();
    }
  } catch {
    setMessage("Unable to decode the selected photograph.");
  }
}
  function onPointerDown(event: PointerEvent<HTMLImageElement>) {
    if (!imageRef.current || isTracing) return;
    if (routeData && !isEditingRoute) return;

    const bounds = imageRef.current.getBoundingClientRect();
    const x = Math.min(
      naturalSize.width - 1,
      Math.max(0, (event.clientX - bounds.left) / bounds.width * naturalSize.width)
    );
    const y = Math.min(
      naturalSize.height - 1,
      Math.max(0, (event.clientY - bounds.top) / bounds.height * naturalSize.height)
    );
    const point = { x: Math.round(x), y: Math.round(y) };

    if (!isEditingRoute) {
      setPoints(prev => [...prev, point]);
      setMessage("");
      return;
    }

    if (!routeSegments || routeSegments.length !== points.length - 1) {
      setMessage("Route sections do not match the original guide points.");
      return;
    }

    const sectionDistance = (section: Point[]) => {
      let best = Infinity;
      for (let j = 1; j < section.length; j++) {
        const a = section[j - 1];
        const b = section[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = Math.max(0, Math.min(1,
          ((point.x - a.x) * dx + (point.y - a.y) * dy) /
          (dx * dx + dy * dy || 1)
        ));
        best = Math.min(best, Math.hypot(
          point.x - (a.x + t * dx),
          point.y - (a.y + t * dy)
        ));
      }
      return best;
    };

    const sectionIndex = selectedSection ??
      routeSegments.reduce(
        (best, section, index) =>
          sectionDistance(section) < sectionDistance(routeSegments[best])
            ? index : best,
        0
      );

    if (sectionIndex < 0 || sectionIndex >= routeSegments.length) {
      setMessage("Invalid route section.");
      return;
    }

    // Store corrections by original section, not by draft waypoint index.
    const nextCorrections = {
      ...sectionCorrections,
      [sectionIndex]: point
    };

    setSectionCorrections(nextCorrections);
    setCorrectionPoints(Object.values(nextCorrections));

    // Build guides in vine-growth order from original waypoints.
    const updated: Point[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      updated.push(points[i]);
      if (nextCorrections[i]) updated.push(nextCorrections[i]);
    }
    updated.push(points[points.length - 1]);

    setDraftGuides(updated);
    setCalibrationResult(null);
    setMessage(
      `Section ${sectionIndex + 1} correction saved. ` +
      "Review your corrections, then click Apply Corrections & Reroute."
    );
  }

  function save() {
    if (displayPoints.length < 2) {
      setMessage("Add at least two points or import an ordered route before saving.");
      return;
    }
    if (!calibrationResult || !Number.isFinite(calibrationResult.estimated_length_cm) || calibrationResult.estimated_length_cm <= 0) {
      setMessage("Calculate Vine Length with ArUco before saving a calibrated measurement.");
      return;
    }
    if (!blockNumber.trim() || !plantNumber.trim()) {
      setMessage("Enter both a block number and a plant number before saving.");
      return;
    }
    const item: SavedMeasurement = {
      id: crypto.randomUUID(),
      date,
      vineId: vineId.trim() || "Unassigned",
      zone,
      blockNumber: blockNumber.trim(),
      plantNumber: plantNumber.trim(),
      pixelLength: Number(pixels.toFixed(2)),
      lengthCm: Number(calibrationResult.estimated_length_cm.toFixed(2)),
      clicks: routeData ? 0 : points.length,
      status: routeData ? "Imported V8 route — review required" : "Manual polyline — review required",
    };
    const next = [item, ...measurements].slice(0, 100);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setMeasurements(next);
      setMessage("Calibrated measurement saved locally. Open the four-week forecast to view this plant's history.");
    } catch {
      setMessage("Could not save in browser storage. No record was added.");
    }
  }

  function deleteMeasurement(id: string) {
    if (!window.confirm("Delete this saved measurement from this browser?")) return;
    const next = measurements.filter(m => m.id !== id);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setMeasurements(next);
      setMessage("Measurement deleted from this browser.");
    } catch {
      setMessage("Could not delete the measurement from browser storage.");
    }
  }

  function exportJSON() {
    const payload = { vineId, date, imageName, unit: "px", projected_length_px: pixels, ordered_points: displayPoints, source: routeData ? "imported_ordered_route" : "manual_polyline", calibration_status: "not_calibrated" };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `${vineId || "vine"}_measurement.json`; link.click(); URL.revokeObjectURL(url);
  }
  function extractPoints(value: unknown): Point[] {
    const isPoint = (p: unknown): p is Point => typeof p === "object" && p !== null && typeof (p as Point).x === "number" && typeof (p as Point).y === "number";
    const parseArray = (a: unknown): Point[] => Array.isArray(a) ? a.flatMap(p => Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number" ? [{ x: p[0], y: p[1] }] : isPoint(p) ? [p] : []) : [];
    if (Array.isArray(value)) return parseArray(value);
    if (typeof value === "object" && value !== null) {
      const obj = value as Record<string, unknown>;
      for (const key of ["ordered_points", "route", "points", "coordinates", "ordered_route"]) {
        if (obj[key]) { const direct = parseArray(obj[key]); if (direct.length > 1) return direct;
          if (Array.isArray(obj[key])) { const nested = (obj[key] as unknown[]).flatMap(segment => {
            if (typeof segment !== "object" || segment === null) return [];
            const s = segment as Record<string, unknown>; return parseArray(s.points ?? s.path ?? s.coordinates);
          }); if (nested.length > 1) return nested; }
        }
      }
      if (Array.isArray(obj.sections)) {
        const nested = obj.sections.flatMap(s => typeof s === "object" && s !== null ? parseArray((s as Record<string, unknown>).points ?? (s as Record<string, unknown>).path) : []);
        if (nested.length > 1) return nested;
      }
    }
    return [];
  }

  async function traceWithSAM2(overrideGuides?: Point[]) {
    if (!imageUrl || points.length < 2) {
      setMessage("Upload a photo and click at least two guide points.");
      return;
    }

    setIsTracing(true);
    setCalibrationResult(null);
    setMessage("Running SAM2 V8 on your photograph. Please wait...");

    try {
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        throw new Error("Cannot read the selected photograph.");
      }

      const imageBlob = await imageResponse.blob();
      if (imageBlob.size > 15 * 1024 * 1024) {
        throw new Error("Processed photograph exceeds 15 MB.");
      }

      const formData = new FormData();
      formData.append("image", imageBlob, "vine-photo.png");
      const updatedGuides = overrideGuides ?? (isEditingRoute ? draftGuides : points);
      formData.append("guide_points", JSON.stringify(updatedGuides));

      const response = await fetch(`${API_BASE_URL}/api/vine/trace`, {
        method: "POST",
        body: formData,
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          typeof result.detail === "string"
            ? result.detail
            : `SAM2 tracing failed: HTTP ${response.status}`
        );
      }

      const segments = parseV8Segments(result);
      if (!segments) {
        throw new Error("SAM2 returned no valid segments.");
      }

      const route = segments.flat();

      setRouteSegments(segments);
      setRouteData(route);
      setPoints(updatedGuides);
      setDraftGuides([]);
      setCorrectionPoints([]);
      setSectionCorrections({});
      setSelectedSection(null);
      setIsEditingRoute(false);

      setMessage(
        `SAM2 V8 completed: ${segments.length} segments, ` +
        `${route.length} route points. Review the orange trace, ` +
        `then calculate its length with ArUco.`
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "SAM2 tracing failed."
      );
    } finally {
      setIsTracing(false);
    }
  }

  async function calculateWithBackend() {
    if (!imageUrl || displayPoints.length < 2) {
      setMessage("Upload a photograph and add at least two route points.");
      return;
    }

    const markerSize = Number(markerSizeCm);
    if (!Number.isFinite(markerSize) || markerSize <= 0) {
      setMessage("Enter a valid positive ArUco marker size.");
      return;
    }

    setIsCalculating(true);
    setCalibrationResult(null);
    setMessage("");

    try {
      const imageResponse = await fetch(imageUrl);
      const imageBlob = await imageResponse.blob();

      if (imageBlob.size > 15 * 1024 * 1024) {
        throw new Error("Processed photograph exceeds 15 MB.");
      }

      const formData = new FormData();
      formData.append("image", imageBlob, "vine-photo.png");
      formData.append(
        "ordered_points",
        JSON.stringify(routeSegments ? { segments_xy: routeSegments.map(
          segment => segment.map(p => [p.x, p.y])
        ) } : displayPoints)
      );
      formData.append("marker_size_cm", String(markerSize));
      formData.append("vine_id", vineId.trim() || "Unassigned");

      const response = await fetch(`${API_BASE_URL}/api/vine/measure`, {
        method: "POST",
        body: formData,
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          typeof result.detail === "string"
            ? result.detail
            : `Backend error: HTTP ${response.status}`
        );
      }

      setCalibrationResult(result);
      setMessage("Measurement calculated successfully using FastAPI and ArUco.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Measurement failed.");
    } finally {
      setIsCalculating(false);
    }
  }

  function parseV8Segments(value: unknown): Point[][] | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const raw = (value as Record<string, unknown>).segments_xy;
    if (!Array.isArray(raw)) return null;

    const segments: Point[][] = [];
    for (const segment of raw) {
      if (!Array.isArray(segment)) throw new Error("Invalid V8 segment.");
      const parsed: Point[] = [];
      for (const p of segment) {
        if (!Array.isArray(p) || p.length !== 2 ||
            !p.every(v => typeof v === "number" && Number.isFinite(v))) {
          throw new Error("Invalid V8 coordinate.");
        }
        parsed.push({ x: p[0], y: p[1] });
      }
      if (parsed.length >= 2) segments.push(parsed);
    }
    if (!segments.length) throw new Error("No valid V8 segments found.");
    return segments;
  }

  async function importRoute(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";

    try {
      const data: unknown = JSON.parse(await file.text());
      const segments = parseV8Segments(data);
      const parsed = segments ? segments.flat() : extractPoints(data);

      if (parsed.length < 2) {
        throw new Error("No valid ordered coordinates found.");
      }
      if (parsed.length > 100000) {
        throw new Error("Route exceeds 100000 points.");
      }

      setRouteSegments(segments);
      setRouteData(parsed);
      setPoints([]);
      setCalibrationResult(null);
      setMessage(
        segments
          ? `Imported ${segments.length} V8 segments (${parsed.length} points). Review alignment with the photograph.`
          : `Imported ${parsed.length} route points. Review alignment with the photograph.`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Invalid route JSON.");
    }
  }

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-widest text-secondary">Field measurement</p><h2 className="mt-1 text-2xl font-bold text-text-primary">Measure a vanilla vine</h2><p className="mt-1 text-sm text-text-secondary">Touch-friendly route review · projected 2D length</p></div><span className="rounded-full bg-warn-soft px-3 py-1.5 text-xs font-semibold text-warn">Prototype · not calibrated</span></div>
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]">
      <Card><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Photograph & route</h3><span className="text-xs text-text-secondary">{imageName || "No photo selected"}</span></div>
        <div className="relative flex min-h-64 items-center justify-center overflow-hidden rounded-xl border border-dashed border-border-light bg-surface">
          {imageUrl ? <div className="relative inline-block max-w-full">
            {/* eslint-disable-next-line @next/next/no-img-element -- Local blob image requires native pointer coordinates for vine tracing. */}
            <img 
              ref={imageRef} 
              src={imageUrl} alt="Uploaded vanilla vine photograph" draggable={false} onLoad={e => setNaturalSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} onPointerDown={onPointerDown} className={`block max-h-[72vh] max-w-full select-none object-contain ${routeData && !isEditingRoute ? "cursor-default" : "cursor-crosshair touch-manipulation"}`} />
            <svg
              viewBox={`0 0 ${naturalSize.width} ${naturalSize.height}`}
              className="pointer-events-none absolute inset-0 h-full w-full"
              aria-label="Vine route overlay"
            >
              {/* COLOR_CODED_VINE_SECTIONS_V1 */}
              {(routeSegments ?? [displayPoints]).map((segment, i) => {
                const colors = [
                  "#f97316", "#2563eb", "#16a34a",
                  "#a855f7", "#e11d48", "#0891b2",
                  "#ca8a04", "#4f46e5"
                ];
                const color = isEditingRoute && routeSegments
                  ? colors[i % colors.length]
                  : "#f97316";

                const selected = isEditingRoute &&
                  selectedSection === i;

                const middle = segment[Math.floor(segment.length / 2)];

                return (
                  <g key={i}>
                    <polyline
                      points={segment.map(p => `${p.x},${p.y}`).join(" ")}
                      fill="none"
                      stroke="#ffffff"
                      strokeWidth={selected ? 10 : 6}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                    <polyline
                      points={segment.map(p => `${p.x},${p.y}`).join(" ")}
                      fill="none"
                      stroke={color}
                      strokeWidth={selected ? 6 : 3}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      opacity={isEditingRoute &&
                        selectedSection !== null &&
                        !selected ? 0.45 : 1}
                    />
                    {isEditingRoute && routeSegments && middle && (
                      <g>
                        <circle
                          cx={middle.x}
                          cy={middle.y}
                          r={selected ? 15 : 12}
                          fill={color}
                          stroke="#ffffff"
                          strokeWidth="2"
                        />
                        <text
                          x={middle.x}
                          y={middle.y + 4}
                          textAnchor="middle"
                          fill="#ffffff"
                          fontSize="12"
                          fontWeight="bold"
                        >
                          {i + 1}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}

              {isEditingRoute &&
                Object.entries(sectionCorrections).map(([section, p]) => (
                  <g key={`correction-${section}`}>
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r="8"
                      fill="#dc2626"
                      stroke="#ffffff"
                      strokeWidth="3"
                    />
                    <circle cx={p.x} cy={p.y} r="2" fill="#ffffff" />
                  </g>
                ))}

              {!routeData && points.map((p, i) => (
                <g key={i}>
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r="5"
                    fill="#d946ef"
                    stroke="#ffffff"
                    strokeWidth="1.5"
                  />
                </g>
              ))}
            </svg></div> : <label className="flex cursor-pointer flex-col items-center gap-3 px-5 py-14 text-center"><ImagePlus className="text-secondary" size={36}/><span className="font-medium">Select a field photograph</span><span className="text-sm text-text-secondary">JPEG, PNG or WebP</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={onImageUpload} className="sr-only"/></label>}
        </div>
        <div className="mt-3 flex flex-wrap gap-2"><label className="cursor-pointer rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white"><ImagePlus size={15} className="mr-2 inline"/>Choose photo<input type="file" accept="image/jpeg,image/png,image/webp" onChange={onImageUpload} className="sr-only"/></label><label className="cursor-pointer rounded-xl border border-border-light bg-white px-4 py-2.5 text-sm font-medium"><Download size={15} className="mr-2 inline"/>Import V8 route JSON<input type="file" accept="application/json,.json" onChange={importRoute} className="sr-only"/></label><button type="button" onClick={() => { if (routeData) { setRouteData(null); setRouteSegments(null); } else setPoints(p => p.slice(0, -1)); setCalibrationResult(null); }} className="rounded-xl border border-border-light px-3 py-2.5 text-sm" aria-label="Undo last waypoint"><Undo2 size={16}/></button><button type="button" onClick={() => { setPoints([]); setRouteData(null); setRouteSegments(null); setCalibrationResult(null); }} className="rounded-xl border border-border-light px-3 py-2.5 text-sm" aria-label="Clear route"><RotateCcw size={16}/></button></div>
        <p className="mt-3 text-xs leading-relaxed text-text-secondary">Tap guide points along the actual vine in growth order, including turnarounds. Click <strong>Trace Vine with SAM2 V8</strong> to generate a route automatically. The imported JSON option is available only as a fallback.</p>
      </Card>
      <div className="space-y-5"><Card><h3 className="font-semibold">Measurement details</h3><div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1"><label className="block text-sm font-medium">Vine ID<input value={vineId} onChange={e => setVineId(e.target.value)} className="mt-1.5 w-full rounded-xl border border-border-light p-3 outline-secondary"/></label><label className="block text-sm font-medium">Observation date<input type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1.5 w-full rounded-xl border border-border-light p-3 outline-secondary"/></label></div></Card>
        
<Card>
  <h3 className="font-semibold">ArUco calibration</h3>
  {routeData && !isEditingRoute && points.length >= 2 && (
    <button
      type="button"
      onClick={() => {
        if (!routeSegments || routeSegments.length !== points.length - 1) {
          setMessage("This route cannot be corrected without matching guide points.");
          return;
        }
        setDraftGuides([...points]);
        setCorrectionPoints([]);
        setSectionCorrections({});
        setSelectedSection(null);
        setIsEditingRoute(true);
        setMessage("Select a section, then click the correct vine location.");
      }}
      disabled={isTracing || isCalculating}
      className="mt-3 w-full rounded-xl border border-secondary px-4 py-3 text-sm font-semibold text-secondary disabled:opacity-40"
    >
      Edit SAM2 Route
    </button>
  )}

  {isEditingRoute && (
    <div className="mt-3 space-y-3 rounded-xl border border-border-light p-3">
      <p className="text-sm font-semibold">Edit SAM2 route sections</p>
      <p className="text-xs text-text-secondary">
        Sections are color-coded on the photograph. Select a section,
        then click its correct vine location. You can correct several
        sections before running SAM2.
      </p>

      <label className="block text-sm">
        Route section
        <select
          value={selectedSection === null ? "auto" : String(selectedSection)}
          onChange={e => setSelectedSection(
            e.target.value === "auto" ? null : Number(e.target.value)
          )}
          disabled={isTracing}
          className="mt-1 w-full rounded-xl border border-border-light p-2"
        >
          <option value="auto">Automatically select nearest section</option>
          {routeSegments?.map((_, index) => (
            <option key={index} value={index}>
              Section {index + 1}
              {sectionCorrections[index] ? " — corrected" : ""}
            </option>
          ))}
        </select>
      </label>

      <p className="text-sm">
        Pending corrections: {Object.keys(sectionCorrections).length}
      </p>

      <div className="space-y-2">
        {Object.entries(sectionCorrections)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([section, point]) => (
            <div
              key={section}
              className="flex items-center justify-between gap-2 rounded-lg border p-2 text-xs"
            >
              <span>
                Section {Number(section) + 1}: ({point.x}, {point.y})
              </span>
              <button
                type="button"
                onClick={() => {
                  const next = { ...sectionCorrections };
                  delete next[Number(section)];
                  setSectionCorrections(next);
                  setCorrectionPoints(Object.values(next));
                  const updated: Point[] = [];
                  for (let i = 0; i < points.length - 1; i++) {
                    updated.push(points[i]);
                    if (next[i]) updated.push(next[i]);
                  }
                  updated.push(points[points.length - 1]);
                  setDraftGuides(updated);
                }}
                disabled={isTracing}
                className="rounded-lg border px-2 py-1"
              >
                Remove
              </button>
            </div>
          ))}
      </div>

      <button
        type="button"
        onClick={() => void traceWithSAM2(draftGuides)}
        disabled={isTracing || Object.keys(sectionCorrections).length === 0}
        className="w-full rounded-xl bg-secondary px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
      >
        {isTracing ? "SAM2 V8 is rerouting..." : "Apply Corrections & Reroute"}
      </button>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            setSectionCorrections({});
            setCorrectionPoints([]);
            setDraftGuides([...points]);
            setMessage("Pending corrections cleared.");
          }}
          disabled={isTracing || Object.keys(sectionCorrections).length === 0}
          className="rounded-xl border px-3 py-2 text-sm disabled:opacity-40"
        >
          Clear corrections
        </button>
        <button
          type="button"
          onClick={() => {
            setSectionCorrections({});
            setCorrectionPoints([]);
            setDraftGuides([]);
            setSelectedSection(null);
            setIsEditingRoute(false);
            setMessage("Route correction cancelled.");
          }}
          disabled={isTracing}
          className="rounded-xl border px-3 py-2 text-sm disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </div>
  )}

  <button
    type="button"
    onClick={() => void traceWithSAM2()}
    disabled={isTracing || isCalculating || isEditingRoute || !imageUrl || points.length < 2}
    className="mt-3 w-full rounded-xl bg-secondary px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
  >
    {isTracing ? "SAM2 V8 is tracing..." : "Trace Vine with SAM2 V8"}
  </button>
  <p className="mt-2 text-xs text-text-secondary">
    Upload a photograph and select guide points in vine growth order.
    SAM2 V8 will generate the route automatically.
  </p>
  <label className="mt-3 block text-sm font-medium">
    Marker side length (cm)
    <input
      type="number"
      min="0.01"
      step="0.01"
      value={markerSizeCm}
      onChange={e => setMarkerSizeCm(e.target.value)}
      className="mt-1.5 w-full rounded-xl border border-border-light p-3"
    />
  </label>
  <button
    type="button"
    onClick={calculateWithBackend}
    disabled={isCalculating || isTracing || isEditingRoute || !imageUrl || displayPoints.length < 2}
    className="mt-4 w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
  >
    {isCalculating ? "Calculating..." : "Calculate Vine Length with ArUco"}
  </button>
  {calibrationResult && (
    <div className="mt-3 rounded-xl bg-surface p-3">
      <p className="text-sm font-semibold">
        {calibrationResult.estimated_length_cm.toFixed(2)} cm
        {" "}({calibrationResult.estimated_length_m.toFixed(4)} m)
      </p>
      <p className="mt-1 text-xs text-text-secondary">
        ArUco marker ID: {calibrationResult.marker_id}
      </p>
      <p className="mt-2 text-xs text-text-secondary">
        {calibrationResult.warning}
      </p>
    </div>
  )}
  <p className="mt-2 text-xs text-text-secondary">
    Use manual points or run SAM2 V8, then calculate the 2D projected length.
  </p>
</Card>

<Card><p className="text-sm text-text-secondary">Estimated projected vine length</p><p className="mt-1 text-3xl font-bold tabular-nums text-primary">{pixels.toLocaleString(undefined, { maximumFractionDigits: 2 })} <span className="text-base font-medium">px</span></p><div className="mt-4 grid grid-cols-2 gap-3 text-sm"><div className="rounded-xl bg-surface p-3"><p className="text-text-secondary">Route points</p><p className="mt-1 text-xl font-bold">{displayPoints.length}</p></div><div className="rounded-xl bg-surface p-3"><p className="text-text-secondary">Length in cm</p><p className="mt-1 font-semibold">
  {calibrationResult
    ? `${calibrationResult.estimated_length_cm.toFixed(2)} cm`
    : "Unavailable"}
</p></div></div><p className="mt-3 text-xs text-text-secondary">Physical measurement requires image calibration. Perspective and occlusion can affect the estimate.</p><div className="mt-4 grid gap-3 sm:grid-cols-3">
  <label className="block text-sm font-medium">Zone
    <select value={zone} onChange={e => setZone(e.target.value as "A" | "B" | "C" | "D")} className="mt-1 w-full rounded-xl border border-border-light bg-white p-2.5">
      {(["A", "B", "C", "D"] as const).map(z => <option key={z} value={z}>Zone {z}</option>)}
    </select>
  </label>
  <label className="block text-sm font-medium">Block number
    <input value={blockNumber} onChange={e => setBlockNumber(e.target.value)} placeholder="01" className="mt-1 w-full rounded-xl border border-border-light p-2.5" />
  </label>
  <label className="block text-sm font-medium">Plant number
    <input value={plantNumber} onChange={e => setPlantNumber(e.target.value)} placeholder="001" className="mt-1 w-full rounded-xl border border-border-light p-2.5" />
  </label>
</div><div className="mt-4 flex flex-wrap gap-2"><button onClick={save} className="flex items-center gap-2 rounded-xl bg-secondary px-4 py-2.5 text-sm font-semibold text-white"><Check size={16}/>Save locally</button><button onClick={exportJSON} disabled={displayPoints.length < 2} className="flex items-center gap-2 rounded-xl border border-border-light px-4 py-2.5 text-sm font-semibold disabled:opacity-40"><Download size={16}/>Export JSON</button></div></Card>
      </div>
    </div>
    {message && <p role="status" className="rounded-xl border border-border-light bg-white px-4 py-3 text-sm text-text-secondary">{message}</p>}
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Recent measurements on this device</h3>
        <span className="text-xs text-text-secondary">Browser storage · demo only</span>
      </div>
      {measurements.length === 0 ? <p className="text-sm text-text-secondary">No measurements saved yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[740px] text-left text-sm">
            <thead className="text-text-secondary"><tr>
              <th className="pb-3">Zone / Block / Plant</th>
              <th className="pb-3">Vine</th>
              <th className="pb-3">Date</th>
              <th className="pb-3">Projected length</th>
              <th className="pb-3">Status</th>
              <th className="pb-3 text-right">Delete</th>
            </tr></thead>
            <tbody>{measurements.map(m => (
              <tr key={m.id} className="border-t border-border-light">
                <td className="py-3">{m.zone && m.blockNumber && m.plantNumber ? `${m.zone} / ${m.blockNumber} / ${m.plantNumber}` : "Not assigned"}</td>
                <td className="font-medium">{m.vineId}</td>
                <td>{m.date}</td>
                <td>{typeof m.lengthCm === "number" && Number.isFinite(m.lengthCm) ? `${m.lengthCm.toFixed(2)} cm` : `${m.pixelLength.toFixed(2)} px (uncalibrated)`}</td>
                <td className="text-xs text-text-secondary">{m.status}</td>
                <td className="text-right">
                  <button type="button" aria-label={`Delete measurement for ${m.vineId} on ${m.date}`} title="Delete measurement" onClick={() => deleteMeasurement(m.id)} className="rounded-lg p-2 text-red-600 hover:bg-red-50"><Trash2 size={17}/></button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Card>
  </div>;
}
