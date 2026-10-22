"use client";

import { useEffect, useMemo, useState } from "react";
import FieldPlan from "@/components/overview/FieldPlan";
import HotspotChecks from "@/components/overview/HotspotChecks";
import CycleChanges from "@/components/overview/CycleChanges";
import DataTrust from "@/components/overview/DataTrust";
import ModuleStatus from "@/components/overview/ModuleStatus";
import Section, { SectionError, SectionLoading, type Load } from "@/components/overview/Section";
import { buildCycleChanges, type TrendRow } from "@/lib/overview/cycleChanges";
import {
  checkAdvisory,
  checkDisease,
  loadPlants,
  loadTrends,
  type ModuleHealth,
  type ModuleKey,
  type PlantData,
} from "@/lib/overview/data";
import { buildDataTrust } from "@/lib/overview/dataTrust";
import { buildFieldPlan } from "@/lib/overview/fieldPlan";

const message = (err: unknown) => (err instanceof Error ? err.message : "Could not load data.");
const checking: ModuleHealth = { state: "checking", detail: "Checking…" };

export default function OverviewPage() {
  const [plants, setPlants] = useState<Load<PlantData>>({ kind: "loading" });
  const [trends, setTrends] = useState<Load<TrendRow[]>>({ kind: "loading" });
  const [disease, setDisease] = useState<ModuleHealth>(checking);
  const [advisory, setAdvisory] = useState<ModuleHealth>(checking);

  useEffect(() => {
    let active = true;
    loadPlants()
      .then((data) => active && setPlants({ kind: "ok", data }))
      .catch((err) => active && setPlants({ kind: "error", message: message(err) }));
    loadTrends()
      .then((data) => active && setTrends({ kind: "ok", data }))
      .catch((err) => active && setTrends({ kind: "error", message: message(err) }));
    checkDisease().then((h) => active && setDisease(h));
    checkAdvisory().then((h) => active && setAdvisory(h));
    return () => {
      active = false;
    };
  }, []);

  const plan = useMemo(() => (plants.kind === "ok" ? buildFieldPlan(plants.data.plants, plants.data.hotspots) : []), [plants]);
  const trust = useMemo(() => (plants.kind === "ok" ? buildDataTrust(plants.data.plants) : null), [plants]);
  const changes = useMemo(
    () => (trends.kind === "ok" ? buildCycleChanges(trends.data, plants.kind === "ok" ? plants.data.hotspots : []) : null),
    [trends, plants],
  );

  const twin: ModuleHealth =
    plants.kind === "loading"
      ? checking
      : plants.kind === "error"
        ? { state: "offline", detail: "Plant data not reachable" }
        : { state: "live", detail: `${plants.data.plants.length} plants · ${plants.data.hotspots.length} hotspots` };
  const health: Record<ModuleKey, ModuleHealth> = {
    m1: disease,
    m2: twin,
    m3: { state: "limited", detail: "Measurements stay on the device that took them" },
    m4: advisory,
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">Plantation overview</h1>
        <p className="mt-1 max-w-prose text-sm text-text-secondary sm:text-base">
          Where to go today, what the twin wants checked and how far the data can be trusted.
        </p>
      </header>

      <ModuleStatus health={health} />

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <Section id="field-plan" title="Today's field plan" subtitle="Plants ranked by why they need a visit">
          {plants.kind === "loading" && <SectionLoading label="Loading plants…" />}
          {plants.kind === "error" && <SectionError message={plants.message} />}
          {plants.kind === "ok" && <FieldPlan items={plan} />}
        </Section>

        <Section id="hotspot-checks" title="Hotspots needing a disease check" subtitle="Found by the digital twin, checked with the disease model">
          {plants.kind === "loading" && <SectionLoading label="Loading hotspots…" />}
          {plants.kind === "error" && <SectionError message={plants.message} />}
          {plants.kind === "ok" && <HotspotChecks hotspots={plants.data.hotspots} />}
        </Section>
      </div>

      <Section
        id="cycle-changes"
        title="What changed this cycle"
        subtitle={changes?.windowEnd ? `Health trend up to ${changes.windowEnd}` : "Block and zone health trends"}
      >
        {trends.kind === "loading" && <SectionLoading label="Loading trends…" />}
        {trends.kind === "error" && <SectionError message={trends.message} />}
        {changes && <CycleChanges changes={changes} />}
      </Section>

      <Section id="data-trust" title="How far to trust the data" subtitle="Coverage, freshness and location quality">
        {plants.kind === "loading" && <SectionLoading label="Loading…" />}
        {plants.kind === "error" && <SectionError message={plants.message} />}
        {trust && <DataTrust trust={trust} modelNote={disease.note ?? null} />}
      </Section>
    </div>
  );
}
