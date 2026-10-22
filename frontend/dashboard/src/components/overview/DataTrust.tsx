import { STALE_AFTER_DAYS } from "@/lib/mapConfig";
import type { DataTrust as Trust, LocationKind } from "@/lib/overview/dataTrust";

const LOCATION_META: Record<LocationKind, { label: string; colour: string }> = {
  gps: { label: "GPS", colour: "#16a34a" },
  smoothed: { label: "Smoothed GPS", colour: "#4ade80" },
  single_fix: { label: "Single GPS fix", colour: "#facc15" },
  estimated: { label: "Estimated", colour: "#f97316" },
  none: { label: "No location", colour: "#9ca3af" },
};

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg bg-surface p-3">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="text-xl font-semibold text-text-primary">{value}</p>
      {note && <p className="text-xs text-text-secondary">{note}</p>}
    </div>
  );
}

export default function DataTrust({ trust, modelNote }: { trust: Trust; modelNote: string | null }) {
  const kinds = (Object.keys(LOCATION_META) as LocationKind[]).filter((k) => trust.locations[k] > 0);

  return (
    <div className="space-y-4" data-testid="data-trust">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label="Plants" value={String(trust.total)} />
        <Stat label="Inspected" value={pct(trust.coverage)} note={`${trust.inspected} of ${trust.total}`} />
        <Stat label="Overdue" value={pct(trust.staleShare)} note={`> ${STALE_AFTER_DAYS} days since inspection`} />
        <Stat label="Latest inspection" value={trust.latestInspection?.slice(0, 10) ?? "—"} />
      </div>

      {trust.total > 0 && (
        <div>
          <p className="mb-1.5 text-xs text-text-secondary">How plant locations were recorded</p>
          <div className="flex h-3 overflow-hidden rounded-full" role="img" aria-label="Location source mix">
            {kinds.map((k) => (
              <span key={k} style={{ width: `${(trust.locations[k] / trust.total) * 100}%`, background: LOCATION_META[k].colour }} />
            ))}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {kinds.map((k) => (
              <li key={k} className="flex items-center gap-1.5 text-xs text-text-secondary">
                <span className="h-2 w-2 rounded-full" style={{ background: LOCATION_META[k].colour }} aria-hidden />
                {LOCATION_META[k].label} {trust.locations[k]}
              </li>
            ))}
          </ul>
        </div>
      )}

      {modelNote && (
        <p className="rounded-lg bg-warn-soft p-3 text-xs text-text-primary">
          Disease model: {modelNote}. Treat its results as a second opinion, not a diagnosis.
        </p>
      )}
    </div>
  );
}
