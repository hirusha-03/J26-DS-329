'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, ArrowRight, Home, Smartphone, Check } from 'lucide-react';
import { getSubmission, getInspection } from '../../../lib/offline-db';

export default function InspectionSuccess() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const submissionId = searchParams.get('id');

  const [details, setDetails] = useState<any>(null);
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setIsOnline(navigator.onLine);
    }

    const fetchDetails = async () => {
      if (submissionId) {
        const sub = await getSubmission(submissionId) || await getInspection(submissionId);

        if (sub) {
          setDetails(sub);
        }
      }
    };

    fetchDetails();
  }, [submissionId]);

  return (
    <div className="flex min-h-screen flex-col bg-surface font-sans">
      {/* Success Animation & Header */}
      <div className="flex flex-col items-center justify-center bg-primary-container px-6 py-14 text-center text-white rounded-b-[2.5rem] shadow-md">
        <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-white/10 border-4 border-white/20 animate-bounce">
          <Check className="h-10 w-10 text-white stroke-[4px]" />
        </div>
        <h1 className="text-2xl font-black tracking-tight">Inspection Logged</h1>
        <p className="mt-1.5 text-xs font-semibold text-green-light max-w-xs">
          {isOnline 
            ? 'Submission synced successfully to Google Sheets & Drive.' 
            : 'Saved locally in IndexedDB. Will sync automatically when connection restores.'}
        </p>
      </div>

      {/* Summary Area */}
      <div className="flex-1 px-6 py-8 flex flex-col justify-between">
        <div className="space-y-4">
          <h2 className="text-xs font-bold uppercase tracking-widest text-text-secondary">Inspection Summary</h2>
          
          {details ? (
            <div className="bg-white rounded-2xl border border-border-light p-4 shadow-sm space-y-3.5">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-[9px] font-bold text-text-secondary uppercase">Plant ID</span>
                  <span className="text-sm font-extrabold text-primary block mt-0.5">{details.plant_id}</span>
                </div>
                <div>
                  <span className="text-[9px] font-bold text-text-secondary uppercase">Foliage Status</span>
                  <span className="text-sm font-extrabold text-text-primary block mt-0.5">{details.foliage_color}</span>
                </div>
              </div>

              <div className="my-2 border-t border-border-light/50" />

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-[9px] font-bold text-text-secondary uppercase">Zone & Block</span>
                  <span className="text-xs font-bold text-text-primary block mt-0.5">
                    Zone {details.zone} • Block {details.block}
                  </span>
                </div>
                <div>
                  <span className="text-[9px] font-bold text-text-secondary uppercase">Recorded Height</span>
                  <span className="text-xs font-bold text-text-primary block mt-0.5">
                    {details.vine_height_cm} cm {details.height_delta_cm !== undefined && details.height_delta_cm !== null ? `(${details.height_delta_cm >= 0 ? '+' : ''}${details.height_delta_cm} cm)` : ''}
                  </span>
                </div>
              </div>

              <div className="my-2 border-t border-border-light/50" />

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-[9px] font-bold text-text-secondary uppercase">pH Level</span>
                  <span className="text-xs font-bold text-text-primary block mt-0.5">
                    {details.soil_pH ?? details.soil_ph ?? 'N/A'} ({(details.soil_pH ?? details.soil_ph ?? 0) >= 6.0 && (details.soil_pH ?? details.soil_ph ?? 0) <= 6.5 ? 'Optimal' : 'Sub-optimal'})
                  </span>
                </div>
                <div>
                  <span className="text-[9px] font-bold text-text-secondary uppercase">Logged At</span>
                  <span className="text-xs font-bold text-text-primary block mt-0.5">
                    {new Date(details.submitted_at || details.created_at).toLocaleTimeString('en-US', {
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-border-light p-8 text-center text-text-secondary">
              <Smartphone className="h-8 w-8 mx-auto mb-2 opacity-40 text-primary" />
              <p className="text-xs font-semibold">Loading inspection details...</p>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="space-y-3 mt-8">
          <button
            onClick={() => router.push('/inspect')}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-[#1B4332] px-6 py-3.5 text-xs font-bold text-white shadow-md hover:bg-primary transition active:scale-95"
          >
            <span>Inspect Another Plant</span>
            <ArrowRight className="h-4 w-4" />
          </button>
          
          <button
            onClick={() => router.push('/dashboard')}
            className="flex w-full items-center justify-center gap-2 rounded-full border border-border-light bg-white px-6 py-3.5 text-xs font-bold text-text-secondary shadow-xs hover:bg-surface transition active:scale-95"
          >
            <Home className="h-4 w-4" />
            <span>Return to Dashboard</span>
          </button>
        </div>
      </div>
    </div>
  );
}
