"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavLinkItem } from "@/lib/types";

const NAV_ITEMS: NavLinkItem[] = [
  { href: "/overview", label: "Overview" },
  { href: "/digital-twin", label: "Digital Twin" },
  { href: "/disease-detection", label: "Disease Detection" },
  { href: "/growth-forecast", label: "Growth & Forecasting" },
  { href: "/recommendations", label: "Recommendations" },
];

export default function SideNav() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border-light bg-primary text-white md:flex">
      <div className="px-6 py-6">
        <p className="text-lg font-semibold leading-tight">Vanilla Monitor</p>
        <p className="text-xs text-white/60">Dashboard</p>
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-3">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname?.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
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
      </nav>
    </aside>
  );
}
