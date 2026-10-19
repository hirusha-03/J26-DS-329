"use client";

import { ChangeEvent, PointerEvent, useEffect, useRef, useState } from "react";
import { Check, Download, ImagePlus, RotateCcw, Undo2 } from "lucide-react";

type Point = { x: number; y: number };
type SavedMeasurement = { id: string; date: string; vineId: string; pixelLength: number; clicks: number; status: string };
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
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [measurements, setMeasurements] = useState<SavedMeasurement[]>([]);
  const [message, setMessage] = useState("");
  const [routeData, setRouteData] = useState<Point[] | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);

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
  const pixels = lengthOf(displayPoints);
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
    if (!imageRef.current || routeData) return;
    const bounds = imageRef.current.getBoundingClientRect();
    const x = Math.min(naturalSize.width, Math.max(0, (event.clientX - bounds.left) / bounds.width * naturalSize.width));
    const y = Math.min(naturalSize.height, Math.max(0, (event.clientY - bounds.top) / bounds.height * naturalSize.height));
    setPoints(prev => [...prev, { x: Math.round(x), y: Math.round(y) }]); setMessage("");
  }
  function save() {
    if (displayPoints.length < 2) { setMessage("Add at least two points or import an ordered route before saving."); return; }
    const item: SavedMeasurement = { id: crypto.randomUUID(), date, vineId: vineId.trim() || "Unassigned", pixelLength: Number(pixels.toFixed(2)), clicks: routeData ? 0 : points.length, status: routeData ? "Imported V8 route — review required" : "Manual polyline — review required" };
    const next = [item, ...measurements].slice(0, 100); setMeasurements(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); setMessage("Saved locally in this browser. This is not yet stored in the team backend."); } catch { setMessage("Could not save in browser storage."); }
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
  async function importRoute(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const data: unknown = JSON.parse(await file.text()); const parsed = extractPoints(data);
      if (parsed.length < 2) throw new Error("Could not find an ordered coordinate list. Check your V8 JSON structure.");
      setRouteData(parsed); setPoints([]); setMessage(`Imported ${parsed.length} ordered coordinates. Confirm alignment with the uploaded photo.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to read JSON route."); }
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
              src={imageUrl} alt="Uploaded vanilla vine photograph" draggable={false} onLoad={e => setNaturalSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} onPointerDown={onPointerDown} className={`block max-h-[72vh] max-w-full select-none object-contain ${routeData ? "cursor-default" : "cursor-crosshair touch-manipulation"}`} />
            <svg viewBox={`0 0 ${naturalSize.width} ${naturalSize.height}`} className="pointer-events-none absolute inset-0 h-full w-full" aria-label="Vine route overlay"><polyline points={displayPoints.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#ffffff" strokeWidth="5" strokeLinejoin="round" strokeLinecap="round"/><polyline points={displayPoints.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#f97316" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round"/>{!routeData && points.map((p, i) => <g key={i}><circle cx={p.x} cy={p.y} r="5" fill="#d946ef" stroke="white" strokeWidth="1.5"/></g>)}</svg></div> : <label className="flex cursor-pointer flex-col items-center gap-3 px-5 py-14 text-center"><ImagePlus className="text-secondary" size={36}/><span className="font-medium">Select a field photograph</span><span className="text-sm text-text-secondary">JPEG, PNG or WebP</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={onImageUpload} className="sr-only"/></label>}
        </div>
        <div className="mt-3 flex flex-wrap gap-2"><label className="cursor-pointer rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white"><ImagePlus size={15} className="mr-2 inline"/>Choose photo<input type="file" accept="image/jpeg,image/png,image/webp" onChange={onImageUpload} className="sr-only"/></label><label className="cursor-pointer rounded-xl border border-border-light bg-white px-4 py-2.5 text-sm font-medium"><Download size={15} className="mr-2 inline"/>Import V8 route JSON<input type="file" accept="application/json,.json" onChange={importRoute} className="sr-only"/></label><button type="button" onClick={() => { if (routeData) setRouteData(null); else setPoints(p => p.slice(0, -1)); }} className="rounded-xl border border-border-light px-3 py-2.5 text-sm" aria-label="Undo last waypoint"><Undo2 size={16}/></button><button type="button" onClick={() => { setPoints([]); setRouteData(null); }} className="rounded-xl border border-border-light px-3 py-2.5 text-sm" aria-label="Clear route"><RotateCcw size={16}/></button></div>
        <p className="mt-3 text-xs leading-relaxed text-text-secondary">Tap along the actual vine in growth order, including all turnarounds. Manual taps create a straight-segment polyline, <strong>not automatic SAM2 tracing</strong>. To view a V8 result, import its ordered-route JSON alongside the corresponding photograph.</p>
      </Card>
      <div className="space-y-5"><Card><h3 className="font-semibold">Measurement details</h3><div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1"><label className="block text-sm font-medium">Vine ID<input value={vineId} onChange={e => setVineId(e.target.value)} className="mt-1.5 w-full rounded-xl border border-border-light p-3 outline-secondary"/></label><label className="block text-sm font-medium">Observation date<input type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1.5 w-full rounded-xl border border-border-light p-3 outline-secondary"/></label></div></Card>
        <Card><p className="text-sm text-text-secondary">Estimated projected vine length</p><p className="mt-1 text-3xl font-bold tabular-nums text-primary">{pixels.toLocaleString(undefined, { maximumFractionDigits: 2 })} <span className="text-base font-medium">px</span></p><div className="mt-4 grid grid-cols-2 gap-3 text-sm"><div className="rounded-xl bg-surface p-3"><p className="text-text-secondary">Route points</p><p className="mt-1 text-xl font-bold">{displayPoints.length}</p></div><div className="rounded-xl bg-surface p-3"><p className="text-text-secondary">Length in cm</p><p className="mt-1 font-semibold">Unavailable</p></div></div><p className="mt-3 text-xs text-text-secondary">Physical measurement requires image calibration. Perspective and occlusion can affect the estimate.</p><div className="mt-4 flex flex-wrap gap-2"><button onClick={save} className="flex items-center gap-2 rounded-xl bg-secondary px-4 py-2.5 text-sm font-semibold text-white"><Check size={16}/>Save locally</button><button onClick={exportJSON} disabled={displayPoints.length < 2} className="flex items-center gap-2 rounded-xl border border-border-light px-4 py-2.5 text-sm font-semibold disabled:opacity-40"><Download size={16}/>Export JSON</button></div></Card>
      </div>
    </div>
    {message && <p role="status" className="rounded-xl border border-border-light bg-white px-4 py-3 text-sm text-text-secondary">{message}</p>}
    <Card><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Recent measurements on this device</h3><span className="text-xs text-text-secondary">Browser storage · demo only</span></div>{measurements.length === 0 ? <p className="text-sm text-text-secondary">No measurements saved yet.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[540px] text-left text-sm"><thead className="text-text-secondary"><tr><th className="pb-3">Vine</th><th className="pb-3">Date</th><th className="pb-3">Projected length</th><th className="pb-3">Status</th></tr></thead><tbody>{measurements.map(m => <tr key={m.id} className="border-t border-border-light"><td className="py-3 font-medium">{m.vineId}</td><td>{m.date}</td><td>{m.pixelLength.toFixed(2)} px</td><td className="text-xs text-text-secondary">{m.status}</td></tr>)}</tbody></table></div>}</Card>
  </div>;
}
