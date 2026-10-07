'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, BarChart2, CheckSquare } from 'lucide-react';
import { useInspection } from '../../../context/InspectionContext';
import { getPreviousHeight } from '../../../lib/offline-db';
import ProgressBar from '../../../components/ProgressBar';
import ContextBadge from '../../../components/ContextBadge';

export default function Step4GrowthTracker() {
  const router = useRouter();
  const { formData, updateForm } = useInspection();

  // Local state
  const [vineHeight, setVineHeight] = useState<number>(formData.vine_height_cm || 100);
  const [previousHeight, setPreviousHeight] = useState<number | null>(null);
  const [foliageColor, setFoliageColor] = useState<string | null>(formData.foliage_color);
  const [plantingArrangement, setPlantingArrangement] = useState<string | null>(formData.planting_arrangement);

  // Fetch previous height
  useEffect(() => {
    const fetchPrev = async () => {
      if (formData.plant_id) {
        const prev = await getPreviousHeight(formData.plant_id);
        setPreviousHeight(prev);
        if (prev && !formData.vine_height_cm) {
          // Default to previous height if not edited yet
          setVineHeight(prev);
        }
      }
    };
    fetchPrev();
  }, [formData.plant_id]);

  const handleNext = () => {
    if (!foliageColor) {
      alert('Please select foliage color.');
      return;
    }
    if (!plantingArrangement) {
      alert('Please select planting arrangement.');
      return;
    }

    const delta = previousHeight !== null ? vineHeight - previousHeight : null;

    updateForm({
      vine_height_cm: vineHeight,
      height_delta_cm: delta,
      foliage_color: foliageColor,
      planting_arrangement: plantingArrangement,
    });

    router.push('/inspect/step5');
  };

  const foliageOptions = [
    { label: 'Green', bg: '#16A34A' },
    { label: 'Yellow', bg: '#F59E0B' },
    { label: 'Brown', bg: '#78350F' },
    { label: 'Red', bg: '#EF4444' },
    { label: 'Mixed', bg: 'linear-gradient(135deg, #16A34A 0%, #78350F 100%)', fullWidth: true },
  ];

  const arrangementOptions = [
    'Square',
    'Rectangular',
    'Hexagonal',
    'Triangular',
    'Quincunx',
    'Contour',
  ];

  const deltaVal = previousHeight !== null ? vineHeight - previousHeight : null;

  return (
    <div className="flex flex-col bg-surface min-h-screen">
      {/* Header */}
      <div className="bg-primary text-white px-4 py-4 flex items-center gap-3">
        <button onClick={() => router.push('/inspect/step3')} className="hover:opacity-80">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-base font-extrabold">Growth Tracker</h1>
          <p className="text-[10px] text-green-pale/80 font-medium">Step 4 of 5 • Height & metrics</p>
        </div>
      </div>

      <ProgressBar step={4} />
      <ContextBadge
        zone={formData.zone || 'A'}
        block={formData.block || '01'}
        plantNumber={formData.plant_number || 1}
      />

      <div className="p-5 space-y-6 flex-1 pb-24">
        {/* VINE HEIGHT */}
        <div className="bg-white rounded-2xl border border-border-light p-5 shadow-xs space-y-4">
          <h3 className="text-xs font-bold text-secondary uppercase tracking-widest flex items-center gap-1.5 border-b border-border-light/50 pb-2">
            <BarChart2 className="h-4 w-4" />
            Vine Height
          </h3>

          <div className="flex flex-col items-center py-2">
            <div className="flex items-baseline justify-center">
              <span className="text-5xl font-black text-primary">{vineHeight}</span>
              <span className="text-lg font-bold text-text-secondary ml-1">cm</span>
            </div>

            {/* Delta badge */}
            {previousHeight !== null && (
              <div className={`mt-2 flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold ${
                deltaVal !== null && deltaVal >= 0 
                  ? 'bg-green-50 text-green-700 border border-green-200' 
                  : 'bg-red-50 text-red-600 border border-red-200'
              }`}>
                <span>
                  {deltaVal !== null && deltaVal >= 0 ? `+${deltaVal}` : deltaVal} cm from last week
                </span>
              </div>
            )}
            
            <span className="text-[9px] text-text-secondary mt-1 font-semibold">
              Recorded {new Date().toLocaleDateString()}
            </span>
          </div>

          {/* Increment / Decrement Buttons */}
          <div className="flex justify-center items-center gap-6">
            <button
              onClick={() => setVineHeight(Math.max(1, vineHeight - 5))}
              className="h-10 w-16 border border-border-light rounded-2xl flex items-center justify-center font-bold text-xs bg-surface active:bg-gray-200"
            >
              -5
            </button>
            <button
              onClick={() => setVineHeight(Math.max(1, vineHeight - 1))}
              className="h-12 w-12 border border-border-light rounded-full flex items-center justify-center font-black text-lg bg-surface active:bg-gray-200"
            >
              -
            </button>
            <button
              onClick={() => setVineHeight(vineHeight + 1)}
              className="h-12 w-12 border border-border-light rounded-full flex items-center justify-center font-black text-lg bg-surface active:bg-gray-200"
            >
              +
            </button>
            <button
              onClick={() => setVineHeight(vineHeight + 5)}
              className="h-10 w-16 border border-border-light rounded-2xl flex items-center justify-center font-bold text-xs bg-surface active:bg-gray-200"
            >
              +5
            </button>
          </div>

          {/* Height Visual Progress (0–200 cm) */}
          <div className="space-y-1 pt-2">
            <div className="h-2 w-full bg-pale-green rounded-full overflow-hidden">
              <div
                style={{ width: `${Math.min(100, (vineHeight / 200) * 100)}%` }}
                className="h-full bg-secondary transition-all duration-300"
              />
            </div>
            <div className="flex justify-between text-[8px] font-bold text-text-secondary">
              <span>0 cm</span>
              <span>100 cm</span>
              <span>200 cm+</span>
            </div>
          </div>
        </div>

        {/* FOLIAGE COLOR */}
        <div className="bg-white rounded-2xl border border-border-light p-4 shadow-xs">
          <h3 className="text-xs font-bold text-secondary uppercase tracking-widest mb-3.5">
            Foliage Color
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {foliageOptions.map((opt) => {
              const isSelected = foliageColor === opt.label;
              return (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => setFoliageColor(opt.label)}
                  className={`flex items-center gap-3 w-full p-2.5 rounded-xl border text-left transition-all ${
                    opt.fullWidth ? 'col-span-2' : ''
                  } ${
                    isSelected
                      ? 'border-primary bg-pale-green font-bold text-primary shadow-xs'
                      : 'border-border-light bg-white text-text-secondary hover:border-primary/10'
                  }`}
                >
                  <div 
                    className="h-4.5 w-4.5 rounded-full border border-black/10 shrink-0" 
                    style={{ background: opt.bg }}
                  />
                  <span className="text-xs font-semibold">{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* PLANTING ARRANGEMENT */}
        <div className="bg-white rounded-2xl border border-border-light p-4 shadow-xs">
          <h3 className="text-xs font-bold text-secondary uppercase tracking-widest flex items-center gap-1.5 mb-3.5">
            <CheckSquare className="h-4 w-4" />
            Planting Arrangement
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {arrangementOptions.map((opt) => {
              const isSelected = plantingArrangement === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setPlantingArrangement(opt)}
                  className={`py-3 px-3 text-center text-xs font-bold rounded-2xl border transition-all ${
                    isSelected
                      ? 'bg-primary border-primary text-white shadow-xs'
                      : 'border-border-light bg-white text-text-secondary hover:border-primary/20'
                  }`}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        </div>

      </div>

      {/* Floating Bottom Button */}
      <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto p-4 bg-white border-t border-border-light z-30 flex gap-3">
        <button
          onClick={() => router.push('/inspect/step3')}
          className="flex-1 border border-border-light text-text-secondary py-3.5 rounded-full font-bold text-xs shadow-xs hover:bg-surface active:scale-95 transition"
        >
          Back
        </button>
        <button
          onClick={handleNext}
          className="flex-2 bg-[#1B4332] text-white py-3.5 rounded-full font-bold text-xs shadow-md transition hover:bg-primary active:scale-95"
        >
          Next: Photo & Submit
        </button>
      </div>
    </div>
  );
}
