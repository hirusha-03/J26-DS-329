"use client";

import { useEffect, useMemo, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const STORAGE_KEY = "vanilla-vine-measurements-demo-v1";
type SavedMeasurement = {
  id: string;
  date: string;
  vineId: string;
  pixelLength: number;
  lengthCm?: number;
  zone?: string;
  blockNumber?: string;
  plantNumber?: string;
};

function readSavedMeasurements(): SavedMeasurement[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value as SavedMeasurement[] : [];
  } catch {
    return [];
  }
}

export default function GrowthForecast() {
  const [measurements, setMeasurements] = useState<SavedMeasurement[]>([]);
  const [zone, setZone] = useState("A");
  const [blockNumber, setBlockNumber] = useState("");
  const [plantNumber, setPlantNumber] = useState("");

  useEffect(() => {
    const refresh = () => setMeasurements(readSavedMeasurements());
    queueMicrotask(refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const calibrated = useMemo(() => measurements.filter(m =>
    typeof m.lengthCm === "number" && Number.isFinite(m.lengthCm) && m.lengthCm > 0 &&
    m.zone && m.blockNumber && m.plantNumber && /^\d{4}-\d{2}-\d{2}$/.test(m.date)
  ), [measurements]);

  const blocks = useMemo(() => [...new Set(calibrated.filter(m => m.zone === zone).map(m => m.blockNumber!))].sort(), [calibrated, zone]);
  const plants = useMemo(() => [...new Set(calibrated.filter(m => m.zone === zone && m.blockNumber === blockNumber).map(m => m.plantNumber!))].sort(), [calibrated, zone, blockNumber]);

  const selected = useMemo(() => calibrated.filter(m =>
    m.zone === zone && m.blockNumber === blockNumber && m.plantNumber === plantNumber
  ).sort((a, b) => a.date.localeCompare(b.date)), [calibrated, zone, blockNumber, plantNumber]);

  // For repeated measurements on one date, use the most recently saved record.
  const observations = useMemo(() => {
    const byDate = new Map<string, SavedMeasurement>();
    for (const item of selected) byDate.set(item.date, item);
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [selected]);

  const first = observations[0];
  const last = observations[observations.length - 1];
  const dayMs = 24 * 60 * 60 * 1000;
  const elapsedDays = first && last ? (Date.parse(`${last.date}T00:00:00Z`) - Date.parse(`${first.date}T00:00:00Z`)) / dayMs : 0;
  const weeklySlope = first && last && elapsedDays > 0 ? ((last.lengthCm! - first.lengthCm!) / elapsedDays) * 7 : 0;
  const canForecast = observations.length >= 2 && elapsedDays > 0;
  const data: { week: string; observed?: number; estimate?: number }[] = observations.map(m => ({
    week: m.date, observed: m.lengthCm,
  }));
  if (canForecast && last) {
    data[data.length - 1].estimate = last.lengthCm;
    for (let week = 1; week <= 4; week++) {
      data.push({ week: `+${week}w`, estimate: Math.max(0, last.lengthCm! + weeklySlope * week) });
    }
  }
  const forecastWeek4 = canForecast && last ? Math.max(0, last.lengthCm! + weeklySlope * 4) : null;

  return <div className="space-y-5">
    <div>
      <p className="text-xs font-semibold uppercase tracking-widest text-secondary">Growth outlook</p>
      <h2 className="mt-1 text-2xl font-bold">Four-week vine-length forecast</h2>
      <p className="mt-1 text-sm text-text-secondary">Vine length means total projected length along the vine, not vertical height.</p>
    </div>
    <div className="rounded-2xl border border-warn/20 bg-warn-soft p-4 text-sm text-warn">
      <strong>Demonstration only:</strong> This uses linear extrapolation of calibrated measurements saved on this device. It is not a trained forecasting model; no prediction accuracy or confidence interval is implied.
    </div>
    <div className="grid gap-5 lg:grid-cols-[minmax(250px,0.7fr)_minmax(0,1.3fr)]">
      <section className="rounded-2xl border border-border-light bg-white p-5">
        <h3 className="font-semibold">Select a plant</h3>
        <p className="mt-1 text-xs text-text-secondary">Choose a zone, block and plant to load its saved calibrated measurements.</p>
        <label className="mt-4 block text-sm font-medium">Zone
          <select value={zone} onChange={e => { setZone(e.target.value); setBlockNumber(""); setPlantNumber(""); }} className="mt-2 w-full rounded-xl border border-border-light bg-white p-3">
            {(["A", "B", "C", "D"] as const).map(z => <option key={z} value={z}>Zone {z}</option>)}
          </select>
        </label>
        <label className="mt-4 block text-sm font-medium">Block number
          <select value={blockNumber} onChange={e => { setBlockNumber(e.target.value); setPlantNumber(""); }} className="mt-2 w-full rounded-xl border border-border-light bg-white p-3">
            <option value="">Select block</option>
            {blocks.map(b => <option key={b} value={b}>Block {b}</option>)}
          </select>
        </label>
        <label className="mt-4 block text-sm font-medium">Plant number
          <select value={plantNumber} onChange={e => setPlantNumber(e.target.value)} className="mt-2 w-full rounded-xl border border-border-light bg-white p-3" disabled={!blockNumber}>
            <option value="">Select plant</option>
            {plants.map(p => <option key={p} value={p}>Plant {p}</option>)}
          </select>
        </label>
        <p className="mt-4 text-xs text-text-secondary">{selected.length} saved calibrated record(s) for this plant. Older pixel-only measurements cannot be used in a centimetre forecast.</p>
        <div className="mt-4 rounded-xl bg-surface p-3">
          <p className="text-xs font-semibold">Measurement history</p>
          {observations.length === 0 ? <p className="mt-2 text-sm text-text-secondary">No calibrated measurements for this selection.</p> : (
            <ul className="mt-2 space-y-1 text-sm">{observations.map(m => <li key={m.date} className="flex justify-between gap-3"><span>{m.date}</span><span className="font-medium">{m.lengthCm!.toFixed(2)} cm</span></li>)}</ul>
          )}
        </div>
      </section>
      <section className="min-w-0 rounded-2xl border border-border-light bg-white p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h3 className="font-semibold">Projected vine-length trend</h3><p className="text-xs text-text-secondary">{zone} / {blockNumber || "—"} / {plantNumber || "—"} · four weeks ahead · illustrative trend</p></div>
          <span className="rounded-full bg-surface px-3 py-1 text-xs text-text-secondary">cm</span>
        </div>
        {!canForecast ? <p className="py-16 text-center text-sm text-text-secondary">Select a plant with at least two calibrated measurements on different dates to preview the trend.</p> : (
          <div className="mt-5 h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 5, right: 10, left: -15, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb"/>
                <XAxis dataKey="week" tick={{ fontSize: 11 }}/>
                <YAxis tick={{ fontSize: 12 }}/>
                <Tooltip formatter={(value, name) => [`${Number(value).toFixed(2)} cm`, name === "observed" ? "Observed" : "Illustrative projection"]}/>
                <Area type="monotone" dataKey="estimate" stroke="#d97706" fill="#fef3c7" strokeWidth={2} connectNulls/>
                <Line type="monotone" dataKey="observed" stroke="#2c694e" strokeWidth={3} dot={{ r: 3 }} connectNulls/>
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-surface p-3"><p className="text-xs text-text-secondary">Latest observation</p><p className="mt-1 text-lg font-bold">{last?.lengthCm?.toFixed(1) ?? "—"} cm</p></div>
          <div className="rounded-xl bg-surface p-3"><p className="text-xs text-text-secondary">Illustrative week +4</p><p className="mt-1 text-lg font-bold">{forecastWeek4 === null ? "—" : forecastWeek4.toFixed(1)} cm</p></div>
        </div>
      </section>
    </div>
    <section className="rounded-2xl border border-border-light bg-white p-5">
      <h3 className="font-semibold">What the production forecast needs</h3>
      <p className="mt-2 text-sm leading-6 text-text-secondary">Repeated calibrated measurements of the same identified vine, reliable observation dates, missing-data handling, a validated forecasting model, and an API for predictions. The current extrapolation uses the change between the first and last observations divided by elapsed time; irregular measurements and noise may make this trend unreliable.</p>
    </section>
  </div>;
}
