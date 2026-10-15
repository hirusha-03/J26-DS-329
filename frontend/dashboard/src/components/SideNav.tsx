"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import type { NavLinkItem } from "@/lib/types";

const NAV_ITEMS: NavLinkItem[] = [
  { href: "/overview", label: "Overview" },
  { href: "/digital-twin", label: "Digital Twin" },
  { href: "/disease-detection", label: "Disease Detection" },
  { href: "/growth-forecast", label: "Growth & Forecasting" },
  { href: "/recommendations", label: "Recommendations" },
];

function NavLinks({ pathname, onNavigate }: { pathname: string | null; onNavigate?: () => void }) {
  return (
    <>
      {NAV_ITEMS.map((item) => {
        const isActive = pathname?.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={isActive ? "page" : undefined}
            className={`rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
              isActive
                ? "bg-white/10 text-white"
                : "text-white/70 hover:bg-white/5 hover:text-white"
            }`}
          >
            {item.label}
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
      <header className="sticky top-0 z-20 bg-primary text-white md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <p className="font-semibold">Vanilla Monitor</p>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            className="rounded-lg p-2 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white"
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

      <aside className="hidden w-64 shrink-0 flex-col border-r border-border-light bg-primary text-white md:flex">
        <div className="px-6 py-6">
          <p className="text-lg font-semibold leading-tight">Vanilla Monitor</p>
          <p className="text-xs text-white/60">Dashboard</p>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          <NavLinks pathname={pathname} />
        </nav>
      </aside>
    </>
  );
}
