"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowUpRight,
  ChartColumn,
  ClipboardCheck,
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

// Background = dark green of the field app's home header card.
// Current page: solid white pill. Hover: faint tint only, so the two never look alike.
const itemClass = (active: boolean) =>
  `group flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition-colors ${
    active
      ? "bg-white font-semibold text-[#1b4332] shadow-sm"
      : "font-medium text-white/75 hover:bg-white/[0.07] hover:text-white"
  }`;

const groupLabel = "px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/40";

function Brand() {
  return (
    <a href={`${MONITOR_URL}/dashboard`} className="flex items-center gap-2.5">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-400/15 ring-1 ring-inset ring-emerald-300/25">
        <Sprout className="h-4 w-4 text-emerald-200" />
      </div>
      <div className="leading-tight">
        <p className="text-[15px] font-bold tracking-tight">Vanilla Monitor</p>
        <p className="text-[10px] text-white/45">Sapori dal Mondo</p>
      </div>
    </a>
  );
}

function NavLinks({ pathname, onNavigate }: { pathname: string | null; onNavigate?: () => void }) {
  return (
    <>
      <p className={`${groupLabel} pt-2`}>Field app</p>
      {FIELD_ITEMS.map(({ path, label, icon: Icon }) => (
        <a key={path} href={`${MONITOR_URL}${path}`} className={itemClass(false)}>
          <Icon className="h-4 w-4 shrink-0 text-white/60 group-hover:text-white" />
          <span className="flex-1 truncate">{label}</span>
          <ArrowUpRight
            className="h-3.5 w-3.5 shrink-0 text-white/0 transition-colors group-hover:text-white/60"
            aria-label="opens the field app"
          />
        </a>
      ))}

      <div className="mx-3 my-3 border-t border-white/10" />

      <p className={groupLabel}>Research modules</p>
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
            <Icon className={`h-4 w-4 shrink-0 ${active ? "text-emerald-700" : "text-white/60 group-hover:text-white"}`} />
            <span className="truncate">{label}</span>
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
          <nav id="mobile-nav" className="flex max-h-[80vh] flex-col gap-0.5 overflow-y-auto px-3 pb-3">
            <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
          </nav>
        )}
      </header>

      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col bg-[#1b4332] text-white md:flex">
        <div className="px-5 pb-4 pt-5">
          <Brand />
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-4 [scrollbar-color:rgba(255,255,255,0.2)_transparent] [scrollbar-width:thin]">
          <NavLinks pathname={pathname} />
        </nav>
      </aside>
    </>
  );
}
