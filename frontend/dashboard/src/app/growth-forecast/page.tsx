"use client";

import { useState } from "react";
import { Camera, ChartNoAxesCombined } from "lucide-react";
import VineWorkspace from "@/components/vine-growth/VineWorkspace";
import GrowthForecast from "@/components/vine-growth/GrowthForecast";

export default function GrowthForecastPage() {
  const [tab, setTab] = useState<"measure" | "forecast">("measure");
  return <div className="mx-auto max-w-7xl space-y-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-widest text-secondary">Vanilla Monitor / Growth</p><h1 className="mt-1 text-2xl font-bold text-text-primary sm:text-3xl">Vine Growth & Forecasting</h1><p className="mt-1 text-sm text-text-secondary">Trace, measure and explore future vine length.</p></div></div><div role="tablist" aria-label="Vine growth tools" className="flex w-full gap-2 rounded-2xl bg-white p-1.5 shadow-sm sm:w-fit"><button role="tab" aria-selected={tab === "measure"} onClick={() => setTab("measure")} className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold sm:flex-none ${tab === "measure" ? "bg-primary text-white" : "text-text-secondary hover:bg-surface"}`}><Camera size={17}/>Measure</button><button role="tab" aria-selected={tab === "forecast"} onClick={() => setTab("forecast")} className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold sm:flex-none ${tab === "forecast" ? "bg-primary text-white" : "text-text-secondary hover:bg-surface"}`}><ChartNoAxesCombined size={17}/>4-week forecast</button></div>{tab === "measure" ? <VineWorkspace/> : <GrowthForecast/>}</div>;
}
