/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Check, Camera, Sparkles, Droplet, Thermometer, Ruler, AlertCircle, Lock, Unlock, XCircle, RefreshCw, AlertTriangle, ClipboardCheck } from 'lucide-react';
import { getPlant, getPreviousHeight, getSetting, saveSetting, savePlantOffline } from '../../../lib/offline-db';
import { saveInspectionOfflineService, syncPendingSubmissions } from '../../../lib/syncService';
import { supabase } from '../../../lib/supabaseClient';
import { scanMeterPhoto, type MeterScanResult } from '../../../lib/meterOcr';
import MeterCamera from '../../../components/MeterCamera';

const FORM_SECTIONS = [
  { id: 'care', label: 'Care', icon: Droplet },
  { id: 'environment', label: 'Environment & Soil', icon: Thermometer },
  { id: 'measurements', label: 'Measurements & Disease', icon: Ruler },
  { id: 'fertilizer', label: 'Fertilizer & Notes', icon: Sparkles },
  { id: 'photo', label: 'Upload Photo', icon: Camera },
];

/** On desktop each form section is its own card; on mobile the original stacked look is kept. */
const SECTION_CLASS =
  'space-y-3 scroll-mt-24 lg:rounded-xl lg:border lg:border-slate-200 lg:bg-white lg:p-5 lg:shadow-sm';

export default function InspectFormPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const plantId = searchParams.get('plant_id') || '';

  const [loading, setLoading] = useState(false);
  const [staticDetails, setStaticDetails] = useState<any>(null);
  const [lastHeight, setLastHeight] = useState<number | null>(null);

  // Form states
  const [wateringStatus, setWateringStatus] = useState<string>('Keep moist');
  const [sunlightLevel, setSunlightLevel] = useState<string>('bright_indirect');
  const [shadeLevel, setShadeLevel] = useState<string>('moderate');
  
  const [soilType, setSoilType] = useState<string>('Acidic');
  const [soilPh, setSoilPh] = useState<number>(6.2);
  const [soilEc, setSoilEc] = useState<string>('');
  const [moisture, setMoisture] = useState<string>('');
  const [temperature, setTemperature] = useState<string>('');
  const [humidity, setHumidity] = useState<string>('');

  const [vineHeight, setVineHeight] = useState<string>('');
  const [foliageColor, setFoliageColor] = useState<string>('Green');

  const [fertilizerType, setFertilizerType] = useState<string[]>([]);
  const [fertilizerUsed, setFertilizerUsed] = useState<string>('');
  const [lastFertilized, setLastFertilized] = useState<string>('');

  // Fixed/Editing toggle states
  const [isFixed, setIsFixed] = useState(true);
  const [hasBeenUnlocked, setHasBeenUnlocked] = useState(false);
  const [carriedInfo, setCarriedInfo] = useState<any>(null);

  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [notes, setNotes] = useState<string>('');

  // OCR Meter Reading States
  const [readingSources, setReadingSources] = useState<Record<string, 'manual' | 'ocr_confirmed' | 'ocr_edited'>>({
    soilPh: 'manual',
    soilEc: 'manual',
    temperature: 'manual',
    humidity: 'manual',
    moisture: 'manual',
    sunlightLevel: 'manual'
  });
  const [ocrModalOpen, setOcrModalOpen] = useState(false);
  const [activeStep, setActiveStep] = useState<'capture' | 'confirm'>('capture');
  const [isOcrAnalyzing, setIsOcrAnalyzing] = useState(false);
  const [ocrPreviewUrl, setOcrPreviewUrl] = useState<string | null>(null);
  const [ocrOverlayUrl, setOcrOverlayUrl] = useState<string | null>(null);
  const [ocrScreenFound, setOcrScreenFound] = useState(true);
  const [ocrMessage, setOcrMessage] = useState<string | null>(null);
  const [ocrConfident, setOcrConfident] = useState<MeterScanResult['confident'] | null>(null);
  const [liveCameraError, setLiveCameraError] = useState<string | null>(null);
  const handleLiveCameraUnavailable = useCallback((reason: string) => setLiveCameraError(reason), []);
  const [meterPhotoFile, setMeterPhotoFile] = useState<File | null>(null);

  // OCR Confirm Form States (prefilled from scan)
  const [modalPh, setModalPh] = useState<string>('');
  const [modalEc, setModalEc] = useState<string>('');
  const [modalTemp, setModalTemp] = useState<string>('');
  const [modalHumid, setModalHumid] = useState<string>('');
  const [modalLight, setModalLight] = useState<string>('');
  const [modalMoist, setModalMoist] = useState<string>('');

  const [ocrUnitError, setOcrUnitError] = useState<string | null>(null);
  const [ocrValidationError, setOcrValidationError] = useState<string | null>(null);

  const handlePhChange = (val: number) => {
    setSoilPh(val);
    setReadingSources(prev => ({
      ...prev,
      soilPh: prev.soilPh === 'ocr_confirmed' ? 'ocr_edited' : prev.soilPh
    }));
  };

  const handleEcChange = (val: string) => {
    setSoilEc(val);
    setReadingSources(prev => ({
      ...prev,
      soilEc: prev.soilEc === 'ocr_confirmed' ? 'ocr_edited' : prev.soilEc
    }));
  };

  const handleMoistureChange = (val: string) => {
    setMoisture(val);
    setReadingSources(prev => ({
      ...prev,
      moisture: prev.moisture === 'ocr_confirmed' ? 'ocr_edited' : prev.moisture
    }));
  };

  const handleTempChange = (val: string) => {
    setTemperature(val);
    setReadingSources(prev => ({
      ...prev,
      temperature: prev.temperature === 'ocr_confirmed' ? 'ocr_edited' : prev.temperature
    }));
  };

  const handleHumidityChange = (val: string) => {
    setHumidity(val);
    setReadingSources(prev => ({
      ...prev,
      humidity: prev.humidity === 'ocr_confirmed' ? 'ocr_edited' : prev.humidity
    }));
  };

  const handleSunlightChange = (val: string) => {
    setSunlightLevel(val);
    setReadingSources(prev => ({
      ...prev,
      sunlightLevel: prev.sunlightLevel === 'ocr_confirmed' ? 'ocr_edited' : prev.sunlightLevel
    }));
  };

  const startScanner = () => {
    setOcrModalOpen(true);
    setActiveStep('capture');
    setOcrPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setOcrOverlayUrl(null);
    setOcrMessage(null);
    setOcrUnitError(null);
    setOcrValidationError(null);
    setMeterPhotoFile(null);
  };

  const handleOcrFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so "Retake" can pick the same file again
    if (file) scanMeterFile(file);
  };

  const scanMeterFile = async (file: File) => {
    setMeterPhotoFile(file);
    setOcrPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setIsOcrAnalyzing(true);
    try {
      const res = await scanMeterPhoto(file);
      const v = res.values;
      setOcrScreenFound(res.found);
      setOcrMessage(res.message);
      setOcrOverlayUrl(res.overlayDataUrl);
      setOcrConfident(res.confident);
      setModalPh(v.ph !== null ? v.ph.toFixed(1) : '');
      setModalEc(v.ec !== null ? (res.units.ec === 'uS' ? String(v.ec) : v.ec.toFixed(2)) : '');
      setModalTemp(v.temperature !== null ? v.temperature.toFixed(1) : '');
      setModalHumid(v.humidity !== null ? String(v.humidity) : '');
      setModalLight(v.lightBars !== null ? String(v.lightBars) : '');
      setModalMoist(v.moistureDrops !== null ? String(v.moistureDrops) : '');
      const unitErrors = [
        res.units.temperature === 'F' && 'Temperature is in °F. Please click unit toggle on the meter to switch to °C.',
        res.units.ec === 'uS' && 'EC is in µS/cm. Please switch the meter unit to mS/cm.',
      ].filter(Boolean);
      setOcrUnitError(unitErrors.length ? unitErrors.join(' ') : null);
      setOcrValidationError(null);
    } catch (err) {
      console.error('Meter scan failed:', err);
      setOcrScreenFound(false);
      setOcrMessage('Could not process this photo. Please retake it or enter the readings manually.');
      setOcrOverlayUrl(null);
      setOcrConfident(null);
      [setModalPh, setModalEc, setModalTemp, setModalHumid, setModalLight, setModalMoist].forEach((set) => set(''));
      setOcrUnitError(null);
      setOcrValidationError(null);
    } finally {
      setIsOcrAnalyzing(false);
      setActiveStep('confirm');
    }
  };

  const getDynamicErrors = () => {
    let uError = ocrUnitError;
    let vError = ocrValidationError;
    
    const phNum = Number(modalPh);
    if (!isNaN(phNum) && modalPh !== '') {
      if (phNum < 3.5 || phNum > 9.0) {
        vError = 'Soil pH is out of bounds (3.5-9.0). Check if the probe is fully inserted in moist soil.';
      } else {
        if (vError && (vError.includes('pH is 0.0') || vError.includes('out of bounds'))) {
          vError = null;
        }
      }
    }
    
    const tempNum = Number(modalTemp);
    if (!isNaN(tempNum) && tempNum > 50) {
      uError = 'Temperature is in °F. Please click unit toggle on the meter to switch to °C.';
    }
    
    return { uError, vError };
  };

  const autoConvertUnits = () => {
    const tempNum = Number(modalTemp);
    if (!isNaN(tempNum) && tempNum > 50) {
      const converted = ((tempNum - 32) * 5) / 9;
      setModalTemp(converted.toFixed(1));
    }
    
    const ecNum = Number(modalEc);
    if (!isNaN(ecNum) && ecNum > 10) {
      const converted = ecNum / 1000;
      setModalEc(converted.toFixed(2));
    }

    setOcrUnitError(null);
  };

  const confirmOcrValues = () => {
    const { uError, vError } = getDynamicErrors();
    if (uError) {
      alert('Cannot confirm with unit errors. Please switch the units and retake the photo.');
      return;
    }
    if (vError) {
      alert('Cannot confirm with validation errors. Please correct the out-of-bounds soil pH or retake the photo.');
      return;
    }
    
    if (modalPh !== '') {
      setSoilPh(Number(modalPh));
      setReadingSources(prev => ({ ...prev, soilPh: 'ocr_confirmed' }));
    }
    if (modalEc !== '') {
      setSoilEc(modalEc);
      setReadingSources(prev => ({ ...prev, soilEc: 'ocr_confirmed' }));
    }
    if (modalTemp !== '') {
      setTemperature(modalTemp);
      setReadingSources(prev => ({ ...prev, temperature: 'ocr_confirmed' }));
    }
    if (modalHumid !== '') {
      setHumidity(modalHumid);
      setReadingSources(prev => ({ ...prev, humidity: 'ocr_confirmed' }));
    }
    if (modalMoist !== '') {
      setMoisture(modalMoist);
      setReadingSources(prev => ({ ...prev, moisture: 'ocr_confirmed' }));
      
      const moistVal = Number(modalMoist);
      if (moistVal <= 2) setWateringStatus('Dry out');
      else if (moistVal <= 5) setWateringStatus('Partially dry');
      else if (moistVal <= 8) setWateringStatus('Keep moist');
      else setWateringStatus('High humidity');
    }
    if (modalLight !== '') {
      const lightVal = Number(modalLight);
      let level = 'bright_indirect';
      if (lightVal <= 1) level = 'low';
      else if (lightVal <= 3) level = 'medium';
      else if (lightVal <= 6) level = 'bright_indirect';
      else level = 'bright';
      
      setSunlightLevel(level);
      setReadingSources(prev => ({ ...prev, sunlightLevel: 'ocr_confirmed' }));
    }
    
    setOcrModalOpen(false);
  };

  useEffect(() => {
    if (!plantId) {
      alert('No plant specified for inspection.');
      router.push('/inspect');
      return;
    }

    const loadPlantDetails = async () => {
      let details = await getPlant(plantId);
      
      if (!details && navigator.onLine) {
        try {
          const { data, error } = await supabase
            .from('plants')
            .select('*')
            .eq('plant_id', plantId)
            .maybeSingle();
          if (!error && data) {
            details = { ...data, sync_status: 'synced' };
            await savePlantOffline(details);
          }
        } catch (e) {
          console.error('Failed to fetch individual plant from Supabase:', e);
        }
      }

      if (details) {
        setStaticDetails(details);
      } else {
        // Fallback placeholder if plant is not registered yet
        const parts = plantId.split('-');
        const zoneChar = parts[0]?.charAt(0) || 'A';
        const blockVal = parts[0]?.substring(1) || '01';
        const plantNo = parseInt(parts[1]?.substring(1) || '1');

        setStaticDetails({
          plant_id: plantId,
          zone: zoneChar,
          block: blockVal,
          plant_no: plantNo,
          common_name: 'Vanilla (Unregistered)',
          variety: 'Local',
          plant_type: 'Cutting'
        });
      }

      const prevH = await getPreviousHeight(plantId);
      setLastHeight(prevH);

      // Load carried fertilizer settings offline-first
      try {
        if (navigator.onLine) {
          try {
            const { data, error } = await supabase
              .from('carried_fertilizer')
              .select('*')
              .eq('id', 'default')
              .maybeSingle();
            if (!error && data) {
              await saveSetting('carried_fertilizer', {
                fertilizer_types: data.fertilizer_types || [],
                fertilizer_description: data.fertilizer_description || '',
                last_fertilized_date: data.last_fertilized_date || '',
                updated_at: data.updated_at,
                updated_by: data.updated_by || 'unknown'
              });
            }
          } catch (e) {
            console.error('Failed to pre-fetch carried fertilizer:', e);
          }
        }

        const carried = await getSetting('carried_fertilizer');
        if (carried) {
          setFertilizerType(carried.fertilizer_types || []);
          setFertilizerUsed(carried.fertilizer_description || '');
          setLastFertilized(carried.last_fertilized_date || '');
          setCarriedInfo(carried);
        }
      } catch (err) {
        console.error('Failed to load carried fertilizer:', err);
      }
    };

    loadPlantDetails();
  }, [plantId]);

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      setPhotoFile(file);
      setPhotoPreview(URL.createObjectURL(file));
    }
  };

  const handleFertilizerToggle = (type: string) => {
    if (isFixed) return;
    setFertilizerType(prev => 
      prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
    );
  };

  const handleToggleFixed = async () => {
    if (isFixed) {
      setIsFixed(false);
      setHasBeenUnlocked(true);
    } else {
      setIsFixed(true);

      // Commit to local cache and Supabase
      let supervisorEmail = 'supervisor@sapori.lk';
      if (typeof window !== 'undefined') {
        const profileStr = localStorage.getItem('google_user_profile');
        if (profileStr) {
          try {
            const profile = JSON.parse(profileStr);
            supervisorEmail = profile.email || 'supervisor@sapori.lk';
          } catch {}
        }
      }

      const carried = {
        fertilizer_types: fertilizerType,
        fertilizer_description: fertilizerUsed,
        last_fertilized_date: lastFertilized,
        updated_at: new Date().toISOString(),
        updated_by: supervisorEmail
      };

      await saveSetting('carried_fertilizer', carried);
      setCarriedInfo(carried);

      if (navigator.onLine) {
        try {
          await supabase
            .from('carried_fertilizer')
            .upsert({
              id: 'default',
              fertilizer_types: fertilizerType,
              fertilizer_description: fertilizerUsed,
              last_fertilized_date: lastFertilized,
              updated_at: carried.updated_at,
              updated_by: supervisorEmail
            });
        } catch (e) {
          console.error('Failed to sync carried fertilizer on lock:', e);
        }
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!plantId) return;
    setLoading(true);

    try {
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

      const inspectionData = {
        plant_id: plantId,
        watering_status: wateringStatus,
        sunlight_level: sunlightLevel,
        shade_level: shadeLevel,
        sunlight_lux: mapSunlightToLux(sunlightLevel),
        shade_percentage: mapShadeToPercentage(shadeLevel),
        soil_type: soilType,
        soil_ph: soilPh ? Number(soilPh) : null,
        soil_ec: soilEc ? Number(soilEc) : null,
        moisture: moisture ? Number(moisture) : null,
        temperature: temperature ? Number(temperature) : null,
        humidity: humidity ? Number(humidity) : null,
        fertilizer_type: fertilizerType,
        fertilizer_used: fertilizerUsed || null,
        last_fertilized: lastFertilized || null,
        vine_height_cm: vineHeight ? Number(vineHeight) : null,
        foliage_color: foliageColor,
        notes: notes || null,
        fertilizer_source: hasBeenUnlocked ? 'edited' : 'carried',
        reading_source: readingSources
      };

      // Save offline
      const inspectionId = await saveInspectionOfflineService(inspectionData, photoFile, meterPhotoFile);

      // Trigger background synchronization
      syncPendingSubmissions().catch(err => console.error('Sync failed:', err));

      router.push(`/inspect/success?id=${inspectionId}`);
    } catch (err: unknown) {
      console.error(err);
      alert('Failed to log inspection: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  const isStale = (() => {
    if (!carriedInfo || !carriedInfo.updated_at) return false;
    const diffTime = Math.abs(new Date().getTime() - new Date(carriedInfo.updated_at).getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays > 30;
  })();

  if (!staticDetails) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  const submitContent = loading ? (
    <>
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
      Logging Inspection...
    </>
  ) : (
    <>
      <Check className="h-4 w-4" />
      Submit Inspection Report
    </>
  );

  return (
    <div className="flex flex-col bg-surface min-h-screen pb-24 lg:min-h-0 lg:bg-transparent lg:pb-0">
      {/* Mobile header */}
      <div className="bg-primary text-white px-5 py-4 flex items-center gap-3 lg:hidden">
        <button onClick={() => router.push('/inspect')} className="hover:opacity-80">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-base font-extrabold">Log Inspection</h1>
          <p className="text-[10px] text-green-pale/80 font-medium">Dynamic periodic observation record</p>
        </div>
      </div>

      {/* Desktop header */}
      <header className="hidden lg:flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm mb-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => router.push('/inspect')}
            title="Back to plant selection"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <ClipboardCheck className="h-6 w-6 text-emerald-600" />
              <h1 className="text-xl font-bold text-slate-900">Log Inspection</h1>
            </div>
            <p className="mt-0.5 text-xs text-slate-500">Dynamic periodic observation record</p>
          </div>
        </div>
        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
          {staticDetails.plant_id}
        </span>
      </header>

      <form
        onSubmit={handleSubmit}
        className="p-5 space-y-6 flex-1 lg:grid lg:grid-cols-[300px_1fr] lg:items-start lg:gap-4 lg:space-y-0 lg:p-0"
      >
        {/* Left column: plant card (+ section links and submit on desktop) */}
        <aside className="space-y-4 lg:sticky lg:top-20">
        {/* static plant details card */}
        <div className="bg-white/80 border border-border-light rounded-2xl p-4 shadow-xs flex justify-between items-center">
          <div>
            <span className="text-[9px] font-bold text-primary px-2 py-0.5 rounded-full bg-pale-green">
              Active Plant ID
            </span>
            <h2 className="text-lg font-black text-text-primary mt-1">
              {staticDetails.slot_id ? `${staticDetails.slot_id} · G${staticDetails.generation || 1}` : staticDetails.plant_id}
            </h2>
            <p className="text-[10px] text-text-secondary mt-0.5">
              {staticDetails.common_name} ({staticDetails.variety}) • Zone {staticDetails.zone} • Block {staticDetails.block}
            </p>
            {staticDetails.slot_id && (
              <p className="text-[9px] text-text-secondary mt-0.5">
                Plant ID: {staticDetails.plant_id}
              </p>
            )}
          </div>
          <div className="text-right">
            <span className="text-[9px] font-bold text-text-secondary block">Last Height</span>
            <span className="text-xs font-black text-primary block mt-0.5">
              {lastHeight ? `${lastHeight} cm` : 'None logged'}
            </span>
          </div>
        </div>

          <nav className="hidden lg:block rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <p className="px-2 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Sections</p>
            {FORM_SECTIONS.map(({ id, label, icon: Icon }) => (
              <a
                key={id}
                href={`#${id}`}
                className="flex items-center gap-2 rounded-lg px-2 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 hover:text-emerald-800"
              >
                <Icon className="h-4 w-4 text-emerald-600" />
                {label}
              </a>
            ))}
          </nav>

          <button
            type="submit"
            disabled={loading}
            className="hidden lg:flex w-full bg-primary text-white py-3.5 rounded-full font-bold text-xs shadow-md hover:bg-primary/95 active:scale-95 items-center justify-center gap-1.5 disabled:opacity-50"
          >
            {submitContent}
          </button>
        </aside>

        {/* Right column: form sections */}
        <div className="space-y-6 lg:space-y-4">
        {/* SECTION 1: CARE */}
        <div id="care" className={SECTION_CLASS}>
          <h3 className="text-xs font-bold uppercase tracking-widest text-secondary flex items-center gap-1">
            <Droplet className="h-3.5 w-3.5 text-primary" />
            Care Information
          </h3>
          
          <div className="bg-white rounded-2xl p-4 border border-border-light space-y-4">
            <div>
              <label className="text-[10px] font-bold text-text-secondary uppercase block mb-1.5">Watering Status</label>
              <div className="grid grid-cols-2 gap-2">
                {['Keep moist', 'Partially dry', 'Dry out', 'High humidity'].map(w => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setWateringStatus(w)}
                    className={`py-2 rounded-xl text-xs font-bold border transition-all ${
                      wateringStatus === w
                        ? 'bg-primary text-white border-primary'
                        : 'bg-white text-text-secondary border-border-light hover:bg-surface'
                    }`}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[10px] font-bold text-text-secondary uppercase mb-1.5 flex items-center justify-between">
                <span>Sunlight Level</span>
                {readingSources.sunlightLevel !== 'manual' && (
                  <span className={`text-[8.5px] font-bold px-2 py-0.5 rounded-full ${
                    readingSources.sunlightLevel === 'ocr_confirmed' 
                      ? 'bg-green-100 text-green-700' 
                      : 'bg-amber-100 text-amber-700'
                  }`}>
                    {readingSources.sunlightLevel === 'ocr_confirmed' ? 'OCR Scan' : 'OCR (Edited)'}
                  </span>
                )}
              </label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { value: 'bright', name: 'Bright', bars: '7-9 bars', lux: '>20,000 lux' },
                  { value: 'bright_indirect', name: 'Bright indirect', bars: '4-6 bars', lux: '10,000-20,000 lux' },
                  { value: 'medium', name: 'Medium', bars: '2-3 bars', lux: '1,000-10,000 lux' },
                  { value: 'low', name: 'Low', bars: '0-1 bars', lux: '<1,000 lux' }
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => handleSunlightChange(opt.value)}
                    className={`py-3 px-2 rounded-xl text-center border transition-all duration-200 ${
                      sunlightLevel === opt.value
                        ? 'bg-primary text-white border-primary shadow-xs'
                        : 'bg-white text-text-secondary border-border-light hover:bg-surface hover:border-primary/20'
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
              <label className="text-[10px] font-bold text-text-secondary uppercase block mb-1.5">Shade Level</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { value: 'light', name: 'Light', range: '0-25%' },
                  { value: 'partial', name: 'Partial', range: '25-50%' },
                  { value: 'moderate', name: 'Moderate', range: '50-70%' },
                  { value: 'heavy', name: 'Heavy', range: '>70%' }
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setShadeLevel(opt.value)}
                    className={`py-3 px-2 rounded-xl text-center border transition-all duration-200 ${
                      shadeLevel === opt.value
                        ? 'bg-primary text-white border-primary shadow-xs'
                        : 'bg-white text-text-secondary border-border-light hover:bg-surface hover:border-primary/20'
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

        {/* SECTION 2: ENVIRONMENT */}
        <div id="environment" className={SECTION_CLASS}>
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-widest text-secondary flex items-center gap-1">
              <Thermometer className="h-3.5 w-3.5 text-primary" />
              Environment & Soil
            </h3>
            
            {/* Scan Meter Button */}
            <button
              type="button"
              onClick={startScanner}
              className="flex items-center gap-1.5 px-3 py-1 rounded-full border text-[11px] font-bold bg-primary text-white border-primary hover:bg-primary/95 shadow-xs transition-all"
            >
              <Camera className="h-3.5 w-3.5" />
              <span>Scan Meter</span>
            </button>
          </div>
          
          <div className="bg-white rounded-2xl p-4 border border-border-light space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase">Soil Type</label>
                <select
                  value={soilType}
                  onChange={(e) => setSoilType(e.target.value)}
                  className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary bg-surface"
                >
                  <option value="Acidic">Acidic</option>
                  <option value="Standard">Standard</option>
                  <option value="Cactus">Cactus</option>
                  <option value="Orchid">Orchid</option>
                </select>
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                  <span>Soil pH</span>
                  {readingSources.soilPh !== 'manual' && (
                    <span className={`text-[8.5px] font-bold px-1.5 py-0.2 rounded-full ${
                      readingSources.soilPh === 'ocr_confirmed' 
                        ? 'bg-green-100 text-green-700' 
                        : 'bg-amber-100 text-amber-700'
                    }`}>
                      {readingSources.soilPh === 'ocr_confirmed' ? 'OCR Scan' : 'OCR (Edited)'}
                    </span>
                  )}
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={soilPh}
                  onChange={(e) => handlePhChange(Number(e.target.value))}
                  className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                  <span>Soil EC (dS/m)</span>
                  {readingSources.soilEc !== 'manual' && (
                    <span className={`text-[8.5px] font-bold px-1.5 py-0.2 rounded-full ${
                      readingSources.soilEc === 'ocr_confirmed' 
                        ? 'bg-green-100 text-green-700' 
                        : 'bg-amber-100 text-amber-700'
                    }`}>
                      {readingSources.soilEc === 'ocr_confirmed' ? 'OCR Scan' : 'OCR (Edited)'}
                    </span>
                  )}
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={soilEc}
                  onChange={(e) => handleEcChange(e.target.value)}
                  placeholder="e.g. 1.2"
                  className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                  <span>Moisture (Gauge/%)</span>
                  {readingSources.moisture !== 'manual' && (
                    <span className={`text-[8.5px] font-bold px-1.5 py-0.2 rounded-full ${
                      readingSources.moisture === 'ocr_confirmed' 
                        ? 'bg-green-100 text-green-700' 
                        : 'bg-amber-100 text-amber-700'
                    }`}>
                      {readingSources.moisture === 'ocr_confirmed' ? 'OCR Scan' : 'OCR (Edited)'}
                    </span>
                  )}
                </label>
                <input
                  type="number"
                  value={moisture}
                  onChange={(e) => handleMoistureChange(e.target.value)}
                  placeholder="e.g. 7"
                  className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
                />
                <p className="text-[8px] text-text-secondary/70 mt-0.5">Note: OCR scans input a raw 0-10 relative gauge reading.</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                  <span>Temperature (°C)</span>
                  {readingSources.temperature !== 'manual' && (
                    <span className={`text-[8.5px] font-bold px-1.5 py-0.2 rounded-full ${
                      readingSources.temperature === 'ocr_confirmed' 
                        ? 'bg-green-100 text-green-700' 
                        : 'bg-amber-100 text-amber-700'
                    }`}>
                      {readingSources.temperature === 'ocr_confirmed' ? 'OCR Scan' : 'OCR (Edited)'}
                    </span>
                  )}
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => handleTempChange(e.target.value)}
                  placeholder="e.g. 28.5"
                  className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                  <span>Humidity (%)</span>
                  {readingSources.humidity !== 'manual' && (
                    <span className={`text-[8.5px] font-bold px-1.5 py-0.2 rounded-full ${
                      readingSources.humidity === 'ocr_confirmed' 
                        ? 'bg-green-100 text-green-700' 
                        : 'bg-amber-100 text-amber-700'
                    }`}>
                      {readingSources.humidity === 'ocr_confirmed' ? 'OCR Scan' : 'OCR (Edited)'}
                    </span>
                  )}
                </label>
                <input
                  type="number"
                  value={humidity}
                  onChange={(e) => handleHumidityChange(e.target.value)}
                  placeholder="e.g. 80"
                  className="w-full mt-1 border border-border-light rounded-lg p-2 text-xs font-semibold focus:outline-primary"
                />
              </div>
            </div>
          </div>
        </div>

        {/* SECTION 3: MEASUREMENTS & DISEASE */}
        <div id="measurements" className={SECTION_CLASS}>
          <h3 className="text-xs font-bold uppercase tracking-widest text-secondary flex items-center gap-1">
            <Ruler className="h-3.5 w-3.5 text-primary" />
            Measurements & Disease
          </h3>
          
          <div className="bg-white rounded-2xl p-4 border border-border-light space-y-4">
            <div>
              <label className="text-[10px] font-bold text-text-secondary uppercase">Vine Height (cm)</label>
              <input
                type="number"
                value={vineHeight}
                onChange={(e) => setVineHeight(e.target.value)}
                placeholder="e.g. 150"
                className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary"
                required
              />
            </div>

            <div>
              <label className="text-[10px] font-bold text-text-secondary uppercase block mb-2">Foliage Color</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'Green', bg: '#16A34A' },
                  { label: 'Yellow', bg: '#F59E0B' },
                  { label: 'Brown', bg: '#78350F' },
                  { label: 'Red', bg: '#EF4444' },
                  { label: 'Mixed', bg: 'linear-gradient(135deg, #16A34A 0%, #78350F 100%)', fullWidth: true }
                ].map(opt => {
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
          </div>
        </div>

        {/* SECTION 4: FERTILIZER & OBSERVATIONS */}
        <div id="fertilizer" className={SECTION_CLASS}>
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-widest text-secondary flex items-center gap-1">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              Fertilizer & Notes
            </h3>
            
            {/* Toggle Button */}
            <button
              type="button"
              onClick={handleToggleFixed}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full border text-[11px] font-bold transition-all shadow-xs ${
                isFixed
                  ? 'bg-pale-green border-primary/20 text-primary hover:bg-pale-green/80'
                  : 'bg-orange-50 border-orange-200 text-orange-600 hover:bg-orange-100'
              }`}
            >
              {isFixed ? (
                <>
                  <Lock className="h-3.5 w-3.5" />
                  <span>Fixed</span>
                </>
              ) : (
                <>
                  <Unlock className="h-3.5 w-3.5 animate-pulse" />
                  <span>Editing</span>
                </>
              )}
            </button>
          </div>
          
          <div className="bg-white rounded-2xl p-4 border border-border-light space-y-4">
            {isStale && (
              <div className="flex items-start gap-2.5 p-3 rounded-xl bg-orange-50 border border-orange-200/60 text-orange-700">
                <AlertCircle className="h-4 w-4 shrink-0 text-orange-500 mt-0.5" />
                <div className="space-y-0.5">
                  <p className="text-xs font-bold">Fertilizer settings stale</p>
                  <p className="text-[10px] leading-relaxed text-orange-600/90 font-medium">
                    These settings have not been verified/updated for over 30 days. Please click &apos;Editing&apos; to verify or update them.
                  </p>
                </div>
              </div>
            )}

            {/* Fertilizer inputs container (dimmed/disabled in Fixed state) */}
            <div 
              className={`space-y-4 transition-all duration-200 ${isFixed ? 'opacity-70 pointer-events-none' : ''}`}
              style={{ cursor: isFixed ? 'not-allowed' : 'auto' }}
            >
              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase block mb-1.5">Fertilizer Types Applied</label>
                <div className="grid grid-cols-2 gap-2">
                  {['All purpose', 'Cactus', 'Acidic', 'Orchid'].map(ft => {
                    const active = fertilizerType.includes(ft);
                    return (
                      <button
                        key={ft}
                        type="button"
                        onClick={() => handleFertilizerToggle(ft)}
                        disabled={isFixed}
                        className={`py-2 rounded-xl text-xs font-bold border transition-all ${
                          isFixed ? 'cursor-not-allowed' : ''
                        } ${
                          active
                            ? 'bg-primary text-white border-primary'
                            : 'bg-white text-text-secondary border-border-light hover:bg-surface'
                        }`}
                      >
                        {ft}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase">Fertilizer Used (Description)</label>
                <input
                  type="text"
                  value={fertilizerUsed}
                  onChange={(e) => setFertilizerUsed(e.target.value)}
                  disabled={isFixed}
                  placeholder="e.g. Compost tea, Organic fertilizer"
                  className={`w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary ${
                    isFixed ? 'cursor-not-allowed bg-gray-50 text-gray-400' : ''
                  }`}
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-text-secondary uppercase">Last Fertilized Date</label>
                <input
                  type="date"
                  value={lastFertilized}
                  onChange={(e) => setLastFertilized(e.target.value)}
                  disabled={isFixed}
                  className={`w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary ${
                    isFixed ? 'cursor-not-allowed bg-gray-50 text-gray-400' : ''
                  }`}
                />
              </div>
            </div>

            {/* Notes / Observations remains fully interactive */}
            <div>
              <label className="text-[10px] font-bold text-text-secondary uppercase">Notes / Observations</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Any special remarks or details regarding vine shape, pest infestation..."
                className="w-full mt-1 border border-border-light rounded-lg p-2.5 text-xs font-semibold focus:outline-primary placeholder:text-gray-300"
              />
            </div>
          </div>
        </div>

        {/* SECTION 5: PHOTO */}
        <div id="photo" className={SECTION_CLASS}>
          <h3 className="text-xs font-bold uppercase tracking-widest text-secondary flex items-center gap-1">
            <Camera className="h-3.5 w-3.5 text-primary" />
            Upload Photo
          </h3>
          
          <div className="bg-white rounded-2xl p-4 border border-border-light space-y-4">
            <div className="flex flex-col items-center gap-3">
              {photoPreview ? (
                <div className="relative w-full h-48 rounded-2xl overflow-hidden border border-border-light bg-black">
                  <img src={photoPreview} alt="Preview" className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => {
                      setPhotoFile(null);
                      setPhotoPreview(null);
                    }}
                    className="absolute top-2 right-2 bg-red-600 text-white rounded-full p-1.5 shadow-md hover:bg-red-700 text-[10px] font-bold"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <div className="w-full h-32 border-2 border-dashed border-border-light rounded-2xl flex flex-col items-center justify-center text-text-secondary">
                  <Camera className="h-8 w-8 opacity-45" />
                  <span className="text-[10px] mt-1.5">No photo selected</span>
                </div>
              )}

              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handlePhotoChange}
                className="w-full text-xs text-text-secondary file:mr-3 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-pale-green file:text-primary hover:file:bg-pale-green/80"
              />
            </div>
          </div>
        </div>

        </div>

        {/* Submit (mobile fixed bar) */}
        <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto p-4 bg-white border-t border-border-light z-30 lg:hidden">
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary text-white py-3.5 rounded-full font-bold text-xs shadow-md hover:bg-primary/95 active:scale-95 flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            {submitContent}
          </button>
        </div>
      </form>

      {/* OCR Scanner Modal */}
      {ocrModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl w-full max-w-md overflow-hidden border border-border-light shadow-2xl flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="p-4 border-b border-border-light flex justify-between items-center bg-pale-green/30">
              <div className="flex items-center gap-2">
                <Camera className="h-5 w-5 text-primary animate-pulse" />
                <h2 className="font-bold text-sm text-secondary uppercase tracking-wider text-left">Scan LCD Meter Display</h2>
              </div>
              <button
                type="button"
                onClick={() => setOcrModalOpen(false)}
                className="text-text-secondary hover:text-red-500 transition-all p-1"
              >
                <XCircle className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 overflow-y-auto flex-1 space-y-4">
              {isOcrAnalyzing ? (
                /* Analyzing State */
                <div className="flex flex-col items-center justify-center py-12 space-y-4">
                  <div className="relative h-16 w-16">
                    <div className="absolute inset-0 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
                    <RefreshCw className="absolute inset-0 m-auto h-6 w-6 text-primary animate-pulse" />
                  </div>
                  <div className="text-center space-y-1">
                    <p className="text-xs font-bold text-secondary uppercase tracking-wider">Analyzing LCD Display...</p>
                    <p className="text-[10px] text-text-secondary">On-device seven-segment OCR parser running</p>
                  </div>
                </div>
              ) : activeStep === 'capture' ? (
                /* Capture step: live camera with a frame showing where the meter's screen goes */
                <div className="space-y-4">
                  <div className="space-y-1.5 text-center">
                    <p className="text-xs font-bold text-secondary">Photograph the Meter Screen</p>
                    <p className="text-[10px] text-text-secondary leading-relaxed">
                      Line the green screen up with the frame, then capture.
                    </p>
                  </div>

                  {liveCameraError ? (
                    <div className="rounded-2xl border-2 border-dashed border-border-light bg-surface p-4 text-center space-y-2">
                      <div className="mx-auto w-24 rounded-md border-2 border-emerald-500 bg-emerald-100" style={{ aspectRatio: '300 / 380' }}>
                        <p className="pt-1 text-[8px] font-bold text-emerald-800">☀ LIGHT ▲</p>
                      </div>
                      <p className="text-[10px] text-text-secondary">
                        Live camera unavailable ({liveCameraError}). Use your phone camera below and keep the meter upright like
                        the picture above.
                      </p>
                    </div>
                  ) : (
                    <MeterCamera onCapture={scanMeterFile} onUnavailable={handleLiveCameraUnavailable} />
                  )}

                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-2.5 text-left text-emerald-800 text-[10px] space-y-1">
                    <p className="font-bold">How to position the meter</p>
                    <ol className="list-decimal pl-3.5 space-y-0.5 font-semibold text-emerald-700/90">
                      <li>Press ⏻ so the green backlight is on.</li>
                      <li>Hold the meter upright: ☀ LIGHT at the top, ⏻ / CAL buttons at the bottom.</li>
                      <li>Hold the phone flat over the screen, about 15–25 cm away, so the whole green screen fills the frame.</li>
                      <li>Avoid glare: shade the screen from direct sun and from reflections.</li>
                      <li>Hold still and let the camera focus before capturing.</li>
                    </ol>
                  </div>
                  <p className="text-[10px] text-text-secondary text-center">
                    Anything the scan can&apos;t read clearly is left blank for you to fill in. Implausible readings (pH outside
                    3.5–9.0) are rejected.
                  </p>

                  {/* Fallback: phone camera app or gallery */}
                  <div>
                    <input
                      id="ocr-file-upload"
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={handleOcrFileSelect}
                      className="hidden"
                    />
                    <label
                      htmlFor="ocr-file-upload"
                      className={`w-full py-3 rounded-full font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer text-center transition-all active:scale-95 ${
                        liveCameraError
                          ? 'bg-primary text-white shadow-md hover:bg-primary/95'
                          : 'border border-border-light text-text-secondary hover:bg-surface'
                      }`}
                    >
                      <Camera className="h-4 w-4" />
                      {liveCameraError ? 'Take Meter Photo' : 'Use Phone Camera / Gallery Instead'}
                    </label>
                  </div>
                </div>
              ) : (
                /* Confirm Step */
                <div className="space-y-4">
                  {/* Dynamic Rejection / Verification Warnings */}
                  {(() => {
                    const { uError, vError } = getDynamicErrors();
                    const isAllFailed = modalPh === '' && modalEc === '' && modalTemp === '' && modalHumid === '';
                    const isPartialRead = modalPh === '' || modalEc === '' || modalTemp === '' || modalHumid === '';
                    if (!ocrScreenFound) {
                      return (
                        <div className="flex items-start gap-2.5 p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-left">
                          <AlertCircle className="h-4 w-4 shrink-0 text-red-500 mt-0.5" />
                          <div className="space-y-0.5">
                            <p className="text-xs font-bold">Meter Screen Not Readable</p>
                            <p className="text-[10px] leading-relaxed text-red-600/90">{ocrMessage}</p>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <>
                        {uError && (
                          <div className="flex flex-col gap-2 p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-left">
                            <div className="flex items-start gap-2.5">
                              <AlertTriangle className="h-4 w-4 shrink-0 text-red-500 mt-0.5" />
                              <div className="space-y-0.5">
                                <p className="text-xs font-bold">Incorrect Units Detected</p>
                                <p className="text-[10px] leading-relaxed text-red-600/90 font-semibold">{uError}</p>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={autoConvertUnits}
                              className="mt-1 self-start px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded-lg text-[10px] font-bold shadow-xs transition-all"
                            >
                              Auto-Convert to Metric (°C / mS/cm)
                            </button>
                          </div>
                        )}
                        {!uError && vError && (
                          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-orange-50 border border-orange-200 text-orange-700 text-left">
                            <AlertCircle className="h-4 w-4 shrink-0 text-orange-500 mt-0.5" />
                            <div className="space-y-0.5">
                              <p className="text-xs font-bold">Impossible Reading Rejected</p>
                              <p className="text-[10px] leading-relaxed text-orange-600/90 font-semibold">{vError}</p>
                            </div>
                          </div>
                        )}
                        {!uError && !vError && isAllFailed && (
                          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-left">
                            <AlertCircle className="h-4 w-4 shrink-0 text-red-500 mt-0.5" />
                            <div className="space-y-0.5">
                              <p className="text-xs font-bold">LCD Display Read Failed</p>
                              <p className="text-[10px] leading-relaxed text-red-600/90">Could not confidently parse any digit fields. Please verify and manually input values or retake the photo.</p>
                            </div>
                          </div>
                        )}
                        {!uError && !vError && !isAllFailed && isPartialRead && (
                          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-orange-50 border border-orange-200 text-orange-700 text-left">
                            <AlertCircle className="h-4 w-4 shrink-0 text-orange-500 mt-0.5" />
                            <div className="space-y-0.5">
                              <p className="text-xs font-bold">LCD Display Partial Read</p>
                              <p className="text-[10px] leading-relaxed text-orange-600/90">Some digits were unreadable and left blank. Please review the highlighted fields and fill them in manually.</p>
                            </div>
                          </div>
                        )}
                        {!uError && !vError && !isAllFailed && !isPartialRead && (
                          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-green-50 border border-green-200 text-green-700 text-left">
                            <Check className="h-4 w-4 shrink-0 text-green-500 mt-0.5" />
                            <div className="space-y-0.5">
                              <p className="text-xs font-bold">LCD Display Read Success</p>
                              <p className="text-[10px] leading-relaxed text-green-600/90">Please verify the detected digital readings before filling the form.</p>
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}

                  {/* Photo and what the reader detected on the corrected screen */}
                  <div className="grid grid-cols-2 gap-3.5">
                    <div className="space-y-1">
                      <p className="text-[9px] font-bold text-text-secondary uppercase text-center">Your Photo</p>
                      <div className="border border-border-light rounded-xl h-44 overflow-hidden bg-black flex items-center justify-center">
                        {ocrPreviewUrl ? (
                          <img src={ocrPreviewUrl} alt="Meter photo" className="max-w-full max-h-full object-contain" />
                        ) : (
                          <Camera className="h-6 w-6 text-white/55" />
                        )}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[9px] font-bold text-text-secondary uppercase text-center">Detected On Screen</p>
                      <div className="border border-border-light rounded-xl h-44 overflow-hidden bg-black flex items-center justify-center">
                        {ocrOverlayUrl ? (
                          <img src={ocrOverlayUrl} alt="Detected readings" className="max-w-full max-h-full object-contain" />
                        ) : (
                          <div className="text-[9px] text-white/60 px-2 text-center">Screen not found</div>
                        )}
                      </div>
                    </div>
                  </div>
                  {ocrOverlayUrl && (
                    <p className="text-[9px] text-text-secondary text-center -mt-2">
                      Blue = read clearly · Amber = check this value · Red = could not read
                    </p>
                  )}

                  {/* Readings Input list */}
                  <div className="space-y-3 pt-2 text-left">
                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                          <span>Soil pH</span>
                          {modalPh === '' && <span className="text-[7.5px] font-bold px-1 bg-red-100 text-red-700 rounded-sm">Unclear</span>}
                          {modalPh !== '' && ocrConfident && !ocrConfident.ph && (
                            <span className="text-[7.5px] font-bold px-1 bg-amber-100 text-amber-800 rounded-sm">Check</span>
                          )}
                        </label>
                        <input
                          type="number"
                          step="0.1"
                          value={modalPh}
                          onChange={(e) => setModalPh(e.target.value)}
                          className={`w-full mt-1 border rounded-lg p-2 text-xs font-semibold focus:outline-primary ${
                            modalPh === '' ? 'border-red-300 bg-red-50/50' : 'border-border-light'
                          }`}
                          placeholder="Unreadable"
                        />
                      </div>

                      <div>
                        <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                          <span>Soil EC (mS/cm)</span>
                          {modalEc === '' && <span className="text-[7.5px] font-bold px-1 bg-red-100 text-red-700 rounded-sm">Unclear</span>}
                          {modalEc !== '' && ocrConfident && !ocrConfident.ec && (
                            <span className="text-[7.5px] font-bold px-1 bg-amber-100 text-amber-800 rounded-sm">Check</span>
                          )}
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          value={modalEc}
                          onChange={(e) => setModalEc(e.target.value)}
                          className={`w-full mt-1 border rounded-lg p-2 text-xs font-semibold focus:outline-primary ${
                            modalEc === '' ? 'border-red-300 bg-red-50/50' : 'border-border-light'
                          }`}
                          placeholder="Unreadable"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                          <span>Temp (°C)</span>
                          {modalTemp === '' && <span className="text-[7.5px] font-bold px-1 bg-red-100 text-red-700 rounded-sm">Unclear</span>}
                          {modalTemp !== '' && ocrConfident && !ocrConfident.temperature && (
                            <span className="text-[7.5px] font-bold px-1 bg-amber-100 text-amber-800 rounded-sm">Check</span>
                          )}
                        </label>
                        <input
                          type="number"
                          step="0.1"
                          value={modalTemp}
                          onChange={(e) => setModalTemp(e.target.value)}
                          className={`w-full mt-1 border rounded-lg p-2 text-xs font-semibold focus:outline-primary ${
                            modalTemp === '' ? 'border-red-300 bg-red-50/50' : 'border-border-light'
                          }`}
                          placeholder="Unreadable"
                        />
                      </div>

                      <div>
                        <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                          <span>Humidity (%)</span>
                          {modalHumid === '' && <span className="text-[7.5px] font-bold px-1 bg-red-100 text-red-700 rounded-sm">Unclear</span>}
                          {modalHumid !== '' && ocrConfident && !ocrConfident.humidity && (
                            <span className="text-[7.5px] font-bold px-1 bg-amber-100 text-amber-800 rounded-sm">Check</span>
                          )}
                        </label>
                        <input
                          type="number"
                          value={modalHumid}
                          onChange={(e) => setModalHumid(e.target.value)}
                          className={`w-full mt-1 border rounded-lg p-2 text-xs font-semibold focus:outline-primary ${
                            modalHumid === '' ? 'border-red-300 bg-red-50/50' : 'border-border-light'
                          }`}
                          placeholder="Unreadable"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                          <span>Light (Bars)</span>
                          {modalLight === '' && <span className="text-[7.5px] font-bold px-1 bg-red-100 text-red-700 rounded-sm">Unclear</span>}
                        </label>
                        <input
                          type="number"
                          value={modalLight}
                          onChange={(e) => setModalLight(e.target.value)}
                          className={`w-full mt-1 border rounded-lg p-2 text-xs font-semibold focus:outline-primary ${
                            modalLight === '' ? 'border-red-300 bg-red-50/50' : 'border-border-light'
                          }`}
                          placeholder="Unreadable"
                        />
                      </div>

                      <div>
                        <label className="text-[10px] font-bold text-text-secondary uppercase flex items-center justify-between">
                          <span>Moist (Gauge)</span>
                          {modalMoist === '' && <span className="text-[7.5px] font-bold px-1 bg-red-100 text-red-700 rounded-sm">Unclear</span>}
                        </label>
                        <input
                          type="number"
                          value={modalMoist}
                          onChange={(e) => setModalMoist(e.target.value)}
                          className={`w-full mt-1 border rounded-lg p-2 text-xs font-semibold focus:outline-primary ${
                            modalMoist === '' ? 'border-red-300 bg-red-50/50' : 'border-border-light'
                          }`}
                          placeholder="Unreadable"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Actions for Confirm */}
                  <div className="grid grid-cols-2 gap-3 pt-3">
                    <button
                      type="button"
                      onClick={() => setActiveStep('capture')}
                      className="bg-white text-text-secondary border border-border-light py-3 rounded-full font-bold text-xs hover:bg-surface active:scale-95 transition-all"
                    >
                      Retake / Back
                    </button>
                    
                    <button
                      type="button"
                      onClick={confirmOcrValues}
                      disabled={!!getDynamicErrors().uError || (!!getDynamicErrors().vError && Number(modalPh) === 0.0)}
                      className="bg-primary text-white py-3 rounded-full font-bold text-xs shadow-md hover:bg-primary/95 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 transition-all"
                    >
                      <Check className="h-4 w-4" />
                      Confirm & Fill
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
