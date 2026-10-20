'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '../context/AuthContext';
import BottomNav from './BottomNav';
import SideNav from './SideNav';
import OfflineBanner from './OfflineBanner';
import { InspectionProvider } from '../context/InspectionContext';

function AuthGate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
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

  // Single <main> so each page mounts once. Mobile (< lg): phone column + bottom nav.
  // Desktop (>= lg): side navigation + wide content area.
  // Pages with their own desktop layout; the other wizard pages stay phone-width.
  const hasDesktopLayout = pathname?.startsWith('/add-plant') || pathname?.startsWith('/inspect/form');
  const phoneColumnOnly = hasOwnFooterNav && !hasDesktopLayout;
  const mainClass = phoneColumnOnly
    ? 'w-full max-w-md mx-auto bg-white shadow-sm min-h-[calc(100vh-4rem)] relative pb-6 border-x border-border-light'
    : `w-full max-w-md mx-auto bg-white shadow-sm min-h-[calc(100vh-4rem)] relative ${hasOwnFooterNav ? 'pb-6' : 'pb-20'} border-x border-border-light ` +
      'lg:max-w-7xl lg:bg-transparent lg:shadow-none lg:border-x-0 lg:px-4 lg:py-6 lg:min-h-0';

  return (
    <InspectionProvider>
      {/* Phone-width wizard pages pin footers centred on the viewport, so their column is not
          shifted by the sidebar (it still clears the 16rem sidebar from lg upwards). */}
      <div className={`flex min-h-screen flex-col bg-slate-50 text-slate-900 ${phoneColumnOnly ? '' : 'lg:pl-64'}`}>
        <SideNav />
        <OfflineBanner />

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
