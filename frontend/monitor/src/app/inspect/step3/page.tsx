'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Droplets, Sun, Flame, Check } from 'lucide-react';
import { useInspection } from '../../../context/InspectionContext';
import ProgressBar from '../../../components/ProgressBar';
import ContextBadge from '../../../components/ContextBadge';

export default function Step3CareEnv() {

  const router = useRouter();
  const { formData, updateForm } = useInspection();

  // State initialization
  const [wateringStatus, setWateringStatus] = useState<string | null>(formData.watering_status);
  const [sunlightLevel, setSunlightLevel] = useState<string | null>(formData.sunlight_level);
  const [shadeLevel, setShadeLevel] = useState<string | null>(formData.shade_level);
  const [soilPH, setSoilPH] = useState<number>(formData.soil_pH || 6.2);
  const [temperature, setTemperature] = useState<string>(
    formData.temperature_c ? String(formData.temperature_c) : ''
  );
  const [humidity, setHumidity] = useState<string>(
    formData.humidity_pct ? String(formData.humidity_pct) : ''
  );
  const [soilType, setSoilType] = useState<string>(formData.soil_type || 'Acidic');
  const [fertiliserType, setFertiliserType] = useState<string[]>(formData.fertiliser_type || []);
  const [lastFertilised, setLastFertilised] = useState<string>(formData.last_fertilised || '');
  const [fertiliserUsed, setFertiliserUsed] = useState<string>(formData.fertiliser_used || '');

  const handleFertiliserToggle = (type: string) => {
    if (fertiliserType.includes(type)) {
      setFertiliserType(prev => prev.filter(t => t !== type));
    } else {
      setFertiliserType(prev => [...prev, type]);
    }
  };

  const handleNext = () => {
    if (!wateringStatus) {
      alert('Please select watering status.');
      return;
    }
    if (!sunlightLevel) {
      alert('Please select sunlight level.');
      return;
    }
    if (!shadeLevel) {
      alert('Please select shade level.');
      return;
    }

    const tempNum = temperature ? parseFloat(temperature) : null;
    const humNum = humidity ? parseInt(humidity, 10) : null;

    if (humNum !== null && (humNum < 0 || humNum > 100)) {
      alert('Humidity percentage must be between 0 and 100.');
      return;
    }

    const nowIso = new Date().toISOString();

    const mapSunlightToLux = (val: string | null) => {
      switch (val) {
        case 'bright': return '>20,000 lux';
        case 'bright_indirect': return '10,000-20,000 lux';
        case 'medium': return '1,000-10,000 lux';
        case 'low': return '<1,000 lux';
        default: return null;
      }
    };

    const mapShadeToPercentage = (val: string | null) => {
      switch (val) {
        case 'light': return '0-25%';
        case 'partial': return '25-50%';
        case 'moderate': return '50-70%';
        case 'heavy': return '>70%';
        default: return null;
      }
    };

    updateForm({
      watering_status: wateringStatus,
      sunlight_level: sunlightLevel,
      sunlight_lux: mapSunlightToLux(sunlightLevel),
      shade_level: shadeLevel,
      shade_percentage: mapShadeToPercentage(shadeLevel),
      soil_pH: soilPH,
      soil_pH_recorded_at: nowIso,
      temperature_c: tempNum,
      temperature_recorded_at: tempNum ? nowIso : null,
      humidity_pct: humNum,
      humidity_recorded_at: humNum ? nowIso : null,
      soil_type: soilType,
      fertiliser_type: fertiliserType,
      last_fertilised: lastFertilised || null,
      fertiliser_used: fertiliserUsed,
    });

    router.push('/inspect/step4');
  };

  // Status mapping for pH
  const phStatus = (val: number) => {
    if (val >= 6.0 && val <= 6.5) return { label: 'optimal', color: 'text-green-600 bg-green-50 border-green-200' };
    if ((val >= 5.5 && val < 6.0) || (val > 6.5 && val <= 7.0)) return { label: 'borderline', color: 'text-amber-600 bg-amber-50 border-amber-200' };
    return { label: 'critical', color: 'text-red-600 bg-red-50 border-red-200' };
  };

  const waterOptions = ['Dry out', 'Partially dry', 'Keep moist', 'High humidity'];
  const sunOptions = [
    { value: 'bright', name: 'Bright', bars: '7-9 bars', lux: '>20,000 lux' },
    { value: 'bright_indirect', name: 'Bright indirect', bars: '4-6 bars', lux: '10,000-20,000 lux' },
    { value: 'medium', name: 'Medium', bars: '2-3 bars', lux: '1,000-10,000 lux' },
    { value: 'low', name: 'Low', bars: '0-1 bars', lux: '<1,000 lux' }
  ];
  const shadeOptions = [
    { value: 'light', name: 'Light', range: '0-25%' },
    { value: 'partial', name: 'Partial', range: '25-50%' },
    { value: 'moderate', name: 'Moderate', range: '50-70%' },
    { value: 'heavy', name: 'Heavy', range: '>70%' }
  ];
  const fertOptions = ['All purpose', 'Cactus', 'Acidic', 'Orchid'];

  return (
    <div className="flex flex-col bg-surface min-h-screen">
      {/* Header */}
      <div className="bg-primary text-white px-4 py-4 flex items-center gap-3">
        <button onClick={() => router.push('/inspect/step2')} className="hover:opacity-80">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-base font-extrabold">Care & Environment</h1>
          <p className="text-[10px] text-green-pale/80 font-medium">Step 3 of 5 • Environment data</p>
        </div>
      </div>

      <ProgressBar step={3} />
      <ContextBadge
        zone={formData.zone || 'A'}
        block={formData.block || '01'}
        plantNumber={formData.plant_number || 1}
      />

      <div className="p-5 space-y-6 flex-1 pb-24">
        {/* WATERING STATUS */}
        <div>
          <h3 className="text-xs font-bold text-secondary uppercase tracking-widest flex items-center gap-1.5 mb-2.5">
            <Droplets className="h-4 w-4" />
            Watering Status
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {waterOptions.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setWateringStatus(opt)}
                className={`py-3 px-3 text-center text-xs font-bold rounded-2xl border transition-all ${
                  wateringStatus === opt
                    ? 'bg-primary border-primary text-white shadow-xs'
                    : 'border-border-light bg-white text-text-secondary hover:border-primary/20'
                }`}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>

        {/* SUNLIGHT & LOCATION */}
        <div>
          <h3 className="text-xs font-bold text-secondary uppercase tracking-widest flex items-center gap-1.5 mb-2.5">
            <Sun className="h-4 w-4" />
            Sunlight & Location
          </h3>
          <div className="space-y-4">
            <div>
              <span className="text-[9px] font-bold text-text-secondary uppercase">Sunlight Level</span>
              <div className="grid grid-cols-2 gap-2 mt-1.5">
                {sunOptions.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setSunlightLevel(opt.value)}
                    className={`py-3 px-2 text-center rounded-2xl border transition-all duration-200 ${
                      sunlightLevel === opt.value
                        ? 'bg-primary border-primary text-white shadow-xs'
                        : 'border-border-light bg-white text-text-secondary hover:border-primary/20 hover:bg-surface'
                    }`}
                  >
                    <span className="text-xs tracking-tight block truncate">
                      <span className="font-bold">{opt.name}</span>
                      <span className={`text-[10px] font-normal ${sunlightLevel === opt.value ? 'text-white/80' : 'text-text-secondary/80'}`}>
                        {' • '}{opt.bars}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="text-[9px] font-bold text-text-secondary uppercase">Shade Level</span>
              <div className="grid grid-cols-2 gap-2 mt-1.5">
                {shadeOptions.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setShadeLevel(opt.value)}
                    className={`py-3 px-2 text-center rounded-2xl border transition-all duration-200 ${
                      shadeLevel === opt.value
                        ? 'bg-primary border-primary text-white shadow-xs'
                        : 'border-border-light bg-white text-text-secondary hover:border-primary/20 hover:bg-surface'
                    }`}
                  >
                    <span className="text-xs tracking-tight block truncate">
                      <span className="font-bold">{opt.name}</span>
                      <span className={`text-[10px] font-normal ${shadeLevel === opt.value ? 'text-white/80' : 'text-text-secondary/80'}`}>
                        {' • '}{opt.range}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* SOIL & ENVIRONMENT */}
        <div>
          <h3 className="text-xs font-bold text-secondary uppercase tracking-widest flex items-center gap-1.5 mb-2.5">
            <Flame className="h-4 w-4" />
            Soil & Environment
          </h3>
          <div className="grid grid-cols-2 gap-3">
            {/* Soil pH Card */}
            <div className="col-span-2 bg-white rounded-2xl border border-border-light p-4 shadow-xs space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-[9px] font-bold text-text-secondary uppercase">Soil pH Level</span>
                <span className={`text-[9px] font-extrabold uppercase px-2 py-0.5 rounded-full border ${phStatus(soilPH).color}`}>
                  {phStatus(soilPH).label}
                </span>
              </div>
              <div className="text-2xl font-black text-primary text-center my-1">
                {soilPH.toFixed(1)}
              </div>
              {/* Slider */}
              <input
                type="range"
                min="4.0"
                max="8.0"
                step="0.1"
                value={soilPH}
                onChange={(e) => setSoilPH(parseFloat(e.target.value))}
                className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-primary"
              />
              {/* Range indicator bar */}
              <div className="relative h-1.5 w-full bg-gray-100 rounded-full overflow-hidden flex">
                <div className="w-[50%] h-full bg-gray-200" /> {/* 4.0 - 6.0 */}
                <div className="w-[12.5%] h-full bg-green-500" /> {/* 6.0 - 6.5 */}
                <div className="w-[37.5%] h-full bg-gray-200" /> {/* 6.5 - 8.0 */}
              </div>
              <div className="flex justify-between text-[8px] text-text-secondary font-bold px-1 uppercase">
                <span>4.0 acidity</span>
                <span className="text-green-600 font-extrabold">6.0 - 6.5 optimal</span>
                <span>8.0 alkaline</span>
              </div>
            </div>

            {/* Temperature */}
            <div className="bg-white rounded-2xl border border-border-light p-4 shadow-xs">
              <label className="text-[9px] font-bold text-text-secondary uppercase">Temperature °C</label>
              <input
                type="number"
                step="0.1"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                placeholder="e.g. 28.5"
                className="w-full mt-1.5 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
              />
            </div>

            {/* Humidity */}
            <div className="bg-white rounded-2xl border border-border-light p-4 shadow-xs">
              <label className="text-[9px] font-bold text-text-secondary uppercase">Humidity %</label>
              <input
                type="number"
                min="0"
                max="100"
                value={humidity}
                onChange={(e) => setHumidity(e.target.value)}
                placeholder="e.g. 80"
                className="w-full mt-1.5 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
              />
            </div>

            {/* Soil Type */}
            <div className="col-span-2 bg-white rounded-2xl border border-border-light p-4 shadow-xs">
              <label className="text-[9px] font-bold text-text-secondary uppercase">Soil Type</label>
              <select
                value={soilType}
                onChange={(e) => setSoilType(e.target.value)}
                className="w-full mt-1.5 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary bg-white"
              >
                <option value="Standard">Standard</option>
                <option value="Cactus">Cactus</option>
                <option value="Acidic">Acidic</option>
                <option value="Orchid">Orchid</option>
              </select>
            </div>
          </div>
        </div>

        {/* FERTILIZER */}
        <div className="bg-white rounded-2xl border border-border-light p-4 shadow-xs space-y-4">
          <div>
            <h3 className="text-xs font-bold text-secondary uppercase tracking-widest mb-3">
              Fertiliser Type (Multiple)
            </h3>
            <div className="flex flex-wrap gap-2">
              {fertOptions.map((type) => {
                const isSelected = fertiliserType.includes(type);
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => handleFertiliserToggle(type)}
                    className={`px-3 py-1.5 rounded-full border text-xs font-bold flex items-center gap-1 transition-all ${
                      isSelected
                        ? 'bg-pale-green border-primary text-primary'
                        : 'border-border-light bg-white text-text-secondary'
                    }`}
                  >
                    {isSelected && <Check className="h-3 w-3 text-primary stroke-[3px]" />}
                    {type}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-border-light/50 pt-3 grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-[9px] font-bold text-text-secondary uppercase">Last Fertilised Date</label>
              <input
                type="date"
                value={lastFertilised}
                onChange={(e) => setLastFertilised(e.target.value)}
                className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
              />
            </div>
            <div className="col-span-2">
              <label className="text-[9px] font-bold text-text-secondary uppercase">Fertiliser Brand / Formula</label>
              <input
                type="text"
                value={fertiliserUsed}
                onChange={(e) => setFertiliserUsed(e.target.value)}
                placeholder="e.g. Dolomite, Charcoal, Fish Tonic"
                className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Floating Bottom Button */}
      <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto p-4 bg-white border-t border-border-light z-30 flex gap-3">
        <button
          onClick={() => router.push('/inspect/step2')}
          className="flex-1 border border-border-light text-text-secondary py-3.5 rounded-full font-bold text-xs shadow-xs hover:bg-surface active:scale-95 transition"
        >
          Back
        </button>
        <button
          onClick={handleNext}
          className="flex-2 bg-[#1B4332] text-white py-3.5 rounded-full font-bold text-xs shadow-md transition hover:bg-primary active:scale-95"
        >
          Next: Growth Tracker
        </button>
      </div>
    </div>
  );
}
