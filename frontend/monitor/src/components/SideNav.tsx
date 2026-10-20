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

const itemClass = (active: boolean) =>
  `flex items-center gap-3 rounded-lg border px-3 py-2 text-sm font-semibold transition ${
    active
      ? 'border-emerald-200/60 bg-emerald-50 text-emerald-800'
      : 'border-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900'
  }`;

export default function SideNav() {
  const pathname = usePathname();
  const { supervisor, signOut } = useAuth();

  return (
    <aside className="fixed inset-y-0 left-0 z-50 hidden w-64 flex-col border-r border-slate-200 bg-white lg:flex">
      <Link href="/dashboard" className="flex items-center gap-2 px-5 py-5 font-bold text-lg text-emerald-800">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-700 text-white shadow">
          <Sprout className="h-5 w-5" />
        </div>
        <span className="tracking-tight">Vanilla Monitor</span>
      </Link>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-4">
        <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Field app</p>
        {FIELD_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || (href !== '/dashboard' && pathname?.startsWith(href));
          return (
            <Link key={href} href={href} aria-current={active ? 'page' : undefined} className={itemClass(!!active)}>
              <Icon className="h-4 w-4" />
              <span>{label}</span>
            </Link>
          );
        })}

        <p className="px-3 pb-1 pt-5 text-[10px] font-bold uppercase tracking-widest text-slate-400">Research modules</p>
        {MODULE_ITEMS.map(({ path, label, icon: Icon }) => (
          <a key={path} href={`${DASHBOARD_URL}${path}`} className={itemClass(false)}>
            <Icon className="h-4 w-4" />
            <span className="flex-1">{label}</span>
            <ExternalLink className="h-3 w-3 text-slate-400" aria-label="opens the analytics dashboard" />
          </a>
        ))}
      </nav>

      <div className="flex items-center gap-2 border-t border-slate-200 px-4 py-3">
        <div className="h-2 w-2 shrink-0 rounded-full bg-emerald-500 animate-pulse" />
        <span className="flex-1 truncate text-xs font-semibold text-slate-700">
          {supervisor?.full_name || supervisor?.email || 'Supervisor'}
        </span>
        <button
          onClick={() => void signOut()}
          title="Logout"
          className="flex items-center rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-red-50 hover:text-red-700"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}
