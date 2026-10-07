'use client';

import { useEffect, useState } from 'react';
import { WifiOff, AlertTriangle } from 'lucide-react';
import { getPendingCount } from '../lib/offline-db';

export default function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  const updateStatus = async () => {
    if (typeof window === 'undefined') return;
    const isMockOffline = localStorage.getItem('mock_offline') === 'true';
    setIsOffline(isMockOffline || !navigator.onLine);
    const count = await getPendingCount();
    setPendingCount(count);
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;

    updateStatus();

    window.addEventListener('online', updateStatus);
    window.addEventListener('offline', updateStatus);
    window.addEventListener('sync-complete', updateStatus);
    window.addEventListener('submissions-updated', updateStatus);

    return () => {
      window.removeEventListener('online', updateStatus);
      window.removeEventListener('offline', updateStatus);
      window.removeEventListener('sync-complete', updateStatus);
      window.removeEventListener('submissions-updated', updateStatus);
    };
  }, []);

  if (!isOffline && pendingCount === 0) return null;

  return (
    <div
      className={`sticky top-0 z-40 flex items-center justify-between px-4 py-2 text-xs font-semibold shadow-sm transition-all duration-300 ${
        isOffline ? 'bg-amber-warning text-primary-container' : 'bg-pale-green text-primary'
      }`}
    >
      <div className="flex items-center gap-2">
        {isOffline ? (
          <>
            <WifiOff className="h-4 w-4 animate-pulse" />
            <span>Offline mode • No internet connection</span>
          </>
        ) : (
          <>
            <AlertTriangle className="h-4 w-4" />
            <span>Internet restored • Syncing queued submissions</span>
          </>
        )}
      </div>
      {pendingCount > 0 && (
        <span className="rounded-full bg-white/30 px-2 py-0.5 text-[10px] font-bold">
          {pendingCount} form{pendingCount > 1 ? 's' : ''} pending
        </span>
      )}
    </div>
  );
}
