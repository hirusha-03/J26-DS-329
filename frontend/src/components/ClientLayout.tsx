'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '../context/AuthContext';
import BottomNav from './BottomNav';
import OfflineBanner from './OfflineBanner';
import { isSupabaseConfigured } from '../lib/supabaseClient';

// ─── Inner layout — consumes AuthContext ─────────────────────────────────────

function ConfigError() {
  return (
    <div className="flex h-screen w-full items-center justify-center bg-surface p-6">
      <div className="max-w-sm text-center">
        <p className="font-semibold text-text-primary">Supabase is not configured</p>
        <p className="mt-2 text-sm text-text-secondary">
          Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
          (see frontend/.env.example) and restart the dev server.
        </p>
      </div>
    </div>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  if (!isSupabaseConfigured) {
    return <ConfigError />;
  }

  useEffect(() => {
    if (status === 'authorized' && pathname === '/') {
      router.push('/dashboard');
    }
    if ((status === 'unauthenticated' || status === 'denied') && pathname !== '/') {
      router.push('/');
    }
  }, [status, pathname, router]);

  // ── Service Worker ───────────────────────────────────────────────────────
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

  // ── Loading / checking states ────────────────────────────────────────────
  if (status === 'loading' || status === 'checking') {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-surface">
        <div className="flex flex-col items-center gap-2">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <span className="text-sm font-medium text-text-secondary">
            {status === 'checking' ? 'Verifying access...' : 'Loading Vanilla Monitor...'}
          </span>
        </div>
      </div>
    );
  }

  // ── Login page (unauthenticated or denied) ───────────────────────────────
  if (status === 'unauthenticated' || status === 'denied') {
    if (pathname === '/') return <>{children}</>;
    // Redirecting to '/' — show loader while redirect happens
    return (
      <div className="flex h-screen w-full items-center justify-center bg-surface">
        <div className="flex flex-col items-center gap-2">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <span className="text-sm font-medium text-text-secondary">Redirecting to login...</span>
        </div>
      </div>
    );
  }

  // ── Authorized ────────────────────────────────────────────────────────────
  const hasOwnFooterNav =
    pathname?.startsWith('/inspect') ||
    pathname?.startsWith('/add-plant') ||
    pathname?.startsWith('/blocks');

  return (
    <div className={`flex min-h-screen flex-col bg-surface ${hasOwnFooterNav ? '' : 'pb-16'}`}>
      <OfflineBanner />
      <main className="flex-1 w-full max-w-md mx-auto bg-white shadow-sm min-h-[calc(100vh-4rem)] relative pb-6 border-x border-border-light">
        {children}
      </main>
      {!hasOwnFooterNav && <BottomNav />}
    </div>
  );
}

// ─── Exported wrapper — provides AuthContext ──────────────────────────────────

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AuthGate>{children}</AuthGate>
    </AuthProvider>
  );
}
