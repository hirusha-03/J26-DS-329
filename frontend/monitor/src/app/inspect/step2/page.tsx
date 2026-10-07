'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Info, Calendar } from 'lucide-react';
import { useInspection } from '../../../context/InspectionContext';
import ProgressBar from '../../../components/ProgressBar';
import ContextBadge from '../../../components/ContextBadge';

export default function Step2PlantInfo() {
  const router = useRouter();
  const { formData, updateForm } = useInspection();

  const [commonName, setCommonName] = useState(formData.common_name);
  const [latinName, setLatinName] = useState(formData.latin_name);
  const [variety, setVariety] = useState(formData.variety);
  const [plantType, setPlantType] = useState(formData.plant_type);
  
  const [purchaseDate, setPurchaseDate] = useState(formData.purchase_date || '');
  const [plantedDate, setPlantedDate] = useState(formData.planted_date || '');
  const [purchasedFrom, setPurchasedFrom] = useState(formData.purchased_from);
  const [purchaseCondition, setPurchaseCondition] = useState<string | null>(formData.purchase_condition);
  const [maxHeight, setMaxHeight] = useState<string>(
    formData.max_height ? String(formData.max_height) : ''
  );

  const handleNext = () => {
    if (!purchaseCondition) {
      alert('Please select a purchase condition.');
      return;
    }

    const heightNum = maxHeight ? parseInt(maxHeight, 10) : null;

    updateForm({
      common_name: commonName,
      latin_name: latinName,
      variety,
      plant_type: plantType,
      purchase_date: purchaseDate || null,
      planted_date: plantedDate || null,
      purchased_from: purchasedFrom,
      purchase_condition: purchaseCondition,
      max_height: heightNum,
    });

    router.push('/inspect/step3');
  };

  const conditions = ['<50%', '<75%', '>50%', '>75%'];

  return (
    <div className="flex flex-col bg-surface min-h-screen">
      {/* Header */}
      <div className="bg-primary text-white px-4 py-4 flex items-center gap-3">
        <button onClick={() => router.push('/inspect/step1')} className="hover:opacity-80">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-base font-extrabold">Plant Info</h1>
          <p className="text-[10px] text-green-pale/80 font-medium">Step 2 of 5 • General vine data</p>
        </div>
      </div>

      <ProgressBar step={2} />
      <ContextBadge
        zone={formData.zone || 'A'}
        block={formData.block || '01'}
        plantNumber={formData.plant_number || 1}
      />

      <div className="p-5 space-y-5 flex-1 pb-24">
        {/* BOTANICAL CLASSIFICATION */}
        <div className="bg-white rounded-2xl border border-border-light p-4 shadow-xs space-y-4">
          <h3 className="text-xs font-bold text-secondary uppercase tracking-widest flex items-center gap-1.5 border-b border-border-light/50 pb-2">
            <Info className="h-3.5 w-3.5" />
            Botanical Details
          </h3>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[9px] font-bold text-text-secondary uppercase">Common Name</label>
              <input
                type="text"
                value={commonName}
                onChange={(e) => setCommonName(e.target.value)}
                className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
              />
            </div>
            <div>
              <label className="text-[9px] font-bold text-text-secondary uppercase">Latin Name</label>
              <input
                type="text"
                value={latinName}
                onChange={(e) => setLatinName(e.target.value)}
                className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[9px] font-bold text-text-secondary uppercase">Variety</label>
              <input
                type="text"
                value={variety}
                onChange={(e) => setVariety(e.target.value)}
                className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
              />
            </div>
            <div>
              <label className="text-[9px] font-bold text-text-secondary uppercase">Plant Type</label>
              <input
                type="text"
                value={plantType}
                onChange={(e) => setPlantType(e.target.value)}
                className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
              />
            </div>
          </div>
        </div>

        {/* LOGISTICS & ORIGIN */}
        <div className="bg-white rounded-2xl border border-border-light p-4 shadow-xs space-y-4">
          <h3 className="text-xs font-bold text-secondary uppercase tracking-widest flex items-center gap-1.5 border-b border-border-light/50 pb-2">
            <Calendar className="h-3.5 w-3.5" />
            Origin & Dates
          </h3>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[9px] font-bold text-text-secondary uppercase">Purchase Date</label>
              <input
                type="date"
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
                className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
              />
            </div>
            <div>
              <label className="text-[9px] font-bold text-text-secondary uppercase">Planted Date</label>
              <input
                type="date"
                value={plantedDate}
                onChange={(e) => setPlantedDate(e.target.value)}
                className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
              />
            </div>
          </div>

          <div>
            <label className="text-[9px] font-bold text-text-secondary uppercase">Purchased From</label>
            <input
              type="text"
              value={purchasedFrom}
              onChange={(e) => setPurchasedFrom(e.target.value)}
              className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
            />
          </div>
        </div>

        {/* PHYSICAL STATUS ON ARRIVAL */}
        <div className="bg-white rounded-2xl border border-border-light p-4 shadow-xs space-y-4">
          <div>
            <h3 className="text-xs font-bold text-secondary uppercase tracking-widest mb-3">
              Purchase Condition (Survival Chance)
            </h3>
            <div className="grid grid-cols-4 gap-2">
              {conditions.map((cond) => {
                const isSelected = purchaseCondition === cond;
                return (
                  <button
                    key={cond}
                    type="button"
                    onClick={() => setPurchaseCondition(cond)}
                    className={`py-2.5 text-center text-xs font-bold rounded-full border transition-all ${
                      isSelected
                        ? 'bg-primary border-primary text-white shadow-xs'
                        : 'border-border-light bg-white text-text-secondary hover:border-primary/20'
                    }`}
                  >
                    {cond}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-border-light/50 pt-3">
            <label className="text-[9px] font-bold text-text-secondary uppercase">Max Cutting Height (cm)</label>
            <input
              type="number"
              value={maxHeight}
              onChange={(e) => setMaxHeight(e.target.value)}
              placeholder="e.g. 120"
              className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
            />
          </div>
        </div>
      </div>

      {/* Floating Bottom Button */}
      <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto p-4 bg-white border-t border-border-light z-30 flex gap-3">
        <button
          onClick={() => router.push('/inspect/step1')}
          className="flex-1 border border-border-light text-text-secondary py-3.5 rounded-full font-bold text-xs shadow-xs hover:bg-surface active:scale-95 transition"
        >
          Back
        </button>
        <button
          onClick={handleNext}
          className="flex-2 bg-[#1B4332] text-white py-3.5 rounded-full font-bold text-xs shadow-md transition hover:bg-primary active:scale-95"
        >
          Next: Care & Environment
        </button>
      </div>
    </div>
  );
}
