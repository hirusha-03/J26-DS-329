'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home,
  Map,
  PlusCircle,
  ClipboardCheck,
  History,
  User,
  Sprout,
  LogOut,
  LocateFixed,
  ChartColumn,
  Microscope,
  TrendingUp,
  Lightbulb,
  ArrowUpRight,
  Radar,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

// Same sidebar as the analytics app (frontend/dashboard/src/components/SideNav.tsx); keep the two in sync.
// The research modules live in that app.
const DASHBOARD_URL = (process.env.NEXT_PUBLIC_DASHBOARD_URL || 'http://localhost:3001').replace(/\/$/, '');

const FIELD_ITEMS = [
  { href: '/dashboard', label: 'Home', icon: Home },
  { href: '/digital-twin', label: 'Digital Twin', icon: Map },
  { href: '/near-me', label: 'Near Me', icon: LocateFixed },
  { href: '/new-inspection', label: 'New Inspection', icon: ClipboardCheck },
  { href: '/add-plant', label: 'Add Plant', icon: PlusCircle },
  { href: '/history', label: 'History', icon: History },
  { href: '/profile', label: 'Profile', icon: User },
];

const MODULE_ITEMS = [
  { path: '/overview', label: 'Analytics Overview', icon: ChartColumn },
  { path: '/digital-twin', label: 'Digital Twin Analytics', icon: Radar },
  { path: '/disease-detection', label: 'Disease Detection', icon: Microscope },
  { path: '/growth-forecast', label: 'Growth & Forecasting', icon: TrendingUp },
  { path: '/advisory', label: 'Advisory', icon: Lightbulb },
];

// Background = dark green of the home header card (--color-primary-container).
// Current page: solid white pill. Hover: faint tint only, so the two never look alike.
const itemClass = (active: boolean) =>
  `group flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition-colors ${
    active
      ? 'bg-white font-semibold text-[#1b4332] shadow-sm'
      : 'font-medium text-white/75 hover:bg-white/[0.07] hover:text-white'
  }`;

const groupLabel = 'px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/40';

export default function SideNav() {
  const pathname = usePathname();
  const { supervisor, signOut } = useAuth();
  const name = supervisor?.full_name || supervisor?.email || 'Supervisor';
  const initials = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');

  return (
    <aside className="fixed inset-y-0 left-0 z-50 hidden w-60 flex-col bg-[#1b4332] text-white lg:flex">
      <Link href="/dashboard" className="flex items-center gap-2.5 px-5 pb-4 pt-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-400/15 ring-1 ring-inset ring-emerald-300/25">
          <Sprout className="h-4 w-4 text-emerald-200" />
        </div>
        <div className="leading-tight">
          <p className="text-[15px] font-bold tracking-tight">Vanilla Monitor</p>
          <p className="text-[10px] text-white/45">Sapori dal Mondo</p>
        </div>
      </Link>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-3 [scrollbar-color:rgba(255,255,255,0.2)_transparent] [scrollbar-width:thin]">
        <p className={`${groupLabel} pt-2`}>Field app</p>
        {FIELD_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || (href !== '/dashboard' && pathname?.startsWith(href));
          return (
            <Link key={href} href={href} aria-current={active ? 'page' : undefined} className={itemClass(!!active)}>
              <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-emerald-700' : 'text-white/60 group-hover:text-white'}`} />
              <span>{label}</span>
            </Link>
          );
        })}

        <div className="mx-3 my-3 border-t border-white/10" />

        <p className={groupLabel}>Research modules</p>
        {MODULE_ITEMS.map(({ path, label, icon: Icon }) => (
          <a key={path} href={`${DASHBOARD_URL}${path}`} className={itemClass(false)}>
            <Icon className="h-4 w-4 shrink-0 text-white/60 group-hover:text-white" />
            <span className="flex-1 truncate">{label}</span>
            <ArrowUpRight
              className="h-3.5 w-3.5 shrink-0 text-white/0 transition-colors group-hover:text-white/60"
              aria-label="opens the analytics dashboard"
            />
          </a>
        ))}
      </nav>

      <div className="flex items-center gap-2.5 border-t border-white/10 px-4 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-400/20 text-[11px] font-bold text-emerald-100">
          {initials || 'S'}
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-xs font-semibold">{name}</p>
          <p className="flex items-center gap-1 text-[10px] text-white/45">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Signed in
          </p>
        </div>
        <button
          onClick={() => void signOut()}
          title="Logout"
          aria-label="Logout"
          className="rounded-md p-1.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}
