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
  ExternalLink,
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

// Dark green of the home page header card (--color-primary-container).
const itemClass = (active: boolean) =>
  `relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
    active
      ? 'bg-white/15 text-white shadow-sm before:absolute before:inset-y-2 before:-left-3 before:w-1 before:rounded-r-full before:bg-emerald-300'
      : 'text-white/70 hover:bg-white/10 hover:text-white'
  }`;

const groupLabel = 'px-3 pb-1 text-[10px] font-bold uppercase tracking-widest text-emerald-200/60';

export default function SideNav() {
  const pathname = usePathname();
  const { supervisor, signOut } = useAuth();
  const name = supervisor?.full_name || supervisor?.email || 'Supervisor';
  const initials = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');

  return (
    <aside className="fixed inset-y-0 left-0 z-50 hidden w-64 flex-col bg-[#1b4332] text-white shadow-xl lg:flex">
      <Link href="/dashboard" className="flex items-center gap-3 px-5 py-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/20">
          <Sprout className="h-5 w-5 text-emerald-200" />
        </div>
        <div className="leading-tight">
          <p className="text-lg font-bold tracking-tight">Vanilla Monitor</p>
          <p className="text-[11px] text-white/50">Sapori dal Mondo</p>
        </div>
      </Link>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-4">
        <p className={`${groupLabel} pt-1`}>Field app</p>
        {FIELD_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || (href !== '/dashboard' && pathname?.startsWith(href));
          return (
            <Link key={href} href={href} aria-current={active ? 'page' : undefined} className={itemClass(!!active)}>
              <Icon className={`h-4 w-4 ${active ? 'text-emerald-200' : ''}`} />
              <span>{label}</span>
            </Link>
          );
        })}

        <p className={`${groupLabel} pt-6`}>Research modules</p>
        {MODULE_ITEMS.map(({ path, label, icon: Icon }) => (
          <a key={path} href={`${DASHBOARD_URL}${path}`} className={itemClass(false)}>
            <Icon className="h-4 w-4" />
            <span className="flex-1">{label}</span>
            <ExternalLink className="h-3 w-3 text-white/40" aria-label="opens the analytics dashboard" />
          </a>
        ))}
      </nav>

      <div className="m-3 flex items-center gap-3 rounded-xl bg-black/15 p-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-xs font-bold ring-1 ring-white/20">
          {initials || 'S'}
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-xs font-semibold">{name}</p>
          <p className="flex items-center gap-1 text-[10px] text-white/50">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Signed in
          </p>
        </div>
        <button
          onClick={() => void signOut()}
          title="Logout"
          className="rounded-lg p-2 text-white/60 transition hover:bg-red-500/20 hover:text-red-200"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}
