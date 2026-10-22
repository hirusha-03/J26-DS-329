import Link from "next/link";
import type { ModuleHealth, ModuleKey, ModuleState } from "@/lib/overview/data";

const MODULES: { key: ModuleKey; name: string; href: string }[] = [
  { key: "m1", name: "Disease detection", href: "/disease-detection" },
  { key: "m2", name: "Digital twin", href: "/digital-twin" },
  { key: "m3", name: "Growth & forecasting", href: "/growth-forecast" },
  { key: "m4", name: "Advisory", href: "/advisory" },
];

const STATE_STYLE: Record<ModuleState, { dot: string; label: string }> = {
  checking: { dot: "bg-border-light", label: "Checking" },
  live: { dot: "bg-ok", label: "Live" },
  limited: { dot: "bg-warn", label: "Limited" },
  offline: { dot: "bg-danger", label: "Offline" },
};

export default function ModuleStatus({ health }: { health: Record<ModuleKey, ModuleHealth> }) {
  return (
    <ul className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="Research module status" data-testid="module-status">
      {MODULES.map((m) => {
        const h = health[m.key];
        const style = STATE_STYLE[h.state];
        return (
          <li key={m.key}>
            <Link
              href={m.href}
              className="flex h-full flex-col rounded-lg border border-border-light bg-white p-3 hover:bg-surface focus-visible:outline-2 focus-visible:outline-secondary"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
                <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} aria-hidden />
                {m.name}
              </span>
              <span className="mt-0.5 text-xs text-text-secondary">
                <span className="sr-only">{style.label}: </span>
                {h.detail}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
