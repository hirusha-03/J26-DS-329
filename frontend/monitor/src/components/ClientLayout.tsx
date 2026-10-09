'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Home,
  Map,
  PlusCircle,
  ClipboardCheck,
  History,
  User,
  Sprout,
  LogOut,
} from 'lucide-react';
import { AuthProvider, useAuth } from '../context/AuthContext';
import BottomNav from './BottomNav';
import OfflineBanner from './OfflineBanner';
import { InspectionProvider } from '../context/InspectionContext';

function AuthGate({ children }: { children: React.ReactNode }) {
  const { status, supervisor, signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (status === 'authorized' && pathname === '/') {
      router.push('/dashboard');
    }
    if ((status === 'unauthenticated' || status === 'denied') && pathname !== '/') {
      router.push('/');
    }
  }, [status, pathname, router]);

  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      'serviceWorker' in navigator &&
      process.env.NODE_ENV === 'production'
    ) {
      navigator.serviceWorker.register('/sw.js')
        .then((reg) => console.log('SW registered:', reg.scope))
        .catch((err) => console.error('SW registration failed:', err));
    }
  }, []);

  if (status === 'loading' || status === 'checking') {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-surface">
        <div className="flex flex-col items-center gap-2">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-emerald-600 border-t-transparent" />
          <span className="text-sm font-medium text-slate-600">
            {status === 'checking' ? 'Verifying access...' : 'Loading Vanilla Monitor...'}
          </span>
        </div>
      </div>
    );
  }

  if (status === 'unauthenticated' || status === 'denied') {
    if (pathname === '/') return <>{children}</>;
    return (
      <div className="flex h-screen w-full items-center justify-center bg-surface">
        <div className="flex flex-col items-center gap-2">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-emerald-600 border-t-transparent" />
          <span className="text-sm font-medium text-slate-600">Redirecting to login...</span>
        </div>
      </div>
    );
  }

  // Wizard-style pages pin their own footer to a max-w-md column, so they keep the
  // phone-width column on every screen size.
  const hasOwnFooterNav =
    pathname?.startsWith('/inspect') ||
    pathname?.startsWith('/add-plant') ||
    pathname?.startsWith('/blocks');

  const desktopNavItems = [
    { href: '/dashboard', label: 'Dashboard', icon: Home },
    { href: '/digital-twin', label: 'Digital Twin', icon: Map },
    { href: '/new-inspection', label: 'New Inspection', icon: ClipboardCheck },
    { href: '/add-plant', label: 'Add Plant', icon: PlusCircle },
    { href: '/history', label: 'History', icon: History },
    { href: '/profile', label: 'Profile', icon: User },
  ];

  // Single <main> so each page mounts once. Mobile (< lg): phone column + bottom nav.
  // Desktop (>= lg): top navigation bar + wide content area.
  const mainClass = hasOwnFooterNav
    ? 'w-full max-w-md mx-auto bg-white shadow-sm min-h-[calc(100vh-4rem)] relative pb-6 border-x border-border-light'
    : 'w-full max-w-md mx-auto bg-white shadow-sm min-h-[calc(100vh-4rem)] relative pb-20 border-x border-border-light ' +
      'lg:max-w-7xl lg:bg-transparent lg:shadow-none lg:border-x-0 lg:px-4 lg:py-6 lg:min-h-0';

  return (
    <InspectionProvider>
      <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
        <OfflineBanner />

        {/* ── Desktop navigation header ── */}
        <header className="hidden lg:block sticky top-0 z-50 border-b border-slate-200 bg-white/95 backdrop-blur shadow-sm">
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4">
            <Link href="/dashboard" className="flex shrink-0 items-center gap-2 font-bold text-lg text-emerald-800">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-700 text-white shadow">
                <Sprout className="h-5 w-5" />
              </div>
              <span className="tracking-tight">Vanilla Monitor</span>
            </Link>

            <nav className="flex items-center gap-1">
              {desktopNavItems.map((item) => {
                const Icon = item.icon;
                const isActive = pathname === item.href || (item.href !== '/dashboard' && pathname?.startsWith(item.href));
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                      isActive
                        ? 'border-emerald-200/60 bg-emerald-50 text-emerald-800'
                        : 'border-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>

            <div className="flex shrink-0 items-center gap-3">
              <div className="hidden xl:flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs">
                <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="font-semibold text-slate-700">{supervisor?.full_name || supervisor?.email || 'Supervisor'}</span>
              </div>
              <button
                onClick={() => void signOut()}
                title="Logout"
                className="flex items-center gap-1 rounded-lg border border-slate-200 p-2 text-xs text-slate-500 hover:bg-red-50 hover:text-red-700"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </header>

        <main className={`flex-1 ${mainClass}`}>{children}</main>

        {/* ── Mobile bottom navigation ── */}
        {!hasOwnFooterNav && (
          <div className="lg:hidden">
            <BottomNav />
          </div>
        )}
      </div>
    </InspectionProvider>
  );
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AuthGate>{children}</AuthGate>
    </AuthProvider>
  );
}
