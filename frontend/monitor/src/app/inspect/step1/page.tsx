'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Check, Hash, ArrowLeft } from 'lucide-react';
import { useInspection } from '../../../context/InspectionContext';
import { PLANTATION, getTrackedPlants, formatPlantId } from '../../../lib/plantData';
import { getMortalityReports } from '../../../lib/offline-db';
import ProgressBar from '../../../components/ProgressBar';

export default function Step1PlantSelector() {
  const router = useRouter();
  const { formData, updateForm } = useInspection();

  const [selectedZone, setSelectedZone] = useState<string | null>(formData.zone);
  const [selectedBlock, setSelectedBlock] = useState<string | null>(formData.block);
  const [plantNumber, setPlantNumber] = useState<string>(
    formData.plant_number ? String(formData.plant_number) : ''
  );
  
  const [mortalityRates, setMortalityRates] = useState<Record<string, number>>({
    A: 0, B: 0, C: 0, D: 0
  });

  useEffect(() => {
    const calculateMortality = async () => {
      const reports = await getMortalityReports();
      const rates: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
      
      // Calculate totals per zone
      const zoneTotals = {
        A: { dead: 0, total: 531 },
        B: { dead: 0, total: 376 },
        C: { dead: 0, total: 280 },
        D: { dead: 0, total: 1000 }
      };

      reports.forEach(r => {
        const zone = r.zone as 'A' | 'B' | 'C' | 'D';
        if (zoneTotals[zone]) {
          zoneTotals[zone].dead += r.dead_vines || 0;
        }
      });

      Object.keys(zoneTotals).forEach(z => {
        const zone = z as 'A' | 'B' | 'C' | 'D';
        const total = zoneTotals[zone].total;
        const dead = zoneTotals[zone].dead;
        rates[zone] = total > 0 ? Math.min(100, Math.round((dead / total) * 100)) : 0;
      });

      setMortalityRates(rates);
    };

    calculateMortality();
  }, []);

  const handleZoneSelect = (zone: string) => {
    setSelectedZone(zone);
    setSelectedBlock(null);
    setPlantNumber('');
  };

  const handleBlockSelect = (blockId: string) => {
    setSelectedBlock(blockId);
    setPlantNumber('');
  };

  const handleNext = () => {
    if (!selectedZone || !selectedBlock || !plantNumber) {
      alert('Please complete all selections.');
      return;
    }

    const num = parseInt(plantNumber, 10);
    const blockInfo = PLANTATION[selectedZone].blocks.find(b => b.id === selectedBlock);
    if (!blockInfo) return;

    if (isNaN(num) || num < 1 || num > blockInfo.plants) {
      alert(`Plant number must be between 1 and ${blockInfo.plants} for Block ${selectedBlock}.`);
      return;
    }

    const plantId = formatPlantId(selectedZone, selectedBlock, num);

    updateForm({
      zone: selectedZone,
      block: selectedBlock,
      plant_number: num,
      plant_id: plantId
    });

    router.push('/inspect/step2');
  };

  const currentZoneInfo = selectedZone ? PLANTATION[selectedZone] : null;

  return (
    <div className="flex flex-col bg-surface min-h-screen">
      {/* Header */}
      <div className="bg-primary text-white px-4 py-4 flex items-center gap-3">
        <button onClick={() => router.push('/dashboard')} className="hover:opacity-80">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-base font-extrabold">New Inspection</h1>
          <p className="text-[10px] text-green-pale/80 font-medium">Select target zone and plant</p>
        </div>
      </div>

      <ProgressBar step={1} />

      <div className="p-5 space-y-6 flex-1 pb-20">
        {/* SELECT ZONE */}
        <div>
          <h2 className="text-xs font-bold uppercase tracking-widest text-secondary mb-3">Select Zone</h2>
          <div className="grid grid-cols-2 gap-3">
            {Object.entries(PLANTATION).map(([key, zone]) => {
              const isSelected = selectedZone === key;
              const rate = mortalityRates[key] || 0;
              const count = key === 'A' ? 531 : key === 'B' ? 376 : key === 'C' ? 280 : 1000;

              return (
                <button
                  key={key}
                  onClick={() => handleZoneSelect(key)}
                  className={`border text-left p-4 rounded-2xl shadow-xs transition-all duration-200 ${
                    isSelected
                      ? 'border-primary bg-pale-green'
                      : 'border-border-light bg-white hover:border-primary/20'
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <span
                      style={{ color: zone.color }}
                      className="text-2xl font-black"
                    >
                      {key}
                    </span>
                    <span
                      className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${
                        rate > 5 ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-700'
                      }`}
                    >
                      {rate}% dead
                    </span>
                  </div>
                  <span className="text-xs font-bold text-text-primary block mt-2">{zone.name}</span>
                  <span className="text-[10px] text-text-secondary mt-0.5 block">{count} plants</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* SELECT BLOCK */}
        {selectedZone && currentZoneInfo && (
          <div>
            <h2 className="text-xs font-bold uppercase tracking-widest text-secondary mb-3">
              Select Block — Zone {selectedZone}
            </h2>
            <div className="bg-white rounded-2xl border border-border-light divide-y divide-border-light max-h-56 overflow-y-auto">
              {currentZoneInfo.blocks.map((block) => {
                const isSelected = selectedBlock === block.id;
                
                return (
                  <button
                    key={block.id}
                    onClick={() => handleBlockSelect(block.id)}
                    className={`w-full flex items-center justify-between p-3.5 text-left transition-all ${
                      isSelected ? 'bg-surface-container' : 'hover:bg-surface'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="h-7 w-7 rounded-full bg-primary-container text-white text-xs font-bold flex items-center justify-center">
                        {block.id}
                      </div>
                      <div>
                        <span className="text-xs font-bold text-text-primary block">Block {block.id}</span>
                        <span className="text-[10px] text-text-secondary mt-0.5 block">
                          {block.plants} plants
                        </span>
                      </div>
                    </div>
                    {isSelected ? (
                      <Check className="h-4 w-4 text-primary font-bold" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-text-secondary" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* SELECT PLANT NUMBER */}
        {selectedZone && selectedBlock && (
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-200">
            <h2 className="text-xs font-bold uppercase tracking-widest text-secondary mb-2">Plant Number</h2>
            <div className="flex items-center gap-3 bg-white border border-border-light rounded-2xl px-4 py-3 shadow-xs">
              <Hash className="h-5 w-5 text-text-secondary" />
              <input
                type="number"
                value={plantNumber}
                onChange={(e) => setPlantNumber(e.target.value)}
                placeholder="Enter plant number"
                className="flex-1 text-xs font-bold focus:outline-none"
                min={1}
                max={currentZoneInfo?.blocks.find(b => b.id === selectedBlock)?.plants || 100}
              />
              <span className="text-[10px] text-text-secondary font-semibold">
                of {currentZoneInfo?.blocks.find(b => b.id === selectedBlock)?.plants || 100}
              </span>
            </div>
            <p className="text-[10px] text-text-secondary mt-1.5 px-1 font-medium leading-relaxed">
              Tracked samples for Block {selectedBlock}: {getTrackedPlants(selectedZone, selectedBlock).join(', ')}
            </p>
          </div>
        )}
      </div>

      {/* Floating Bottom Button */}
      <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto p-4 bg-white border-t border-border-light z-30">
        <button
          onClick={handleNext}
          disabled={!selectedZone || !selectedBlock || !plantNumber}
          className="w-full bg-[#1B4332] text-white py-3.5 rounded-full font-bold text-xs shadow-md transition hover:bg-primary active:scale-95 disabled:opacity-50 disabled:pointer-events-none"
        >
          Next Step: Plant Info
        </button>
      </div>
    </div>
  );
}
