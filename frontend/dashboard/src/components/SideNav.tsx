"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChartColumn,
  ClipboardCheck,
  ExternalLink,
  History,
  Home,
  Lightbulb,
  LocateFixed,
  Map,
  Menu,
  Microscope,
  PlusCircle,
  Radar,
  Sprout,
  TrendingUp,
  User,
  X,
} from "lucide-react";

// Same sidebar as the field app (frontend/monitor/src/components/SideNav.tsx); keep the two in sync.
// Field-app pages live in frontend/monitor, the research modules in this app.
const MONITOR_URL = (process.env.NEXT_PUBLIC_MONITOR_URL || "http://localhost:3000").replace(/\/$/, "");

const FIELD_ITEMS = [
  { path: "/dashboard", label: "Home", icon: Home },
  { path: "/digital-twin", label: "Digital Twin", icon: Map },
  { path: "/near-me", label: "Near Me", icon: LocateFixed },
  { path: "/new-inspection", label: "New Inspection", icon: ClipboardCheck },
  { path: "/add-plant", label: "Add Plant", icon: PlusCircle },
  { path: "/history", label: "History", icon: History },
  { path: "/profile", label: "Profile", icon: User },
];

const MODULE_ITEMS = [
  { href: "/overview", label: "Analytics Overview", icon: ChartColumn },
  { href: "/digital-twin", label: "Digital Twin Analytics", icon: Radar },
  { href: "/disease-detection", label: "Disease Detection", icon: Microscope },
  { href: "/growth-forecast", label: "Growth & Forecasting", icon: TrendingUp },
  { href: "/advisory", label: "Advisory", icon: Lightbulb },
];

// Dark green of the field app's home header card.
const itemClass = (active: boolean) =>
  `relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
    active
      ? "bg-white/15 text-white shadow-sm before:absolute before:inset-y-2 before:-left-3 before:w-1 before:rounded-r-full before:bg-emerald-300"
      : "text-white/70 hover:bg-white/10 hover:text-white"
  }`;

const groupLabel = "px-3 pb-1 text-[10px] font-bold uppercase tracking-widest text-emerald-200/60";

function Brand() {
  return (
    <a href={`${MONITOR_URL}/dashboard`} className="flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/20">
        <Sprout className="h-5 w-5 text-emerald-200" />
      </div>
      <div className="leading-tight">
        <p className="text-lg font-bold tracking-tight">Vanilla Monitor</p>
        <p className="text-[11px] text-white/50">Sapori dal Mondo</p>
      </div>
    </a>
  );
}

function NavLinks({ pathname, onNavigate }: { pathname: string | null; onNavigate?: () => void }) {
  return (
    <>
      <p className={`${groupLabel} pt-1`}>Field app</p>
      {FIELD_ITEMS.map(({ path, label, icon: Icon }) => (
        <a key={path} href={`${MONITOR_URL}${path}`} className={itemClass(false)}>
          <Icon className="h-4 w-4" />
          <span className="flex-1">{label}</span>
          <ExternalLink className="h-3 w-3 text-white/40" aria-label="opens the field app" />
        </a>
      ))}

      <p className={`${groupLabel} pt-6`}>Research modules</p>
      {MODULE_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = !!pathname?.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={itemClass(active)}
          >
            <Icon className={`h-4 w-4 ${active ? "text-emerald-200" : ""}`} />
            <span>{label}</span>
          </Link>
        );
      })}
    </>
  );
}

export default function SideNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile: top bar with a toggleable menu */}
      <header className="sticky top-0 z-20 bg-[#1b4332] text-white shadow-md md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Brand />
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            className="rounded-lg p-2 text-white/80 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white"
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
        {open && (
          <nav id="mobile-nav" className="flex flex-col gap-1 px-3 pb-3">
            <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
          </nav>
        )}
      </header>

      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col bg-[#1b4332] text-white shadow-xl md:flex">
        <div className="px-5 py-6">
          <Brand />
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-4">
          <NavLinks pathname={pathname} />
        </nav>
      </aside>
    </>
  );
}
