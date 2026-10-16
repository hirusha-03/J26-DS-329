'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, RefreshCw } from 'lucide-react';

interface Props {
  /** Called with the full-resolution frame when the user taps Capture. */
  onCapture: (photo: File) => void;
  /** Called when the live camera can't start (no permission, insecure origin, no camera). */
  onUnavailable: (reason: string) => void;
}

/**
 * Live rear-camera view with a frame showing where the meter's screen should sit:
 * upright, the LIGHT icon at the top, the whole green screen inside the frame.
 */
export default function MeterCamera({ onCapture, onUnavailable }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        onUnavailable('Live camera needs a secure (https) connection.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
          audio: false,
        });
        if (cancelled) return;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setReady(true);
      } catch (err) {
        if (!cancelled) onUnavailable(err instanceof Error ? err.message : 'Camera unavailable');
      }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onUnavailable]);

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => blob && onCapture(new File([blob], `meter-${Date.now()}.jpg`, { type: 'image/jpeg' })),
      'image/jpeg',
      0.92,
    );
  };

  return (
    <div className="space-y-3">
      <div className="relative mx-auto aspect-[3/4] w-full max-w-xs overflow-hidden rounded-2xl bg-black">
        <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover" />
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-white/70">
            <RefreshCw className="h-6 w-6 animate-spin" />
          </div>
        )}

        {/* Screen frame: same proportions as the meter's LCD (portrait). Darkens everything outside. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="mb-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-bold text-white">
            ☀ LIGHT ▲ top of screen
          </span>
          <div
            className="relative w-[62%] rounded-lg border-2 border-emerald-400"
            style={{ aspectRatio: '300 / 380', boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)' }}
          >
            {['left-0 top-0 border-l-4 border-t-4', 'right-0 top-0 border-r-4 border-t-4', 'bottom-0 left-0 border-b-4 border-l-4', 'bottom-0 right-0 border-b-4 border-r-4'].map(
              (pos) => (
                <span key={pos} className={`absolute h-5 w-5 rounded-sm border-white ${pos}`} />
              ),
            )}
            <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[10px] font-semibold text-white/80 drop-shadow">
              Green screen here
            </span>
          </div>
          <span className="mt-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-bold text-white">⏻ CAL buttons below</span>
        </div>
      </div>

      <button
        type="button"
        onClick={capture}
        disabled={!ready}
        className="flex w-full items-center justify-center gap-1.5 rounded-full bg-primary py-3 text-xs font-bold text-white shadow-md transition-all hover:bg-primary/95 active:scale-95 disabled:opacity-50"
      >
        <Camera className="h-4 w-4" />
        Capture Meter Photo
      </button>
    </div>
  );
}
